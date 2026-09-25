// Alert mutations and secret replies retain current pairing authority.

import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairAlertPhone, listenForAlerts, freshAlerts } from './helpers/alerts-fixture.mjs';

process.env.SECRET_KEY = 'dc'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-alerts-authority-'));
process.env.QM_HOST = 'nas.local';

const { createAlertsRouter, resetAlertRouteLimiterForTest } = await import('../src/alerts/routes.js');
const { defaultEventRules } = await import('../src/alerts/schema.js');
const { loadAlertsState, saveAlertsState, updateAlertsState } = await import('../src/alerts/store.js');
const { revokeDevice } = await import('../src/mobile/devices.js');

const INTAKE = Object.freeze({ baseUrl: 'http://nas.local:8787', localOnly: true });

beforeEach(() => {
  saveAlertsState(freshAlerts());
  resetAlertRouteLimiterForTest();
});
after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

function source() {
  const entry = {
    id: `src_${randomBytes(16).toString('base64url')}`, kind: 'sonarr', serviceId: null, label: 'Sonarr',
    secret: randomBytes(32).toString('base64url'), createdAt: Date.now(), lastEventAt: null, lastTestAt: null,
    events: defaultEventRules('sonarr'),
  };
  updateAlertsState((state) => { state.sources.push(entry); });
  return entry;
}

async function start(t, options = {}, received = null) {
  const router = createAlertsRouter({ address: async () => INTAKE, ...options });
  return listenForAlerts((req, res) => {
    if (received) req.once('data', () => received.resolve());
    return router(req, res, new URL(req.url, 'http://x'));
  }, t);
}

async function call(base, phone, path = '', body) {
  const response = await fetch(`${base}/api/mobile/v1/alerts${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${phone.accessToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('revocation while reading a body prevents every alert mutation', async (t) => {
  const cases = [
    ['/device', { expoToken: 'ExpoPushToken[valid_token]' }],
    ['/device/forget', {}],
    ['/sources', { kind: 'custom', label: 'New source' }],
    ['/sources/:id', { label: 'Changed source' }],
    ['/sources/:id/rotate', {}],
    ['/sources/:id/delete', {}],
    ['/test', {}],
  ];
  for (const [path, fields] of cases) {
    await t.test(path, async (subtest) => {
      saveAlertsState(freshAlerts());
      const phone = await pairAlertPhone();
      const entry = source();
      const received = Promise.withResolvers();
      const base = await start(subtest, {}, received);
      const reply = Promise.withResolvers();
      const req = request(`${base}/api/mobile/v1/alerts${path.replace(':id', entry.id)}`, {
        method: 'POST', headers: { authorization: `Bearer ${phone.accessToken}`, 'content-type': 'application/json' },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => reply.resolve({ status: res.statusCode, body: JSON.parse(body) }));
        res.on('error', reply.reject);
      });
      req.on('error', reply.reject);
      subtest.after(() => req.destroy());
      req.write('{"v":1');
      await received.promise;
      assert.equal(revokeDevice(phone.deviceId).ok, true);
      const suffix = Object.entries(fields).map(([key, value]) => `,${JSON.stringify(key)}:${JSON.stringify(value)}`).join('');
      req.end(`${suffix}}`);
      const result = await reply.promise;
      assert.equal(result.status, 401);
      assert.equal(result.body.error.code, 'revoked');
      assert.deepEqual(loadAlertsState().sources, [entry]);
      assert.deepEqual(loadAlertsState().devices, []);
      assert.deepEqual(loadAlertsState().history, []);
    });
  }
});

test('revocation during address lookup prevents secret replies and source changes', async (t) => {
  const cases = [
    ['', undefined],
    ['/sources', { v: 1, kind: 'custom', label: 'New source' }],
    ['/sources/:id', { v: 1, label: 'Changed source' }],
    ['/sources/:id/rotate', { v: 1 }],
  ];
  for (const [path, body] of cases) {
    await t.test(path || 'overview', async (subtest) => {
      saveAlertsState(freshAlerts());
      const phone = await pairAlertPhone();
      const entry = source();
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      const base = await start(subtest, { address: () => { started.resolve(); return release.promise; } });
      const pending = call(base, phone, path.replace(':id', entry.id), body);
      await started.promise;
      assert.equal(revokeDevice(phone.deviceId).ok, true);
      release.resolve(INTAKE);
      const response = await pending;
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'revoked');
      assert.equal(JSON.stringify(response.body).includes(entry.secret), false);
      assert.deepEqual(loadAlertsState().sources, [entry]);
    });
  }
});

test('overview reloads sources and registrations after address lookup', async (t) => {
  const phone = await pairAlertPhone();
  const entry = source();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const base = await start(t, { address: () => { started.resolve(); return release.promise; } });
  const pending = call(base, phone);
  await started.promise;
  const secret = randomBytes(32).toString('base64url');
  updateAlertsState((state) => {
    state.sources[0].secret = secret;
    state.devices.push({ deviceId: phone.deviceId, expoToken: 'ExpoPushToken[valid_token]', name: null, registeredAt: Date.now(), lastSentAt: null, lastResult: null });
  });
  release.resolve(INTAKE);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.body.device.registered, true);
  assert.equal(response.body.sources[0].intakeUrl, `${INTAKE.baseUrl}/hooks/${secret}`);
  assert.equal(JSON.stringify(response.body).includes(entry.secret), false);
});

test('source updates recognise a deletion during address lookup', async (t) => {
  const phone = await pairAlertPhone();
  const entry = source();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const base = await start(t, { address: () => { started.resolve(); return release.promise; } });
  const pending = call(base, phone, `/sources/${entry.id}/rotate`, { v: 1 });
  await started.promise;
  updateAlertsState((state) => { state.sources = []; });
  release.resolve(INTAKE);
  const response = await pending;
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'not_found');
  assert.deepEqual(loadAlertsState().sources, []);
});
