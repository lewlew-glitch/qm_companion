import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOBILE_TOKEN_FAMILIES,
  digestEquals,
  digestToken,
  mintToken,
  parseToken,
} from '../src/mobile/token-family.js';

test('round-trips minted family tokens', () => {
  for (const family of MOBILE_TOKEN_FAMILIES) {
    const token = mintToken(family);
    assert.equal(token.length, 47);
    const parsed = parseToken(token);
    assert.ok(parsed, `${family} token failed to parse`);
    assert.equal(parsed.family, family);
    assert.equal(parsed.bytes.length, 32);
  }
});

test('the legacy qmc script token is not a mobile family', () => {
  assert.equal(parseToken(`qmc_${'a'.repeat(48)}`), null);
  assert.equal(parseToken(`qmc_${'A'.repeat(43)}`), null);
  assert.throws(() => mintToken('qmc'), /unknown mobile token family/);
  assert.throws(() => digestToken('qmc', Buffer.alloc(32)), /unknown mobile token family/);
});

test('rejects malformed and non-canonical tokens', () => {
  const good = mintToken('qmd');
  assert.ok(parseToken(good));
  assert.equal(parseToken(good.slice(0, -1)), null); // 42 chars
  assert.equal(parseToken(`${good}A`), null); // 44 chars
  assert.equal(parseToken(good.replace('qmd_', 'QMD_')), null);
  assert.equal(parseToken(`qmd_${'+'.repeat(43)}`), null);
  assert.equal(parseToken(`qmd_${'='.repeat(43)}`), null);
  const bytes = Buffer.from(good.slice(4), 'base64url');
  const chars = good.slice(4).split('');
  const last = chars[42];
  chars[42] = last === 'B' ? 'C' : 'B';
  const variant = chars.join('');
  const variantBytes = Buffer.from(variant, 'base64url');
  if (variantBytes.length === 32 && variantBytes.toString('base64url') !== variant) {
    assert.equal(parseToken(`qmd_${variant}`), null);
  }
  assert.ok(parseToken(`qmd_${bytes.toString('base64url')}`));
  assert.equal(parseToken(42), null);
  assert.equal(parseToken(null), null);
});

test('separates and compares family digests', () => {
  const bytes = Buffer.alloc(32, 7);
  const digests = MOBILE_TOKEN_FAMILIES.map((family) => digestToken(family, bytes));
  assert.equal(new Set(digests).size, MOBILE_TOKEN_FAMILIES.length);
  for (const digest of digests) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digestEquals(digests[0], digests[0]), true);
  assert.equal(digestEquals(digests[0], digests[1]), false);
  assert.equal(digestEquals(digests[0], 'not-a-digest'), false);
  assert.equal(digestEquals(undefined, digests[0]), false);
});
