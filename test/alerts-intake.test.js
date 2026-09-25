// Plain listener webhook parsing, limits and event recording.

import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { listenForAlerts, freshAlerts } from './helpers/alerts-fixture.mjs';

process.env.SECRET_KEY = 'bc'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-alerts-intake-'));
process.env.QM_HOST = 'nas.local';

const { config } = await import('../src/config.js');
const { createPanelSurface } = await import('../src/server.js');
const { resetAlertIntakeLimiterForTest } = await import('../src/alerts/intake.js');
const { loadAlertsState, saveAlertsState, updateAlertsState } = await import('../src/alerts/store.js');
const { defaultEventRules } = await import('../src/alerts/schema.js');

beforeEach(() => {
  config.alertsEnabled = true;
  process.env.MOBILE_API_ENABLED = 'false';
  resetAlertIntakeLimiterForTest();
  saveAlertsState(freshAlerts());
});
after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

function addSource(kind = 'sonarr', rule) {
  const events = defaultEventRules(kind);
  if (rule) Object.assign(events[Object.keys(events)[0]], rule);
  const source = { id: `src_${randomBytes(16).toString('base64url')}`, kind, serviceId: null, label: 'Home', secret: randomBytes(32).toString('base64url'), createdAt: Date.now(), lastEventAt: null, lastTestAt: null, events };
  updateAlertsState((state) => { state.sources.push(source); });
  return source;
}

async function start(t) {
  return listenForAlerts(createPanelSurface({ authPlane: { tls: false } }), t);
}

async function hook(base, source, body, type = 'application/json', method = 'POST') {
  const response = await fetch(`${base}/hooks/${source.secret}`, {
    method, headers: type ? { 'content-type': type } : {},
    body: method === 'GET' ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), redirect: 'manual',
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const download = { eventType: 'Download', series: { id: 7, title: 'Slow Horses' }, episodes: [{ seasonNumber: 4, episodeNumber: 2 }], release: { quality: 'WEBDL-2160p' } };

test('secret routes run before setup and plaintext refusal in either mobile profile', async (t) => {
  const base = await start(t);
  const source = addSource();
  for (const enabled of ['false', 'true']) {
    process.env.MOBILE_API_ENABLED = enabled;
    const response = await hook(base, source, { eventType: 'Test' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
    assert.equal(response.headers.has('location'), false);
  }
  const saved = loadAlertsState();
  assert.ok(saved.sources[0].lastTestAt > 0);
  assert.equal(saved.sources[0].lastEventAt, null);
  assert.deepEqual(saved.history, []);
  assert.deepEqual(saved.samples, {});
});

test('unknown, rotated and disabled addresses return 404 without a redirect', async (t) => {
  const base = await start(t);
  const source = addSource();
  assert.equal((await hook(base, { secret: randomBytes(32).toString('base64url') }, download)).status, 404);
  assert.equal((await hook(base, { secret: 'short' }, download)).status, 404);
  updateAlertsState((state) => { state.sources[0].secret = randomBytes(32).toString('base64url'); });
  assert.equal((await hook(base, source, download)).status, 404);
  const rotated = loadAlertsState().sources[0];
  assert.equal((await hook(base, rotated, download)).status, 200);
  config.alertsEnabled = false;
  assert.equal((await hook(base, rotated, download)).status, 404);
});

test('known addresses require post, cap bytes and limit each source separately', async (t) => {
  const base = await start(t);
  const source = addSource('custom');
  const other = addSource('custom');
  const wrongMethod = await hook(base, source, '', 'text/plain', 'GET');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  const oversized = await hook(base, source, 'é'.repeat(524289), 'text/plain');
  assert.equal(oversized.status, 413);
  resetAlertIntakeLimiterForTest();
  for (let i = 0; i < 60; i += 1) assert.equal((await hook(base, source, {})).status, 200);
  const refused = await hook(base, source, {});
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal((await hook(base, other, {})).status, 200);
});

test('json, form fields, multipart payload and custom text reach their parsers', async (t) => {
  const base = await start(t);
  const sonarr = addSource();
  assert.equal((await hook(base, sonarr, download, 'text/plain')).status, 200);
  assert.equal((await hook(base, sonarr, JSON.stringify(download), '')).status, 200);
  assert.equal((await hook(base, sonarr, new URLSearchParams({ payload: JSON.stringify(download) }).toString(), 'application/x-www-form-urlencoded')).status, 200);
  const multipart = new FormData();
  multipart.set('payload', JSON.stringify(download));
  multipart.set('attachment', new Blob(['ignored']), 'attachment.txt');
  const uploaded = await fetch(`${base}/hooks/${sonarr.secret}`, { method: 'POST', body: multipart });
  assert.equal(uploaded.status, 200);
  await uploaded.text();
  assert.equal(loadAlertsState().samples[sonarr.id].length, 4);
  const seerr = addSource('seerr');
  assert.equal((await hook(base, seerr, new URLSearchParams({ notification_type: 'MEDIA_PENDING', subject: 'A film', username: 'Lewis' }).toString(), 'application/x-www-form-urlencoded')).status, 200);
  const custom = addSource('custom');
  await hook(base, custom, 'Backup finished', 'text/plain');
  assert.equal(loadAlertsState().history[0].body, 'Backup finished');
  assert.equal(loadAlertsState().history[0].title, 'Home');
  for (const text of ['123', 'true', 'null']) {
    await hook(base, custom, text, 'text/plain');
    assert.equal(loadAlertsState().history[0].body, text);
  }
});

test('service tests only update lastTestAt and unknown bodies are dropped', async (t) => {
  const base = await start(t);
  for (const [kind, body] of [
    ['sonarr', { eventType: 'Test' }], ['radarr', { eventType: 'Test' }],
    ['seerr', { notification_type: 'TEST_NOTIFICATION' }], ['tracearr', { event: 'test', data: {} }],
    ['uptimekuma', { heartbeat: null, monitor: null }],
  ]) {
    const source = addSource(kind);
    assert.equal((await hook(base, source, body)).status, 200);
    const saved = loadAlertsState().sources.find((item) => item.id === source.id);
    assert.ok(saved.lastTestAt > 0, kind);
    assert.equal(saved.lastEventAt, null, kind);
    assert.equal((await hook(base, source, { unrecognised: true })).status, 200);
  }
  assert.deepEqual(loadAlertsState().history, []);
  assert.deepEqual(loadAlertsState().samples, {});
});

test('samples retain standard wording when rules drop or customise the alert', async (t) => {
  const base = await start(t);
  const source = addSource('sonarr', { on: false });
  await hook(base, source, download);
  assert.equal(loadAlertsState().history.length, 0);
  assert.equal(loadAlertsState().samples[source.id].length, 1);
  updateAlertsState((state) => {
    Object.assign(state.sources[0].events.download, { on: true, body: '{series} {episode} is ready in {quality}', historyOnly: true, when: [{ field: 'quality', op: 'contains', value: '2160p' }], throttleMinutes: 5 });
  });
  await hook(base, source, { ...download, release: { quality: 'WEBDL-1080p' } });
  assert.equal(loadAlertsState().history[0].outcome, 'filtered');
  await hook(base, source, download);
  assert.equal(loadAlertsState().history[0].outcome, 'historyOnly');
  assert.equal(loadAlertsState().history[0].body, 'Slow Horses S04E02 is ready in WEBDL-2160p');
  assert.equal(loadAlertsState().samples[source.id][0].body, 'Slow Horses S04E02 has finished downloading');
  await hook(base, source, download);
  assert.equal(loadAlertsState().history[0].outcome, 'throttled');
});

test('webhook bodies, secrets and tokens never enter stdout or stderr', async (t) => {
  const base = await start(t);
  const source = addSource('custom');
  const marker = 'private alert text ExpoPushToken[private_token]';
  const writes = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const stdout = t.mock.method(process.stdout, 'write', (chunk, ...args) => { writes.push(String(chunk)); return writeOut(chunk, ...args); });
  const stderr = t.mock.method(process.stderr, 'write', (chunk, ...args) => { writes.push(String(chunk)); return writeErr(chunk, ...args); });
  try {
    await hook(base, source, marker, 'text/plain');
    await hook(base, source, '{"invalid":', 'application/json');
    await hook(base, { secret: randomBytes(32).toString('base64url') }, marker, 'text/plain');
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
  }
  assert.equal(writes.join('').includes(marker), false);
  assert.equal(writes.join('').includes(source.secret), false);
  assert.equal(writes.join('').includes('private_token'), false);
});
