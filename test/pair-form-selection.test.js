import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDecipheriv, scryptSync } from 'node:crypto';

import { buildBundle, PairingValidationError } from '../src/build.js';
import { readFormBody } from '../src/http.js';
import { draftFromPairForm } from '../src/pair-form.js';

const detected = Array.from({ length: 130 }, (_, index) => ({
  instanceId: `fixture-instance-${index}`, kind: 'bazarr', name: `Bazarr ${index}`,
  up: true, availability: 'reachable', apiKey: `fixture-key-${index}`,
}));
const metadata = { bundleId: 'fixture_bundle_1234567890',
  issuedAt: '2026-09-11T10:00:00.000Z', expiresAt: '2026-09-11T10:03:00.000Z' };

function form(selected, count = detected.length) {
  const body = new URLSearchParams({ csrf: 'fixture-csrf' });
  for (let index = 0; index < count; index += 1) {
    body.set(`service_${index}`, detected[index].instanceId);
    body.set(`base_${index}`, `http://nas.local:${10000 + index}`);
    body.set(`remote_${index}`, `https://service-${index}.example.test`);
    if (selected.includes(index)) body.set(`include_${index}`, 'on');
  }
  return body;
}
async function parse(body) {
  const request = new EventEmitter();
  request.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const reading = readFormBody(request);
  request.emit('data', Buffer.from(body.toString())); request.emit('end');
  const result = await reading;
  assert.equal(result.ok, true);
  return result.value;
}
function bundle(draft) {
  return buildBundle(detected, { qmTitle: 'Home', qmHost: 'nas.local' }, draft,
    'fixture-installation', metadata);
}
function decrypt(result) {
  const e = JSON.parse(result.envelopeJson);
  const key = scryptSync(result.setupCode, Buffer.from(e.kdf.saltHex, 'hex'), 48,
    { N: e.kdf.N, r: e.kdf.r, p: e.kdf.p, maxmem: 256 * 1024 * 1024 });
  const bytes = Buffer.from(e.ciphertextHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key.subarray(0, 32), Buffer.from(e.cipher.nonceHex, 'hex'));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]));
}

test('form indexes 1 and 101 hand over exactly those instances, addresses and credentials', async () => {
  const draft = draftFromPairForm(detected, await parse(form([1, 101])));
  assert.deepEqual(draft.services.filter((row) => row.included).map((row) => row.instanceId),
    ['fixture-instance-1', 'fixture-instance-101']);
  const result = bundle(draft);
  const payload = decrypt(result);
  assert.deepEqual(payload, result.payload);
  assert.deepEqual(payload.services.map((service) => service.label), ['Bazarr 1', 'Bazarr 101']);
  assert.deepEqual(payload.services.map((service) => service.secrets),
    [{ apiKey: 'fixture-key-1' }, { apiKey: 'fixture-key-101' }]);
  assert.deepEqual(payload.services.map((service) => service.baseUrl),
    ['http://nas.local:10001', 'http://nas.local:10101']);
  assert.deepEqual(payload.services.map((service) => service.remoteBaseUrl),
    ['https://service-1.example.test', 'https://service-101.example.test']);
  assert.deepEqual(payload.profiles[0].serviceIds, payload.services.map((service) => service.id));
  assert.equal(payload.profiles.length, 1);
});

test('unchecked and newly discovered services remain unselected on a stale form', async () => {
  const draft = draftFromPairForm(detected, await parse(form([1, 101], 102)));
  assert.equal(draft.services.length, 130);
  assert.deepEqual(draft.services.filter((row) => row.included).map((row) => row.instanceId),
    ['fixture-instance-1', 'fixture-instance-101']);
  assert.ok(draft.services.filter((row) => row.instanceId !== 'fixture-instance-1' &&
    row.instanceId !== 'fixture-instance-101').every((row) => row.included === false));
});

test('64 selections can span the whole form and a 65th is refused without truncation', async () => {
  const selected = Array.from({ length: 64 }, (_, index) => index * 2);
  const accepted = bundle(draftFromPairForm(detected, await parse(form(selected))));
  assert.deepEqual(accepted.payload.services.map((service) => service.label), selected.map((index) => `Bazarr ${index}`));
  const tooMany = draftFromPairForm(detected, await parse(form([...selected, 129])));
  assert.throws(() => bundle(tooMany), (error) =>
    error instanceof PairingValidationError && /too many services|up to 64/.test(error.message));
});

test('a duplicate or unknown selected instance is refused even at a later index', async () => {
  for (const value of ['fixture-instance-1', 'fixture-unknown']) {
    const body = form([1, 101]); body.set('service_101', value);
    assert.throws(() => bundle(draftFromPairForm(detected, Object.fromEntries(body))), PairingValidationError);
  }
});
