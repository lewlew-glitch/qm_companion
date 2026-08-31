// Mobile protocol primitives for transcripts, SAS, grants, identity challenges, and HPKE.

import { createHash, createPublicKey, hkdfSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { CipherSuite, Aes256Gcm, HkdfSha256, DhkemX25519HkdfSha256 } from '@hpke/core';

import { buildSealedEnvelope, parseSealedEnvelope, HPKE_INFO } from './envelope.js';
import { canonicalMobilePayload } from './schema.js';
import { OBSERVER_SCOPES, validateScopeList } from './scopes.js';
import { wordlist } from './wordlist.js';
import { parseAdvertisedOrigin } from './origin.js';

export const TRANSCRIPT_LABEL = 'qm-transcript-sign-v1';
export const GRANT_LABEL = 'qm-grant-sign-v1';
export const IDENTITY_LABEL = 'qm-identity-v1';
export const SAS_INFO = 'qm-sas-v1';
export const API_MAJOR = 1;
export const MAX_DEVICE_NAME = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const B64URL32_RE = /^[A-Za-z0-9_-]{43}$/;
const B64URL16_RE = /^[A-Za-z0-9_-]{22}$/;
// Transcripts bind only origins accepted by the canonical mobile origin parser.

function labelled(label, bytes) {
  return Buffer.concat([Buffer.from(label, 'utf8'), Buffer.from([0]), bytes]);
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Verify Ed25519 with a raw 32-byte base64url public key. */
export function verifyWithRawPublicKey(publicKeyB64url, bytes, signature) {
  const raw = Buffer.from(String(publicKeyB64url), 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== publicKeyB64url) return false;
  const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(String(signature), 'base64url');
  if (sig.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
    return edVerify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

function assertB64url(value, re, what) {
  if (typeof value !== 'string' || !re.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) {
    throw new Error(`${what} is not canonical base64url of the required length`);
  }
}

/** Build a transcript from server authority and claimant-bound fields. */
export function buildTranscript(server, claim) {
  if (!parseAdvertisedOrigin(server.origin).ok) throw new Error('advertised origin is not a canonical https origin with a port');
  if (!UUID_RE.test(server.mobileInstallationId)) throw new Error('mobileInstallationId is invalid');
  if (!UUID_RE.test(server.legacyInstallationId)) throw new Error('legacyInstallationId is invalid');
  assertB64url(server.serverSigningPublicKey, B64URL32_RE, 'serverSigningPublicKey');
  if (!HEX64_RE.test(server.serverSigningFingerprint)) throw new Error('serverSigningFingerprint is invalid');
  if (!HEX64_RE.test(server.tlsLeafFingerprint)) throw new Error('tlsLeafFingerprint is invalid');
  assertB64url(claim.enrolmentId, B64URL16_RE, 'enrolmentId');
  assertB64url(claim.claimEncryptionPublicKey, B64URL32_RE, 'claimEncryptionPublicKey');
  assertB64url(claim.clientNonce, B64URL16_RE, 'clientNonce');
  const scopes = validateScopeList(claim.requestedScopes);
  if (!scopes.ok) throw new Error(scopes.error);
  const deviceName = String(claim.deviceName ?? '').normalize('NFC');
  if (deviceName.length === 0 || deviceName.length > MAX_DEVICE_NAME) throw new Error('deviceName length is invalid');
  if (!Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= 0) throw new Error('expiresAt is invalid');
  return {
    v: 1,
    enrolmentId: claim.enrolmentId,
    origin: server.origin,
    mobileInstallationId: server.mobileInstallationId,
    legacyInstallationId: server.legacyInstallationId,
    serverSigningPublicKey: server.serverSigningPublicKey,
    serverSigningFingerprint: server.serverSigningFingerprint,
    tlsLeafFingerprint: server.tlsLeafFingerprint,
    claimEncryptionPublicKey: claim.claimEncryptionPublicKey,
    clientNonce: claim.clientNonce,
    requestedScopes: claim.requestedScopes,
    deviceName,
    expiresAt: claim.expiresAt,
  };
}

export function transcriptBytes(transcript) {
  return Buffer.from(canonicalMobilePayload(transcript), 'utf8');
}

export function transcriptHash(bytes) {
  return createHash('sha256').update(bytes).digest();
}

export function signTranscript(privateKey, bytes) {
  return edSign(null, labelled(TRANSCRIPT_LABEL, bytes), privateKey);
}

export function verifyTranscript(publicKeyB64url, bytes, signature) {
  return verifyWithRawPublicKey(publicKeyB64url, labelled(TRANSCRIPT_LABEL, bytes), signature);
}

/** Derive the five-word SAS as a base-7776 encoding of an HKDF-derived big-endian u64. */
export function deriveSas(hash) {
  const out = Buffer.from(hkdfSync('sha256', hash, Buffer.alloc(32), SAS_INFO, 8));
  let n = out.readBigUInt64BE(0);
  const digits = [0, 0, 0, 0, 0];
  for (let i = 4; i >= 0; i -= 1) {
    digits[i] = Number(n % 7776n);
    n /= 7776n;
  }
  const words = wordlist();
  return { digits, words: digits.map((d) => words[d]) };
}

export function buildGrant(fields) {
  const required = [
    'mobileInstallationId', 'legacyInstallationId', 'deviceId', 'accessToken', 'accessTokenExpiresAt',
    'refreshGrant', 'refreshAbsoluteDeadlineAt', 'refreshIdleDeadlineAt', 'tokenFamilyGeneration',
    'scopes', 'ackSecret', 'transcriptHash',
  ];
  for (const key of required) if (!(key in fields)) throw new Error(`grant is missing ${key}`);
  if (!/^qmd_[A-Za-z0-9_-]{43}$/.test(fields.accessToken)) throw new Error('accessToken is not a qmd token');
  if (!/^qmr_[A-Za-z0-9_-]{43}$/.test(fields.refreshGrant)) throw new Error('refreshGrant is not a qmr token');
  assertB64url(fields.deviceId, B64URL16_RE, 'deviceId');
  assertB64url(fields.ackSecret, B64URL32_RE, 'ackSecret');
  if (!HEX64_RE.test(fields.transcriptHash)) throw new Error('transcriptHash is invalid');
  const scopes = validateScopeList(fields.scopes);
  if (!scopes.ok) throw new Error(scopes.error);
  return {
    v: 1,
    mobileInstallationId: fields.mobileInstallationId,
    legacyInstallationId: fields.legacyInstallationId,
    deviceId: fields.deviceId,
    accessToken: fields.accessToken,
    accessTokenExpiresAt: fields.accessTokenExpiresAt,
    refreshGrant: fields.refreshGrant,
    refreshAbsoluteDeadlineAt: fields.refreshAbsoluteDeadlineAt,
    refreshIdleDeadlineAt: fields.refreshIdleDeadlineAt,
    tokenFamilyGeneration: fields.tokenFamilyGeneration,
    scopes: fields.scopes,
    ackSecret: fields.ackSecret,
    transcriptHash: fields.transcriptHash,
  };
}

export function grantBytes(grant) {
  return Buffer.from(canonicalMobilePayload(grant), 'utf8');
}

export function signGrant(privateKey, bytes) {
  return edSign(null, labelled(GRANT_LABEL, bytes), privateKey);
}

export function verifyGrant(publicKeyB64url, bytes, signature) {
  return verifyWithRawPublicKey(publicKeyB64url, labelled(GRANT_LABEL, bytes), signature);
}

/** The sealed plaintext wrapper: JCS of { v, grant, signature }. */
export function sealedPlaintext(grant, signature) {
  return Buffer.from(
    canonicalMobilePayload({ v: 1, grant, signature: Buffer.from(signature).toString('base64url') }),
    'utf8',
  );
}

/** The identity-challenge signed bytes: a NUL-delimited byte string with apiMajor inside. */
export function identitySignedBytes({ mobileInstallationId, publicKeyRaw, challenge, issuedAt }) {
  if (!UUID_RE.test(mobileInstallationId)) throw new Error('mobileInstallationId is invalid');
  if (!Buffer.isBuffer(publicKeyRaw) || publicKeyRaw.length !== 32) throw new Error('publicKeyRaw must be 32 bytes');
  if (!Buffer.isBuffer(challenge) || challenge.length !== 32) throw new Error('challenge must be 32 bytes');
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error('issuedAt is invalid');
  const nul = Buffer.from([0]);
  return Buffer.concat([
    Buffer.from(IDENTITY_LABEL), nul,
    Buffer.from(String(API_MAJOR)), nul,
    Buffer.from(mobileInstallationId), nul,
    publicKeyRaw, nul,
    challenge, nul,
    Buffer.from(String(issuedAt)),
  ]);
}

export function signIdentity(privateKey, bytes) {
  return edSign(null, bytes, privateKey);
}

export function verifyIdentity(publicKeyB64url, bytes, signature) {
  return verifyWithRawPublicKey(publicKeyB64url, bytes, signature);
}

// Fixed-suite HPKE uses the verified transcript hash as out-of-band AAD.
function suite() {
  return new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
}

export async function sealGrant(recipientPublicKeyRaw, plaintext, aadTranscriptHash) {
  if (!Buffer.isBuffer(recipientPublicKeyRaw) || recipientPublicKeyRaw.length !== 32) throw new Error('recipient key must be 32 bytes');
  const s = suite();
  const recipientPublicKey = await s.kem.importKey('raw', recipientPublicKeyRaw, true);
  const sender = await s.createSenderContext({ recipientPublicKey, info: new TextEncoder().encode(HPKE_INFO) });
  const ct = Buffer.from(await sender.seal(plaintext, aadTranscriptHash));
  return buildSealedEnvelope(Buffer.from(sender.enc), ct);
}

/** Open a canonical envelope after strict parsing. */
export async function openGrant(recipientPrivateKeyRaw, envelopeText, aadTranscriptHash) {
  const parsed = parseSealedEnvelope(envelopeText);
  if (!parsed.ok) throw new Error(`envelope refused: ${parsed.error}`);
  const s = suite();
  const recipientKey = await s.kem.importKey('raw', recipientPrivateKeyRaw, false);
  const ctx = await s.createRecipientContext({ recipientKey, enc: parsed.enc, info: new TextEncoder().encode(HPKE_INFO) });
  return Buffer.from(await ctx.open(parsed.ct, aadTranscriptHash));
}

export { OBSERVER_SCOPES };
