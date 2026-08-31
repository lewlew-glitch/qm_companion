// QMC2 payload: a secret, canonical JSON capability encoded as unpadded base64url.

import { canonicalMobilePayload } from './schema.js';
import { parseAdvertisedOrigin } from './origin.js';
import { parseToken } from './token-family.js';

export const QR_PREFIX = 'QMC2:';
export const QR_VERSION = 2;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const EXPECTED_KEYS = 'fingerprint,key,origin,v';
const MAX_TEXT_CHARS = 1024;

function fail(error) {
  return { ok: false, error };
}

/** Build QMC2 text from a canonical origin, qme capability, and identity fingerprint. */
export function buildQrPayload(origin, key, fingerprint) {
  if (!parseAdvertisedOrigin(origin).ok) throw new Error('qr origin is not a canonical https origin');
  const parsed = parseToken(key);
  if (!parsed || parsed.family !== 'qme') throw new Error('qr key is not a qme capability');
  if (!HEX64_RE.test(fingerprint)) throw new Error('qr fingerprint is not hex64');
  const canonical = canonicalMobilePayload({ v: QR_VERSION, origin, key, fingerprint });
  return `${QR_PREFIX}${Buffer.from(canonical, 'utf8').toString('base64url')}`;
}

/** Strictly parse and re-canonicalize every QMC2 field. */
export function parseQrPayload(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) return fail('qr text is not a string');
  if (!text.startsWith(QR_PREFIX)) return fail('qr text has the wrong prefix');
  const encoded = text.slice(QR_PREFIX.length);
  if (encoded.length === 0 || !B64URL_RE.test(encoded)) return fail('qr body is not base64url');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) return fail('qr body is not canonical base64url');
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail('qr body is not JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('qr body is not an object');
  if (Object.keys(value).sort().join(',') !== EXPECTED_KEYS) return fail('qr body has unexpected fields');
  if (value.v !== QR_VERSION) return fail('qr version is unsupported');
  if (typeof value.origin !== 'string' || typeof value.key !== 'string' || typeof value.fingerprint !== 'string') {
    return fail('qr body has a non-string field');
  }
  let canonical;
  try {
    canonical = canonicalMobilePayload(value);
  } catch {
    return fail('qr body is not canonical');
  }
  if (Buffer.from(canonical, 'utf8').toString('base64url') !== encoded) return fail('qr body is not canonical');
  if (!parseAdvertisedOrigin(value.origin).ok) return fail('qr origin is not a canonical https origin');
  const parsed = parseToken(value.key);
  if (!parsed || parsed.family !== 'qme') return fail('qr key is not a qme capability');
  if (!HEX64_RE.test(value.fingerprint)) return fail('qr fingerprint is not hex64');
  return { ok: true, v: QR_VERSION, origin: value.origin, key: value.key, fingerprint: value.fingerprint };
}
