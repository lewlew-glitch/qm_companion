// Strict schema for canonical mobile authority payloads.

import { validateScopeList } from './scopes.js';

export const MOBILE_STATE_VERSION = 1;
export const MAX_DEVICES = 32;
export const MAX_SPENT_CAPABILITIES = 256;
export const MAX_STATE_BYTES = 64 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const B64URL32_RE = /^[A-Za-z0-9_-]{43}$/;
const SEALED_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;
const CLONE_NONCE_RE = /^[0-9a-f]{32}$/;
const B64URL16_RE = /^[A-Za-z0-9_-]{22}$/;
const SPENT_FAMILIES = Object.freeze(['qmp', 'qme']);
const REVOKE_REASONS = Object.freeze(['owner', 'reuse', 'expired']);
export const MAX_DEVICE_NAME = 64;
export const MAX_SEALED_RETRY_CHARS = 4096;

function isPlainObject(value) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype;
}

function isTimeMs(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function fail(detail) {
  return { ok: false, error: detail };
}

function validIdentity(identity) {
  if (!isPlainObject(identity)) return 'identity is not an object';
  const keys = Object.keys(identity).sort();
  if (keys.join(',') !== 'createdAt,fingerprint,publicKey,sealedPrivateKey') {
    return 'identity has unexpected fields';
  }
  if (!B64URL32_RE.test(identity.publicKey)) return 'identity publicKey is invalid';
  if (!HEX64_RE.test(identity.fingerprint)) return 'identity fingerprint is invalid';
  if (typeof identity.sealedPrivateKey !== 'string' || !SEALED_RE.test(identity.sealedPrivateKey)) {
    return 'identity sealedPrivateKey is invalid';
  }
  if (!isTimeMs(identity.createdAt)) return 'identity createdAt is invalid';
  return null;
}

// Spent capabilities atomically retain their claimant, enrolment, and transcript bindings until expiry.
function validSpent(entry) {
  if (!isPlainObject(entry)) return 'spent capability is not an object';
  const keys = Object.keys(entry).sort();
  if (keys.join(',') !== 'claimEncryptionKeyHandle,digest,enrolmentId,expiresAt,family,transcriptHash') {
    return 'spent capability has unexpected fields';
  }
  if (!HEX64_RE.test(entry.digest)) return 'spent capability digest is invalid';
  if (!SPENT_FAMILIES.includes(entry.family)) return 'spent capability family is invalid';
  if (typeof entry.enrolmentId !== 'string' || !B64URL16_RE.test(entry.enrolmentId)) {
    return 'spent capability enrolmentId is invalid';
  }
  if (!HEX64_RE.test(entry.claimEncryptionKeyHandle)) return 'spent capability key handle is invalid';
  if (!HEX64_RE.test(entry.transcriptHash)) return 'spent capability transcriptHash is invalid';
  if (!isTimeMs(entry.expiresAt)) return 'spent capability expiresAt is invalid';
  return null;
}

// Refresh lookback stores one sealed, request-bound retry response until successor use or family closure.
function validLookback(lookback) {
  if (lookback === null) return null;
  if (!isPlainObject(lookback)) return 'device lookback is not an object';
  const keys = Object.keys(lookback).sort();
  if (keys.join(',') !== 'expiresAt,previousRefreshDigest,rotationRequestId,sealedResponse') {
    return 'device lookback has unexpected fields';
  }
  if (!HEX64_RE.test(lookback.previousRefreshDigest)) return 'device lookback digest is invalid';
  if (!B64URL16_RE.test(lookback.rotationRequestId)) return 'device lookback rotationRequestId is invalid';
  if (!isTimeMs(lookback.expiresAt)) return 'device lookback expiresAt is invalid';
  if (typeof lookback.sealedResponse !== 'string' || !SEALED_RE.test(lookback.sealedResponse) || lookback.sealedResponse.length > MAX_SEALED_RETRY_CHARS) {
    return 'device lookback sealedResponse is invalid';
  }
  return null;
}

export const DEVICE_KEYS = Object.freeze([
  'accessTokenDigest', 'accessTokenExpiresAt', 'ackRecoveryExpiresAt', 'ackSecretDigest',
  'claimEncryptionKeyHandle', 'createdAt', 'deviceId', 'deviceName', 'enrolmentId', 'lastSeenAt',
  'lookback', 'refreshAbsoluteDeadlineAt', 'refreshDigest', 'refreshIdleDeadlineAt', 'revokedAt',
  'revokedReason', 'scopes', 'tlsLeafFingerprint', 'tokenFamilyGeneration', 'transcriptHash',
]);

// Revocation remains recorded so stale state cannot reactivate a token family.
function validDevice(device, validateScopes) {
  if (!isPlainObject(device)) return 'device is not an object';
  if (Object.keys(device).sort().join(',') !== DEVICE_KEYS.join(',')) return 'device has unexpected fields';
  if (!B64URL16_RE.test(device.deviceId)) return 'device id is invalid';
  if (typeof device.deviceName !== 'string' || device.deviceName.length === 0 || device.deviceName.length > MAX_DEVICE_NAME || device.deviceName !== device.deviceName.normalize('NFC')) {
    return 'device name is invalid';
  }
  if (!B64URL16_RE.test(device.enrolmentId)) return 'device enrolmentId is invalid';
  for (const key of ['accessTokenDigest', 'ackSecretDigest', 'claimEncryptionKeyHandle', 'refreshDigest', 'tlsLeafFingerprint', 'transcriptHash']) {
    if (!HEX64_RE.test(device[key])) return `device ${key} is invalid`;
  }
  for (const key of ['accessTokenExpiresAt', 'createdAt', 'lastSeenAt', 'refreshAbsoluteDeadlineAt', 'refreshIdleDeadlineAt']) {
    if (!isTimeMs(device[key])) return `device ${key} is invalid`;
  }
  if (device.ackRecoveryExpiresAt !== null && !isTimeMs(device.ackRecoveryExpiresAt)) return 'device ackRecoveryExpiresAt is invalid';
  if (!Number.isSafeInteger(device.tokenFamilyGeneration) || device.tokenFamilyGeneration < 1) return 'device tokenFamilyGeneration is invalid';
  const scopes = validateScopes(device.scopes);
  if (!scopes.ok) return `device scopes: ${scopes.error}`;
  const lookbackProblem = validLookback(device.lookback);
  if (lookbackProblem) return lookbackProblem;
  if (device.revokedAt === null) {
    if (device.revokedReason !== null) return 'device revokedReason without revokedAt';
  } else {
    if (!isTimeMs(device.revokedAt)) return 'device revokedAt is invalid';
    if (!REVOKE_REASONS.includes(device.revokedReason)) return 'device revokedReason is invalid';
  }
  return null;
}

function validDevices(devices, validateScopes) {
  if (!Array.isArray(devices)) return 'devices is not a list';
  if (devices.length > MAX_DEVICES) return 'devices exceeds the cap';
  const ids = new Set();
  const digests = new Set();
  for (const device of devices) {
    const problem = validDevice(device, validateScopes);
    if (problem) return problem;
    if (ids.has(device.deviceId)) return 'device id is duplicated';
    ids.add(device.deviceId);
    for (const digest of [device.accessTokenDigest, device.refreshDigest, device.lookback?.previousRefreshDigest]) {
      if (!digest) continue;
      if (digests.has(digest)) return 'device token digest is duplicated';
      digests.add(digest);
    }
  }
  return null;
}

// Recursively sorted minimal JSON provides canonical state bytes.
export function canonicalMobilePayload(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalMobilePayload).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('non-plain object in mobile payload');
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalMobilePayload(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('non-integer number in mobile payload');
  }
  return JSON.stringify(value);
}

export function validateMobilePayload(payload, expectedLegacyId) {
  if (!isPlainObject(payload)) return fail('payload is not an object');
  const keys = Object.keys(payload).sort();
  const expectedKeys = [
    'consumedCloneNonce',
    'devices',
    'identity',
    'legacyInstallationId',
    'mobileInstallationId',
    'spentCapabilities',
    'tlsResetPending',
    'version',
  ];
  if (keys.join(',') !== expectedKeys.join(',')) return fail('payload has unexpected fields');
  if (payload.version !== MOBILE_STATE_VERSION) return fail('payload version is unsupported');
  if (!UUID_RE.test(payload.mobileInstallationId)) return fail('mobileInstallationId is invalid');
  if (payload.legacyInstallationId !== expectedLegacyId) {
    return fail('legacyInstallationId does not match this installation');
  }
  const identityProblem = validIdentity(payload.identity);
  if (identityProblem) return fail(identityProblem);
  const devicesProblem = validDevices(payload.devices, validateScopeList);
  if (devicesProblem) return fail(devicesProblem);
  if (!Array.isArray(payload.spentCapabilities)) return fail('spentCapabilities is not a list');
  if (payload.spentCapabilities.length > MAX_SPENT_CAPABILITIES) {
    return fail('spentCapabilities exceeds the cap');
  }
  const digests = new Set();
  for (const entry of payload.spentCapabilities) {
    const problem = validSpent(entry);
    if (problem) return fail(problem);
    if (digests.has(entry.digest)) return fail('spent capability digest is duplicated');
    digests.add(entry.digest);
  }
  if (payload.consumedCloneNonce !== null && !CLONE_NONCE_RE.test(payload.consumedCloneNonce)) {
    return fail('consumedCloneNonce is invalid');
  }
  if (typeof payload.tlsResetPending !== 'boolean') return fail('tlsResetPending is invalid');
  return { ok: true };
}
