// Standard HMAC-SHA1 TOTP with 30-second steps and six digits.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// RFC 4648 base32 without padding.
export function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function newSecret() {
  return randomBytes(20); // Google Authenticator-compatible size.
}

function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const at = mac[mac.length - 1] & 0x0f;
  const code = ((mac[at] & 0x7f) << 24) | (mac[at + 1] << 16) | (mac[at + 2] << 8) | mac[at + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

// Allow one time step of clock skew in either direction.
export function verifyTotp(secret, code, at = Date.now()) {
  const cleaned = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const step = Math.floor(at / 1000 / 30);
  for (const c of [step, step - 1, step + 1]) {
    const want = Buffer.from(hotp(secret, c));
    const got = Buffer.from(cleaned);
    if (want.length === got.length && timingSafeEqual(want, got)) return true;
  }
  return false;
}

export function otpauthUrl(secret, label, issuer) {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${base32(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
