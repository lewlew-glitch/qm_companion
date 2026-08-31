// Mobile device validation, refresh rotation, reuse revocation, and owner controls.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

import { mobileSealKey } from './keys.js';
import { MOBILE_STATE_FILE, loadMobileState, updateMobileState } from './store.js';
import { digestEquals, digestToken, mintToken, parseToken } from './token-family.js';
import { hasScope } from './scopes.js';
import { MAX_DEVICE_NAME } from './schema.js';
import { ACCESS_TTL_MS, REFRESH_IDLE_MS, fail, now } from './enrolment-registry.js';

export const LOOKBACK_WINDOW_MS = 5 * 60 * 1000;
const ROTATION_ID_RE = /^[A-Za-z0-9_-]{22}$/;

function sealRetry(plain, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mobileSealKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body.toString('hex')}`;
}

function openRetry(sealed, aad) {
  try {
    const [iv, tag, body] = sealed.split(':');
    const decipher = createDecipheriv('aes-256-gcm', mobileSealKey, Buffer.from(iv, 'hex'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function retryAad(state, device, rotationRequestId) {
  return `${state.mobileInstallationId}:${device.deviceId}:${rotationRequestId}`;
}

function familyExpired(device, at) {
  return at >= device.refreshAbsoluteDeadlineAt || at >= device.refreshIdleDeadlineAt;
}

// Validate every grant against the certificate leaf declared by the listener.
let liveLeafFingerprint = null;

/** Record the certificate leaf served by this process. */
export function bindDeviceTlsLeaf(fingerprint) {
  liveLeafFingerprint = typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : null;
}

/** Reset the process certificate leaf for tests. */
export function resetDeviceTlsLeafForTest() {
  liveLeafFingerprint = null;
  originCutAt = 0;
}

// Refuse families older than the process's monotonic advertised-origin cut.
let originCutAt = 0;

/** Record the approved origin cutoff for this process. */
export function bindDeviceOriginCut(boundAt) {
  const at = Number.isSafeInteger(boundAt) && boundAt > 0 ? boundAt : 0;
  if (at > originCutAt) originCutAt = at;
}

/** Reject grants bound to another certificate leaf. */
function leafRefusal(device) {
  if (liveLeafFingerprint === null || digestEquals(device.tlsLeafFingerprint, liveLeafFingerprint)) return null;
  return fail('repair_required', 'This device was paired against a server certificate that has since been replaced, so its access ended with that certificate. Pair the device again from the Devices page.', 401);
}

/** Reject grants older than the advertised-origin cutoff. */
function originRefusal(device) {
  if (originCutAt === 0 || device.createdAt >= originCutAt) return null;
  return fail('repair_required', 'This device was paired to a different address for this server, and that address has since changed, so its access ended with it. Pair the device again from the Devices page.', 401);
}

/** Validate a grant's certificate and origin bindings on every request. */
function bindingRefusal(device) {
  return leafRefusal(device) || originRefusal(device);
}

/** Revoke every device family in one transaction after certificate replacement. */
export function revokeAllDevices() {
  const at = now();
  let revoked = 0;
  let total = 0;
  try {
    if (!existsSync(MOBILE_STATE_FILE)) return { ok: true, revoked: 0, total: 0 };
    updateMobileState((s) => {
      total = s.devices.length;
      revoked = 0;
      for (const d of s.devices) {
        if (d.revokedAt === null) {
          revokeInPlace(d, at, 'owner');
          revoked += 1;
        }
      }
    });
  } catch (error) {
    return { ok: false, reason: error?.code || error?.message || 'the mobile state could not be written' };
  }
  return { ok: true, revoked, total };
}

/** Validate a device token and optional Observer scope. */
export function authenticateAccess(bearer, neededScope) {
  const at = now();
  const match = typeof bearer === 'string' ? /^Bearer (qmd_[A-Za-z0-9_-]{43})$/.exec(bearer) : null;
  const parsed = match ? parseToken(match[1]) : null;
  if (!parsed || parsed.family !== 'qmd') return fail('unauthorized', 'A device access token is required.', 401);
  const digest = digestToken('qmd', parsed.bytes);
  const state = loadMobileState();
  let device = null;
  for (const candidate of state.devices) if (digestEquals(candidate.accessTokenDigest, digest)) device = candidate;
  if (!device) return fail('unauthorized', 'That device access token is not valid.', 401);
  // Return a stable revocation response.
  if (device.revokedAt !== null) return fail('revoked', 'This device was revoked. Pair it again.', 401);
  // Certificate and origin bindings take precedence over token refresh advice.
  const stale = bindingRefusal(device);
  if (stale) return stale;
  if (at >= device.accessTokenExpiresAt) return fail('token_expired', 'The access token has expired; refresh it.', 401);
  if (familyExpired(device, at)) return fail('repair_required', 'This device must be paired again.', 401);
  if (neededScope !== null && !hasScope(device.scopes, neededScope)) return fail('forbidden', 'This device does not hold that scope.', 403);
  return { ok: true, device: { deviceId: device.deviceId, deviceName: device.deviceName, scopes: device.scopes } };
}

function rotationResponse(device, accessToken, refreshGrant) {
  return {
    v: 1,
    accessToken,
    accessTokenExpiresAt: device.accessTokenExpiresAt,
    refreshGrant,
    refreshAbsoluteDeadlineAt: device.refreshAbsoluteDeadlineAt,
    refreshIdleDeadlineAt: device.refreshIdleDeadlineAt,
    tokenFamilyGeneration: device.tokenFamilyGeneration,
  };
}

function revokeInPlace(device, at, reason) {
  device.revokedAt = at;
  device.revokedReason = reason;
  device.lookback = null;
}

/** Refresh: qmd is rejected here by family; qmr is accepted only here. */
export function refreshTokens(refreshGrant, rotationRequestId) {
  const at = now();
  const parsed = parseToken(refreshGrant);
  if (!parsed || parsed.family !== 'qmr') return fail('unauthorized', 'A refresh grant is required.', 401);
  if (typeof rotationRequestId !== 'string' || !ROTATION_ID_RE.test(rotationRequestId) || Buffer.from(rotationRequestId, 'base64url').toString('base64url') !== rotationRequestId) {
    return fail('invalid_request', 'rotationRequestId must be 16 random bytes, base64url.', 400);
  }
  const digest = digestToken('qmr', parsed.bytes);
  const state = loadMobileState();
  let current = null;
  let lookback = null;
  for (const device of state.devices) {
    if (digestEquals(device.refreshDigest, digest)) current = device;
    if (device.lookback && digestEquals(device.lookback.previousRefreshDigest, digest)) lookback = device;
  }
  if (lookback) {
    const lb = lookback.lookback;
    // Recheck family state before replaying a cached successor.
    if (lookback.revokedAt !== null) return fail('revoked', 'This device was revoked. Pair it again.', 401);
    if (familyExpired(lookback, at)) {
      updateMobileState((s) => {
        const d = s.devices.find((x) => x.deviceId === lookback.deviceId);
        if (d && d.revokedAt === null) revokeInPlace(d, at, 'expired');
      });
      return fail('repair_required', 'This device must be paired again.', 401);
    }
    const stale = bindingRefusal(lookback);
    if (stale) return stale;
    // Replay one successor only for the same request ID.
    if (lb.rotationRequestId === rotationRequestId) {
      const plain = openRetry(lb.sealedResponse, retryAad(state, lookback, rotationRequestId));
      if (plain) return { ok: true, body: JSON.parse(plain) };
    }
    // Revoke on refresh-grant reuse or unreadable retry state.
    updateMobileState((s) => {
      const d = s.devices.find((x) => x.deviceId === lookback.deviceId);
      if (d && d.revokedAt === null) revokeInPlace(d, at, 'reuse');
    });
    return fail('revoked', 'This device was revoked after a refresh grant was reused. Pair it again.', 401);
  }
  if (!current) return fail('unauthorized', 'That refresh grant is not valid.', 401);
  if (current.revokedAt !== null) return fail('revoked', 'This device was revoked. Pair it again.', 401);
  if (familyExpired(current, at)) {
    updateMobileState((s) => {
      const d = s.devices.find((x) => x.deviceId === current.deviceId);
      if (d && d.revokedAt === null) revokeInPlace(d, at, 'expired');
    });
    return fail('repair_required', 'This device must be paired again.', 401);
  }
  const staleBinding = bindingRefusal(current);
  if (staleBinding) return staleBinding;
  const accessToken = mintToken('qmd');
  const nextRefresh = mintToken('qmr');
  let body = null;
  updateMobileState((s) => {
    const d = s.devices.find((x) => x.deviceId === current.deviceId);
    if (!d) throw new Error('device vanished');
    d.lookback = null; // the prior qmr's first use ends any older lookback
    const previousRefreshDigest = d.refreshDigest;
    d.accessTokenDigest = digestToken('qmd', parseToken(accessToken).bytes);
    d.accessTokenExpiresAt = at + ACCESS_TTL_MS;
    d.refreshDigest = digestToken('qmr', parseToken(nextRefresh).bytes);
    d.refreshIdleDeadlineAt = Math.min(at + REFRESH_IDLE_MS, d.refreshAbsoluteDeadlineAt);
    d.tokenFamilyGeneration += 1;
    d.lastSeenAt = at;
    body = rotationResponse(d, accessToken, nextRefresh);
    d.lookback = {
      previousRefreshDigest,
      rotationRequestId,
      expiresAt: at + LOOKBACK_WINDOW_MS,
      sealedResponse: sealRetry(JSON.stringify(body), retryAad(s, d, rotationRequestId)),
    };
  });
  return { ok: true, body };
}

export function listDevices() {
  const at = now();
  return loadMobileState().devices.map((d) => ({
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    scopes: d.scopes,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    tokenFamilyGeneration: d.tokenFamilyGeneration,
    refreshAbsoluteDeadlineAt: d.refreshAbsoluteDeadlineAt,
    refreshIdleDeadlineAt: d.refreshIdleDeadlineAt,
    status: d.revokedAt !== null ? `revoked (${d.revokedReason})` : familyExpired(d, at) ? 'expired' : 'active',
  }));
}

export function revokeDevice(deviceId) {
  const at = now();
  let found = false;
  updateMobileState((s) => {
    const d = s.devices.find((x) => x.deviceId === deviceId);
    if (!d) return;
    found = true;
    if (d.revokedAt === null) revokeInPlace(d, at, 'owner');
  });
  return found ? { ok: true } : fail('not_found', 'No such device.', 404);
}

export function renameDevice(deviceId, name) {
  const deviceName = String(name ?? '').normalize('NFC').trim();
  if (deviceName.length === 0 || deviceName.length > MAX_DEVICE_NAME) return fail('invalid_request', `Name must be 1 to ${MAX_DEVICE_NAME} characters.`, 400);
  let found = false;
  updateMobileState((s) => {
    const d = s.devices.find((x) => x.deviceId === deviceId);
    if (!d) return;
    found = true;
    d.deviceName = deviceName;
  });
  return found ? { ok: true } : fail('not_found', 'No such device.', 404);
}

/** Remove expired revoked-device records. */
export function forgetDevice(deviceId) {
  let outcome = fail('not_found', 'No such device.', 404);
  updateMobileState((s) => {
    const d = s.devices.find((x) => x.deviceId === deviceId);
    if (!d) return;
    if (d.revokedAt === null) { outcome = fail('still_active', 'Revoke the device before forgetting it.', 409); return; }
    s.devices = s.devices.filter((x) => x.deviceId !== deviceId);
    outcome = { ok: true };
  });
  return outcome;
}
