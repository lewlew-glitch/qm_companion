// Build encrypted app backups and short-lived QMC1 redemption capabilities.

import { scryptSync, createCipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const MAGIC = 'qmbackup';
const ENVELOPE_VERSION = 1;
const PAYLOAD_SCHEMA = 1;

// Keep aligned with the app backup format.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 32;
const VERIFIER_LEN = 16;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const REDEEM_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const PAIR_ID = /^[A-Za-z0-9_-]{24}$/u;
const MAX_ENVELOPE_BYTES = 5 * 1024 * 1024;

function deriveKeys(passphrase, salt) {
  // Normalize passphrases before key derivation.
  const pw = Buffer.from(passphrase.normalize('NFKC'), 'utf8');
  const okm = scryptSync(pw, salt, KEY_LEN + VERIFIER_LEN, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024, // N=2^15 wants ~64MB, node caps at 32
  });
  return { key: okm.subarray(0, KEY_LEN), verifier: okm.subarray(KEY_LEN) };
}

export function sealEnvelope(payload, passphrase) {
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const { key, verifier } = deriveKeys(passphrase, salt);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]); // tag goes on the end

  return {
    magic: MAGIC,
    version: ENVELOPE_VERSION,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, saltHex: salt.toString('hex') },
    cipher: { name: 'aes-256-gcm', nonceHex: nonce.toString('hex') },
    verifierHex: verifier.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function equalDigest(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Allow bounded retries of identical bytes after the first redemption.
const REDEEM_GRACE_MS = 20_000;
const REDEEM_GRACE_SERVES = 3;

/** Manage short-lived process-local transfers and their retry window. */
export class OneTimeTransfers {
  constructor({ now = () => Date.now(), maxEntries = 32 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.byRedeem = new Map();
    this.byPairId = new Map();
    this.byBundleId = new Map();
  }

  cleanup() {
    const at = this.now();
    for (const entry of this.byBundleId.values()) {
      // Redemption switches expiry from pairing TTL to retry grace.
      const dead = entry.redeemedAt != null
        ? at - entry.redeemedAt > REDEEM_GRACE_MS
        : entry.expiresAt <= at;
      if (dead) this.remove(entry);
    }
  }

  remove(entry) {
    this.byRedeem.delete(entry.redeemKey);
    this.byPairId.delete(entry.pairId);
    this.byBundleId.delete(entry.bundleId);
  }

  create({ envelopeJson, sessionToken, bundleId, expiresAt }) {
    this.cleanup();
    const envelope = String(envelopeJson ?? '');
    const session = String(sessionToken ?? '');
    const id = String(bundleId ?? '');
    if (!envelope || Buffer.byteLength(envelope, 'utf8') > MAX_ENVELOPE_BYTES) throw new Error('Pairing envelope is not valid.');
    if (!session || !/^[A-Za-z0-9_-]{16,128}$/u.test(id)) throw new Error('Pairing transfer context is not valid.');
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('Pairing transfer expiry is not valid.');

    const prior = this.byBundleId.get(id);
    if (prior) this.remove(prior);
    while (this.byBundleId.size >= this.maxEntries) {
      const oldest = this.byBundleId.values().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }

    const redeemToken = randomBytes(32).toString('base64url');
    const pairId = randomBytes(18).toString('base64url');
    const entry = {
      envelopeJson: envelope,
      sessionDigest: sha256(session),
      bundleId: id,
      expiresAt,
      redeemKey: sha256(redeemToken).toString('hex'),
      pairId,
      redeemedAt: null,
      reserves: 0,
    };
    this.byRedeem.set(entry.redeemKey, entry);
    this.byPairId.set(entry.pairId, entry);
    this.byBundleId.set(entry.bundleId, entry);
    return { redeemToken, pairId, bundleId: id, expiresAt };
  }

  take(entry) {
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.remove(entry);
      return null;
    }
    this.remove(entry);
    return entry.envelopeJson;
  }

  consumeRedeem(token) {
    const value = String(token ?? '');
    if (!REDEEM_TOKEN.test(value)) return null;
    const entry = this.byRedeem.get(sha256(value).toString('hex'));
    if (!entry) return null;
    const at = this.now();
    if (entry.redeemedAt == null) {
      if (entry.expiresAt <= at) {
        this.remove(entry);
        return null;
      }
      // Consume the file fallback and start retry grace.
      entry.redeemedAt = at;
      this.byPairId.delete(entry.pairId);
      return entry.envelopeJson;
    }
    if (at - entry.redeemedAt > REDEEM_GRACE_MS || entry.reserves >= REDEEM_GRACE_SERVES) {
      this.remove(entry);
      return null;
    }
    entry.reserves += 1;
    return entry.envelopeJson;
  }

  consumeFile(pairId, sessionToken) {
    const id = String(pairId ?? '');
    if (!PAIR_ID.test(id)) return null;
    const entry = this.byPairId.get(id);
    if (!entry || !equalDigest(entry.sessionDigest, sha256(String(sessionToken ?? '')))) return null;
    return this.take(entry);
  }

  invalidateBundle(bundleId) {
    const entry = this.byBundleId.get(String(bundleId ?? ''));
    if (!entry) return false;
    this.remove(entry);
    return true;
  }

  get size() {
    this.cleanup();
    return this.byBundleId.size;
  }
}

export function qmc1Payload(origin, redeemToken) {
  const token = String(redeemToken ?? '');
  if (!REDEEM_TOKEN.test(token)) throw new Error('Invalid redemption token.');
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Invalid Companion origin.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Invalid Companion origin.');
  }
  return `QMC1:${parsed.origin}/pair/redeem/${token}`;
}

export { PAYLOAD_SCHEMA };
