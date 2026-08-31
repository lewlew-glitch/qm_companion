// Ed25519 mobile identity with its private key sealed to the installation ID at rest.

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';

import { mobileSealKey } from './keys.js';

const IV_LEN = 12;
// Raw Ed25519 public keys are the final 32 bytes of the fixed-prefix SPKI DER.
const SPKI_PREFIX_LEN = 12;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function rawPublicKey(publicKeyObject) {
  const der = publicKeyObject.export({ format: 'der', type: 'spki' });
  return der.subarray(SPKI_PREFIX_LEN);
}

export function fingerprintOf(rawKey) {
  return createHash('sha256').update(rawKey).digest('hex');
}

function sealPrivateKey(privateKeyObject, mobileInstallationId) {
  const pkcs8 = privateKeyObject.export({ format: 'der', type: 'pkcs8' });
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', mobileSealKey, iv);
  cipher.setAAD(Buffer.from(`${mobileInstallationId}:identity`, 'utf8'));
  const body = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body.toString('hex')}`;
}

export function createIdentity(mobileInstallationId, now = Date.now()) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = rawPublicKey(publicKey);
  return {
    publicKey: b64url(raw),
    fingerprint: fingerprintOf(raw),
    sealedPrivateKey: sealPrivateKey(privateKey, mobileInstallationId),
    createdAt: now,
  };
}

// Wrong keys, tampering, and installation-ID mismatch all fail closed as unusable.
export function openPrivateKey(sealedPrivateKey, mobileInstallationId) {
  const [ivHex, tagHex, bodyHex] = String(sealedPrivateKey).split(':');
  if (!ivHex || !tagHex || !bodyHex) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', mobileSealKey, Buffer.from(ivHex, 'hex'));
    decipher.setAAD(Buffer.from(`${mobileInstallationId}:identity`, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const pkcs8 = Buffer.concat([decipher.update(Buffer.from(bodyHex, 'hex')), decipher.final()]);
    return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  }
}

/** Derive the raw public key for load-time identity consistency checks. */
export function publicKeyFromPrivate(privateKeyObject) {
  return rawPublicKey(createPublicKey(privateKeyObject));
}

export function signWithIdentity(privateKeyObject, bytes) {
  return edSign(null, bytes, privateKeyObject);
}

export function verifyWithPublicKey(publicKeyB64url, bytes, signature) {
  const raw = Buffer.from(publicKeyB64url, 'base64url');
  if (raw.length !== 32) return false;
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), // the fixed Ed25519 SPKI header
    raw,
  ]);
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return edVerify(null, bytes, key, signature);
  } catch {
    return false;
  }
}
