// Pairing capabilities are stored as digests and grants as sealed envelopes.

import { createHash, randomBytes } from 'node:crypto';

import { loadMobileState, updateMobileState } from './store.js';
import { digestEquals, digestToken, mintToken, parseToken } from './token-family.js';
import { openPrivateKey } from './identity.js';
import {
  ACCESS_TTL_MS, ACK_RECOVERY_MS, REFRESH_ABSOLUTE_MS, REFRESH_IDLE_MS, TERMINAL, enrolments, fail, now,
  pruneSpent, sweep,
} from './enrolment-registry.js';
import {
  buildGrant, buildTranscript, deriveSas, grantBytes, sealGrant, sealedPlaintext, signGrant,
  signTranscript, transcriptBytes, transcriptHash,
} from './protocol.js';

function handleOf(publicKeyB64url) {
  return createHash('sha256').update(Buffer.from(publicKeyB64url, 'base64url')).digest('hex');
}

function findByCapability(token) {
  const parsed = parseToken(token);
  if (!parsed || (parsed.family !== 'qmp' && parsed.family !== 'qme')) return null;
  const digest = digestToken(parsed.family, parsed.bytes);
  let found = null;
  for (const rec of enrolments.values()) {
    // Constant-time per record; iterate every record so timing does not reveal position.
    if (digestEquals(rec.capability.digest, digest) && rec.capability.family === parsed.family) found = rec;
  }
  return found ? { rec: found, digest, family: parsed.family } : null;
}

function sameClaim(rec, claim) {
  return rec.claim
    && rec.claim.claimEncryptionPublicKey === claim.claimEncryptionPublicKey
    && rec.claim.clientNonce === claim.clientNonce;
}

function claimResponse(rec) {
  return {
    v: 1,
    enrolmentId: rec.enrolmentId,
    state: 'awaiting_owner_approval',
    transcript: rec.transcriptBytes.toString('base64url'),
    transcriptSignature: rec.transcriptSignature.toString('base64url'),
    expiresAt: rec.expiresAt,
  };
}

/** Atomically bind the first valid claim and consume its capability. */
export function claimEnrolment(server, claim) {
  const at = now();
  sweep(at);
  const hit = findByCapability(claim.pairingKey);
  if (!hit) {
    // Spent capabilities persist across process restarts.
    const parsed = parseToken(claim.pairingKey);
    if (parsed && (parsed.family === 'qmp' || parsed.family === 'qme')) {
      const digest = digestToken(parsed.family, parsed.bytes);
      if (loadMobileState().spentCapabilities.some((e) => digestEquals(e.digest, digest))) return fail('already_claimed', 'That pairing key has already been used.', 409);
    }
    return fail('invalid_pairing_key', 'That pairing key is not valid.', 401);
  }
  const { rec } = hit;
  if (rec.state === 'awaiting_owner_approval' && sameClaim(rec, claim)) return { ok: true, body: claimResponse(rec) };
  if (rec.state !== 'created') return fail('already_claimed', 'That pairing key has already been used.', 409);
  const state = loadMobileState();
  let transcript;
  try {
    transcript = buildTranscript(
      {
        origin: server.origin,
        mobileInstallationId: state.mobileInstallationId,
        legacyInstallationId: state.legacyInstallationId,
        serverSigningPublicKey: state.identity.publicKey,
        serverSigningFingerprint: state.identity.fingerprint,
        tlsLeafFingerprint: server.tlsLeafFingerprint,
      },
      {
        enrolmentId: rec.enrolmentId,
        claimEncryptionPublicKey: claim.claimEncryptionPublicKey,
        clientNonce: claim.clientNonce,
        requestedScopes: claim.requestedScopes,
        deviceName: claim.deviceName,
        expiresAt: rec.expiresAt,
      },
    );
  } catch (error) {
    return fail('invalid_claim', error.message, 400);
  }
  // Reject candidate binding mismatches before transcript construction.
  if (claim.candidateOrigin !== undefined && claim.candidateOrigin !== transcript.origin) return fail('origin_mismatch', 'The address you connected to is not this server\'s advertised origin.', 409);
  if (claim.candidateFingerprint !== undefined && claim.candidateFingerprint !== transcript.serverSigningFingerprint) return fail('identity_mismatch', 'The server identity does not match.', 409);
  const key = openPrivateKey(state.identity.sealedPrivateKey, state.mobileInstallationId);
  if (!key) return fail('unavailable', 'The server identity is unavailable.', 503);
  const bytes = transcriptBytes(transcript);
  const hash = transcriptHash(bytes);
  const keyHandle = handleOf(claim.claimEncryptionPublicKey);
  try {
    updateMobileState((s) => {
      if (!pruneSpent(s, at)) throw new Error('spent records full');
      s.spentCapabilities.push({
        digest: hit.digest,
        enrolmentId: rec.enrolmentId,
        expiresAt: rec.expiresAt,
        family: hit.family,
        claimEncryptionKeyHandle: keyHandle,
        transcriptHash: hash.toString('hex'),
      });
    });
  } catch {
    rec.state = 'cancelled';
    return fail('unavailable', 'Pairing could not be recorded; ask the owner for a new pairing key.', 503);
  }
  Object.assign(rec, {
    state: 'awaiting_owner_approval',
    claimedAt: at,
    claim: { claimEncryptionPublicKey: claim.claimEncryptionPublicKey, clientNonce: claim.clientNonce },
    claimEncryptionKeyHandle: keyHandle,
    transcript,
    transcriptBytes: bytes,
    transcriptHash: hash,
    transcriptSignature: signTranscript(key, bytes),
    sas: deriveSas(hash),
  });
  return { ok: true, body: claimResponse(rec) };
}

/** Approve synchronously, then HPKE-seal the signed grant to the claim key. */
export async function approveEnrolment(enrolmentId) {
  sweep();
  const rec = enrolments.get(enrolmentId);
  if (!rec || rec.state !== 'awaiting_owner_approval') return fail('not_pending', 'That pairing is not awaiting approval.', 409);
  rec.state = 'approved';
  const state = loadMobileState();
  const key = openPrivateKey(state.identity.sealedPrivateKey, state.mobileInstallationId);
  if (!key) { rec.state = 'cancelled'; return fail('unavailable', 'The server identity is unavailable.', 503); }
  const at = now();
  const accessToken = mintToken('qmd');
  const refreshGrant = mintToken('qmr');
  const ackSecret = randomBytes(32).toString('base64url');
  const deviceId = randomBytes(16).toString('base64url');
  const grant = buildGrant({
    mobileInstallationId: state.mobileInstallationId,
    legacyInstallationId: state.legacyInstallationId,
    deviceId,
    accessToken,
    accessTokenExpiresAt: at + ACCESS_TTL_MS,
    refreshGrant,
    refreshAbsoluteDeadlineAt: at + REFRESH_ABSOLUTE_MS,
    refreshIdleDeadlineAt: at + REFRESH_IDLE_MS,
    tokenFamilyGeneration: 1,
    scopes: rec.transcript.requestedScopes,
    ackSecret,
    transcriptHash: rec.transcriptHash.toString('hex'),
  });
  const plaintext = sealedPlaintext(grant, signGrant(key, grantBytes(grant)));
  let envelope;
  try {
    envelope = await sealGrant(Buffer.from(rec.claim.claimEncryptionPublicKey, 'base64url'), plaintext, rec.transcriptHash);
  } catch {
    rec.state = 'cancelled';
    return fail('unavailable', 'The grant could not be sealed.', 503);
  }
  if (rec.state !== 'approved') return fail('not_pending', 'That pairing ended before its grant was ready.', 409);
  Object.assign(rec, {
    state: 'grant_ready',
    envelope,
    device: {
      deviceId,
      deviceName: rec.transcript.deviceName,
      scopes: rec.transcript.requestedScopes,
      accessTokenDigest: digestToken('qmd', parseToken(accessToken).bytes),
      accessTokenExpiresAt: grant.accessTokenExpiresAt,
      refreshDigest: digestToken('qmr', parseToken(refreshGrant).bytes),
      refreshAbsoluteDeadlineAt: grant.refreshAbsoluteDeadlineAt,
      refreshIdleDeadlineAt: grant.refreshIdleDeadlineAt,
      ackSecretDigest: createHash('sha256').update(Buffer.from(ackSecret, 'base64url')).digest('hex'),
    },
  });
  return { ok: true, deviceId };
}

/** Return the sealed grant idempotently after approval. */
export function retrieveGrant(enrolmentId) {
  sweep();
  const rec = enrolments.get(enrolmentId);
  if (!rec || (rec.state !== 'grant_ready' && rec.state !== 'delivered')) return fail('not_ready', 'No grant is available for that pairing.', 409);
  rec.state = 'delivered';
  return { ok: true, body: { v: 1, enrolmentId, state: 'delivered', envelope: rec.envelope } };
}

export function enrolmentStatus(enrolmentId) {
  sweep();
  const rec = enrolments.get(enrolmentId);
  // Use one response shape for unknown and expired enrolments.
  if (!rec) return { v: 1, state: 'expired', expiresAt: null };
  return { v: 1, state: rec.state, expiresAt: TERMINAL.includes(rec.state) ? null : rec.expiresAt };
}

/** Persist activation and acknowledgement recovery state atomically. */
export function acknowledgeEnrolment(enrolmentId, ackSecret, tlsLeafFingerprint) {
  const at = now();
  sweep(at);
  const raw = typeof ackSecret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(ackSecret) ? Buffer.from(ackSecret, 'base64url') : null;
  if (!raw || raw.length !== 32 || raw.toString('base64url') !== ackSecret) return fail('invalid_acknowledgement', 'That acknowledgement is not valid.', 401);
  const digest = createHash('sha256').update(raw).digest('hex');
  const state = loadMobileState();
  const active = state.devices.find((d) => d.enrolmentId === enrolmentId && digestEquals(d.ackSecretDigest, digest));
  if (active) {
    if (active.revokedAt === null && active.ackRecoveryExpiresAt !== null && at < active.ackRecoveryExpiresAt) {
      return { ok: true, body: { v: 1, enrolmentId, state: 'acknowledged', deviceId: active.deviceId } };
    }
    return fail('invalid_acknowledgement', 'That acknowledgement is not valid.', 401);
  }
  const rec = enrolments.get(enrolmentId);
  if (!rec || (rec.state !== 'grant_ready' && rec.state !== 'delivered') || !digestEquals(rec.device.ackSecretDigest, digest)) {
    return fail('invalid_acknowledgement', 'That acknowledgement is not valid.', 401);
  }
  const device = {
    ...rec.device,
    enrolmentId,
    createdAt: at,
    lastSeenAt: at,
    tokenFamilyGeneration: 1,
    lookback: null,
    ackRecoveryExpiresAt: at + ACK_RECOVERY_MS,
    claimEncryptionKeyHandle: rec.claimEncryptionKeyHandle,
    transcriptHash: rec.transcriptHash.toString('hex'),
    tlsLeafFingerprint,
    revokedAt: null,
    revokedReason: null,
  };
  try {
    updateMobileState((s) => {
      s.devices.push(device);
    });
  } catch (error) {
    if (error && error.code === 'QM_MOBILE_STATE_DURABILITY_UNCERTAIN') throw error;
    return fail('unavailable', 'The device could not be activated.', 503);
  }
  Object.assign(rec, { state: 'acknowledged', ackRecoveryExpiresAt: device.ackRecoveryExpiresAt, envelope: null, device: null });
  return { ok: true, body: { v: 1, enrolmentId, state: 'acknowledged', deviceId: device.deviceId } };
}
