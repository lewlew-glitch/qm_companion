// Fixed-suite HPKE parsing with transcript-bound AAD.

export const ENVELOPE_VERSION = 1;
export const KEM_X25519_HKDF_SHA256 = 0x0020;
export const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES_256_GCM = 0x0002;
export const HPKE_INFO = 'qm-grant-v1';
export const MAX_CT_BYTES = 16 * 1024;
export const MAX_ENVELOPE_BYTES = 24 * 1024;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function canonicalB64url(value) {
  if (typeof value !== 'string' || value.length === 0 || !B64URL_RE.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return null; // padding or a non-canonical tail
  return bytes;
}

function fail(error) {
  return { ok: false, error };
}

/** Parse raw envelope JSON into decoded enc and ct bytes or a stable refusal. */
export function parseSealedEnvelope(rawText) {
  if (typeof rawText !== 'string') return fail('envelope is not text');
  if (Buffer.byteLength(rawText, 'utf8') > MAX_ENVELOPE_BYTES) return fail('envelope exceeds the size cap');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return fail('envelope is not valid JSON');
  }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype) return fail('envelope is not an object');
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'aead,ct,enc,kdf,kem,v') return fail('envelope has unexpected fields');
  if (parsed.v !== ENVELOPE_VERSION) return fail('envelope version is unsupported');
  if (parsed.kem !== KEM_X25519_HKDF_SHA256) return fail('envelope kem is not the fixed suite');
  if (parsed.kdf !== KDF_HKDF_SHA256) return fail('envelope kdf is not the fixed suite');
  if (parsed.aead !== AEAD_AES_256_GCM) return fail('envelope aead is not the fixed suite');
  const enc = canonicalB64url(parsed.enc);
  if (!enc || enc.length !== 32) return fail('envelope enc is not a 32-byte canonical value');
  const ct = canonicalB64url(parsed.ct);
  if (!ct) return fail('envelope ct is not canonical base64url');
  if (ct.length > MAX_CT_BYTES) return fail('envelope ct exceeds the size cap');
  if (ct.length < 16) return fail('envelope ct is shorter than an AEAD tag');
  return { ok: true, enc, ct };
}

/** Build the wire form from raw bytes, the only shape the parser above accepts. */
export function buildSealedEnvelope(enc, ct) {
  if (!Buffer.isBuffer(enc) || enc.length !== 32) throw new Error('enc must be 32 bytes');
  if (!Buffer.isBuffer(ct) || ct.length < 16 || ct.length > MAX_CT_BYTES) throw new Error('ct size is invalid');
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    kem: KEM_X25519_HKDF_SHA256,
    kdf: KDF_HKDF_SHA256,
    aead: AEAD_AES_256_GCM,
    enc: enc.toString('base64url'),
    ct: ct.toString('base64url'),
  });
}
