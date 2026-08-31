// Strict mobile token families with digest-only storage and constant-time comparison.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MOBILE_TOKEN_FAMILIES = Object.freeze(['qmp', 'qme', 'qmd', 'qmr']);
const TOKEN_RE = /^(qmp|qme|qmd|qmr)_([A-Za-z0-9_-]{43})$/;

export function mintToken(family) {
  if (!MOBILE_TOKEN_FAMILIES.includes(family)) throw new Error('unknown mobile token family');
  return `${family}_${randomBytes(32).toString('base64url')}`;
}

// Require a known prefix and canonical 32-byte base64url value.
export function parseToken(token) {
  if (typeof token !== 'string') return null;
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64url');
  if (bytes.length !== 32) return null;
  if (bytes.toString('base64url') !== match[2]) return null;
  return { family: match[1], bytes };
}

export function digestToken(family, bytes) {
  if (!MOBILE_TOKEN_FAMILIES.includes(family)) throw new Error('unknown mobile token family');
  return createHash('sha256')
    .update(`qm-token-${family}-v1`)
    .update(Buffer.from([0]))
    .update(bytes)
    .digest('hex');
}

export function digestEquals(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  if (!/^[0-9a-f]{64}$/.test(aHex) || !/^[0-9a-f]{64}$/.test(bHex)) return false;
  return timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'));
}
