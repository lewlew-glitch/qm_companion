// Mobile alerts routes, registration and pairing authority.

import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ALERTS_SERVER, pairAlertPhone, listenForAlerts, freshAlerts } from './helpers/alerts-fixture.mjs';

process.env.SECRET_KEY = 'cd'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-alerts-routes-'));
process.env.QM_HOST = 'nas.local';

const { config } = await import('../src/config.js');
const { createMobileRouter, resetMobileLimitersForTest } = await import('../src/mobile/routes.js');
const { createOwnerSurface } = await import('../src/mobile/owner-plane.js');
const { createAlertsRouter } = await import('../src/alerts/routes.js');
const { alertIntakeAddress } = await import('../src/alerts/address.js');
const { defaultEventRules } = await import('../src/alerts/schema.js');
const { loadAlertsState, saveAlertsState, updateAlertsState, ALERTS_STATE_FILE } = await import('../src/alerts/store.js');
const { revokeDevice, revokeAllDevices, forgetDevice, listDevices } = await import('../src/mobile/devices.js');
const { devicesGrid } = await import('../src/ui/pages/devices.js');
const { getAuditLog } = await import('../src/store.js');

let phone;
let restricted;
before(async () => {
  phone = await pairAlertPhone();
  restricted = await pairAlertPhone(['summary.read']);
});
beforeEach(() => {
  config.alertsEnabled = true;
  resetMobileLimitersForTest();
  saveAlertsState(freshAlerts());
});
after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

async function start(t, options) {
  if (options) {
    const alerts = createAlertsRouter({ address: async () => ({ baseUrl: 'http://nas.local:8787', localOnly: true }), ...options });
    return listenForAlerts((req, res) => alerts(req, res, new URL(req.url, 'http://x')), t);
  }
  return listenForAlerts(createMobileRouter(ALERTS_SERVER, { enrolment: true }, createOwnerSurface()), t);
}

async function call(base, path = '', body, grant = phone, method) {
  const response = await fetch(`${base}/api/mobile/v1/alerts${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(grant ? { authorization: `Bearer ${grant.accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function source(base, extra = {}) {
  const reply = await call(base, '/sources', { v: 1, kind: 'sonarr', label: 'Sonarr', serviceId: 'sonarr:home', ...extra });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.source;
}

test('paired phones manage sources and the overview without an owner session', async (t) => {
  const base = await start(t);
  const initial = await call(base);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store, max-age=0');
  assert.deepEqual(initial.body.device, { registered: false, lastSentAt: null, lastResult: null });
  assert.deepEqual(initial.body.intake, { baseUrl: 'http://nas.local:8787', localOnly: true });
  const created = await source(base);
  assert.match(created.id, /^src_[A-Za-z0-9_-]{22}$/);
  assert.match(created.intakeUrl, /^http:\/\/nas.local:8787\/hooks\/[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(created, 'secret'), false);
  assert.deepEqual(created.events, defaultEventRules('sonarr'));
  const rule = { ...created.events.download, body: '{series} {episode} is ready', when: [{ field: 'quality', op: 'contains', value: '2160p' }] };
  const changed = await call(base, `/sources/${created.id}`, { v: 1, label: 'TV', events: { download: rule } });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.source.events.download, rule);
  assert.deepEqual(changed.body.source.events.health, created.events.health);
  assert.equal(changed.body.source.label, 'TV');
  const rotated = await call(base, `/sources/${created.id}/rotate`, { v: 1 });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.source.intakeUrl, created.intakeUrl);
  assert.deepEqual((await call(base, `/sources/${created.id}/sample`)).body, { v: 1, events: [] });
  assert.equal((await call(base)).body.sources.length, 1);
  assert.deepEqual((await call(base, `/sources/${created.id}/delete`, { v: 1 })).body, { v: 1 });
  assert.equal((await call(base, `/sources/${created.id}/sample`)).status, 404);
  assert.equal((await call(base)).body.sources.length, 0);
  const audit = JSON.stringify(getAuditLog());
  assert.equal(audit.includes(created.intakeUrl.split('/').at(-1)), false);
  assert.equal(audit.includes(rotated.body.source.intakeUrl.split('/').at(-1)), false);
});

test('registration replaces one phone token and clears its old receipts', async (t) => {
  const base = await start(t);
  assert.deepEqual((await call(base, '/device', { v: 1, expoToken: 'ExpoPushToken[first_token]', name: 'Kitchen' })).body, { v: 1, registered: true });
  updateAlertsState((state) => { state.receipts.push({ id: 'old-ticket', deviceId: phone.deviceId, at: Date.now() }); });
  assert.equal((await call(base, '/device', { v: 1, expoToken: 'ExponentPushToken[second_token]' })).status, 200);
  assert.equal(loadAlertsState().devices.length, 1);
  assert.equal(loadAlertsState().devices[0].expoToken, 'ExponentPushToken[second_token]');
  assert.deepEqual(loadAlertsState().receipts, []);
  assert.equal((await call(base)).body.device.registered, true);
  assert.equal(listDevices().find((device) => device.deviceId === phone.deviceId).alertsOn, true);
  const markup = devicesGrid({ plane: { ok: false }, enrolments: [], identity: null, devices: listDevices() }, 'csrf');
  assert.match(markup, /Alerts on/);
  assert.equal(markup.includes('second_token'), false);
  assert.deepEqual((await call(base, '/device/forget', { v: 1 })).body, { v: 1, registered: false });
  assert.equal((await call(base)).body.device.registered, false);
});

test('scope, bearer and exact-key checks reject invalid requests', async (t) => {
  const base = await start(t);
  assert.equal((await call(base, '', undefined, null)).status, 401);
  assert.equal((await call(base, '', undefined, restricted)).status, 403);
  assert.equal((await call(base, '', undefined, { accessToken: phone.refreshGrant })).status, 401);
  const created = await source(base);
  const invalidBodies = [
    ['/device', { v: 1, expoToken: 'ExpoPushToken[short]' }],
    ['/device', { v: 1, expoToken: 'ExpoPushToken[valid_token]', extra: true }],
    ['/device/forget', { v: 1, extra: true }],
    ['/sources', { v: 1, kind: 'unknown', label: 'Source' }],
    ['/sources', { v: 1, kind: 'sonarr', label: 'Source', serviceId: 'bad/id' }],
    ['/sources', { v: 1, kind: 'sonarr', label: 'Source', events: { down: defaultEventRules('uptimekuma').down } }],
    ['/sources', { v: 1, kind: 'sonarr', label: 'Source', events: { download: { on: true } } }],
    [`/sources/${created.id}`, { v: 1, secret: 'new' }],
    [`/sources/${created.id}/rotate`, { v: 1, label: 'No' }],
    [`/sources/${created.id}/delete`, { v: 2 }],
    ['/test', { v: 1, sourceId: 1 }],
    ['/test', { v: 1, extra: true }],
  ];
  for (const [path, body] of invalidBodies) {
    const response = await call(base, path, body);
    assert.equal(response.status, 400, path);
    assert.equal(response.body.error.code, 'invalid_request');
  }
  for (const key of ['title', 'body', 'when', 'level', 'sound', 'historyOnly', 'throttleMinutes']) {
    const rule = { ...created.events.download };
    delete rule[key];
    assert.equal((await call(base, `/sources/${created.id}`, { v: 1, events: { download: rule } })).status, 400);
  }
  assert.equal((await call(base, '/history?limit=201')).status, 400);
  assert.equal((await call(base, '/history?limit=0')).status, 400);
  assert.equal((await call(base, '/history?before=invalid')).status, 400);
});

test('history pagination and samples return their saved order', async (t) => {
  const base = await start(t);
  const created = await source(base);
  const at = Date.now();
  updateAlertsState((state) => {
    state.history = Array.from({ length: 3 }, (_, index) => ({ id: `al_${randomBytes(12).toString('base64url')}`, at: at - index, sourceId: created.id, event: 'download', title: 'Download complete', body: 'An episode', outcome: 'noDevices' }));
    state.samples[created.id] = [{ at, event: 'download', fields: { series: 'Slow Horses' }, title: 'Download complete', body: 'An episode' }];
  });
  const page = await call(base, '/history?limit=2');
  assert.equal(page.body.items.length, 2);
  assert.equal(page.body.next, page.body.items[1].id);
  const last = await call(base, `/history?limit=2&before=${page.body.next}`);
  assert.equal(last.body.items.length, 1);
  assert.equal(last.body.next, null);
  assert.equal((await call(base, `/sources/${created.id}/sample`)).body.events[0].fields.series, 'Slow Horses');
});

test('test sends target only the caller and record each result', async (t) => {
  const delivered = [];
  let outcome = { ok: true };
  const base = await start(t, { deliver: async (input) => { delivered.push(input); return outcome; } });
  const created = await source(base);
  assert.equal((await call(base, '/test', { v: 1 })).body.result, 'not-registered');
  await call(base, '/device', { v: 1, expoToken: 'ExpoPushToken[valid_token]' });
  assert.deepEqual((await call(base, '/test', { v: 1, sourceId: created.id })).body, { v: 1, result: 'sent' });
  assert.equal(delivered[0].deviceId, phone.deviceId);
  assert.equal(delivered[0].record.title, 'Test from Sonarr');
  assert.equal(delivered[0].record.body, 'Alerts from this source reach this iPhone.');
  outcome = { ok: false, detail: 'DeviceNotRegistered' };
  assert.deepEqual((await call(base, '/test', { v: 1 })).body, { v: 1, result: 'failed', detail: 'DeviceNotRegistered' });
  assert.equal(delivered[1].record.title, 'Quartermaster');
  assert.equal(delivered[1].record.body, 'Alerts from your Companion reach this iPhone.');
  assert.equal(loadAlertsState().history.length, 3);
  assert.ok(loadAlertsState().history.every((item) => item.event === 'test'));
});

test('disabled alerts keep their capability and overview but refuse other routes', async (t) => {
  const base = await start(t);
  config.alertsEnabled = false;
  const meta = await fetch(`${base}/api/mobile/v1/meta`, { headers: { authorization: `Bearer ${phone.accessToken}` } });
  assert.ok((await meta.json()).capabilities.includes('alerts.v1'));
  assert.equal((await call(base)).body.enabled, false);
  for (const [path, body] of [['/device', { v: 1 }], ['/device/forget', { v: 1 }], ['/sources', { v: 1 }], ['/history', undefined], ['/test', { v: 1 }]]) {
    const response = await call(base, path, body);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'alerts_disabled');
  }
});

test('all alert routes share a sixty-request limit per phone', async (t) => {
  const base = await start(t);
  for (let i = 0; i < 60; i += 1) assert.equal((await call(base, i % 2 ? '/history' : '')).status, 200);
  const last = await call(base, '/test', { v: 1 });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});

test('revoking, forgetting and revoking all devices remove registrations', async (t) => {
  const base = await start(t);
  const paired = await pairAlertPhone();
  await call(base, '/device', { v: 1, expoToken: 'ExpoPushToken[valid_token]' }, paired);
  assert.equal(revokeDevice(paired.deviceId).ok, true);
  assert.equal(loadAlertsState().devices.length, 0);
  assert.equal((await call(base, '', undefined, paired)).body.error.code, 'revoked');
  updateAlertsState((state) => { state.devices.push({ deviceId: paired.deviceId, expoToken: 'ExpoPushToken[valid_token]', name: null, registeredAt: Date.now(), lastSentAt: null, lastResult: null }); });
  assert.equal(forgetDevice(paired.deviceId).ok, true);
  assert.equal(loadAlertsState().devices.length, 0);
  await call(base, '/device', { v: 1, expoToken: 'ExpoPushToken[valid_token]' });
  assert.equal(revokeAllDevices().ok, true);
  assert.equal(loadAlertsState().devices.length, 0);
  phone = await pairAlertPhone();
});

test('an edited sidecar returns alerts unavailable and is not overwritten', async (t) => {
  const base = await start(t);
  const good = readFileSync(ALERTS_STATE_FILE);
  writeFileSync(ALERTS_STATE_FILE, '{"version":1}');
  try {
    const response = await call(base, '/device', { v: 1, expoToken: 'ExpoPushToken[valid_token]' });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'alerts_unavailable');
    assert.equal(readFileSync(ALERTS_STATE_FILE, 'utf8'), '{"version":1}');
  } finally { writeFileSync(ALERTS_STATE_FILE, good); }
});

test('intake addresses use the current container published port and safe fallbacks', async () => {
  const settings = { qmHost: '[fd00::1]', port: 8787, bind: '::1' };
  const mapped = await alertIntakeAddress({ settings, containerId: 'self', inspect: async (id) => {
    assert.equal(id, 'self');
    return { NetworkSettings: { Ports: { '8787/tcp': [{ HostPort: '18787' }] } } };
  } });
  assert.deepEqual(mapped, { baseUrl: 'http://[fd00::1]:18787', localOnly: true });
  assert.equal((await alertIntakeAddress({ settings, inspect: async () => null })).baseUrl, 'http://[fd00::1]:8787');
  assert.equal((await alertIntakeAddress({ settings: { ...settings, qmHost: '', bind: '0.0.0.0' } })).baseUrl, null);
});
