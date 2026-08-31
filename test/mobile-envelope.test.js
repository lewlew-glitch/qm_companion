import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSealedEnvelope, parseSealedEnvelope } from '../src/mobile/envelope.js';

const enc = Buffer.alloc(32, 1);
const ct = Buffer.alloc(48, 2);

test('round-trips a valid envelope', () => {
  const text = buildSealedEnvelope(enc, ct);
  const parsed = parseSealedEnvelope(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.enc, enc);
  assert.deepEqual(parsed.ct, ct);
});

function mutate(change) {
  const obj = JSON.parse(buildSealedEnvelope(enc, ct));
  change(obj);
  return JSON.stringify(obj);
}

test('rejects unknown envelope fields', () => {
  assert.equal(parseSealedEnvelope(mutate((o) => { o.aad = 'AAAA'; })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.info = 'x'; })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { delete o.kdf; })).ok, false);
});

test('accepts only the fixed ciphersuite and version', () => {
  assert.equal(parseSealedEnvelope(mutate((o) => { o.v = 2; })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.kem = 0x0010; })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.kdf = 0x0002; })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.aead = 0x0001; })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.aead = 0x0003; })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.kem = '32'; })).ok, false);
});

test('validates encoded key and ciphertext bounds', () => {
  assert.equal(parseSealedEnvelope(mutate((o) => { o.enc = Buffer.alloc(31, 1).toString('base64url'); })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.enc = Buffer.alloc(33, 1).toString('base64url'); })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.enc = `${o.enc}=`; })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.enc = o.enc.replace(/-|_/g, '+'); })).ok, parseSealedEnvelope(mutate((o) => { o.enc = o.enc.replace(/-|_/g, '+'); })).ok);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.ct = Buffer.alloc(8).toString('base64url'); })).ok, false);
  assert.equal(parseSealedEnvelope(mutate((o) => { o.ct = Buffer.alloc(16 * 1024 + 1).toString('base64url'); })).ok, false);
  const chars = enc.toString('base64url').split('');
  chars[42] = chars[42] === 'B' ? 'C' : 'B';
  const variant = chars.join('');
  if (Buffer.from(variant, 'base64url').toString('base64url') !== variant) {
    assert.equal(parseSealedEnvelope(mutate((o) => { o.enc = variant; })).ok, false);
  }
});

test('rejects invalid and oversized envelope text', () => {
  assert.equal(parseSealedEnvelope('not json').ok, false);
  assert.equal(parseSealedEnvelope('[]').ok, false);
  assert.equal(parseSealedEnvelope(42).ok, false);
  assert.equal(parseSealedEnvelope('{"v":1'.padEnd(24 * 1024 + 1, ' ')).ok, false);
});
