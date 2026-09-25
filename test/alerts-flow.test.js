// Webhook delivery through the real listener, store and mobile routes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALERTS_SERVER, pairAlertPhone, listenForAlerts } from './helpers/alerts-fixture.mjs';

process.env.SECRET_KEY = 'dc'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-alerts-flow-'));
process.env.QM_HOST = 'nas.local';
process.env.MOBILE_API_ENABLED = 'true';

test('a paired source delivers to registered phones and stops after revocation', async (t) => {
  t.after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
  const batches = [];
  const expo = await listenForAlerts(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body);
    assert.equal(req.headers.authorization, undefined);
    batches.push(messages);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: messages.map((_, index) => ({ status: 'ok', id: `ticket-${batches.length}-${index}` })) }));
  }, t);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url) === 'https://exp.host/--/api/v2/push/send') return realFetch(expo, options);
    assert.ok(String(url).startsWith('http://127.0.0.1:'), 'test requests stay local');
    return realFetch(url, options);
  });
  const { createPanelSurface } = await import('../src/server.js');
  const { createMobileRouter } = await import('../src/mobile/routes.js');
  const { createOwnerSurface } = await import('../src/mobile/owner-plane.js');
  const { loadAlertsState } = await import('../src/alerts/store.js');
  const { loadMobileState } = await import('../src/mobile/store.js');
  const { revokeDevice } = await import('../src/mobile/devices.js');
  const plain = await listenForAlerts(createPanelSurface({ authPlane: { tls: false } }), t);
  const mobile = await listenForAlerts(createMobileRouter(ALERTS_SERVER, { enrolment: true }, createOwnerSurface()), t);
  const first = await pairAlertPhone();
  const second = await pairAlertPhone();

  async function api(path, body, phone = first) {
    const response = await fetch(`${mobile}/api/mobile/v1/alerts${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${phone.accessToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify({ v: 1, ...body }) : undefined,
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  async function webhook(source, event) {
    const response = await fetch(`${plain}${new URL(source.intakeUrl).pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }

  async function sentHistory(count) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const sent = loadAlertsState().history.filter((record) => record.outcome === 'sent');
      if (sent.length >= count) return sent;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('delivery did not finish');
  }

  await api('/device', { expoToken: 'ExpoPushToken[first_phone]' });
  await api('/device', { expoToken: 'ExpoPushToken[second_phone]' }, second);
  const { source } = await api('/sources', { kind: 'sonarr', label: 'TV', serviceId: 'sonarr:home' });
  await webhook(source, { eventType: 'Test' });
  assert.equal(batches.length, 0);
  assert.equal(loadAlertsState().history.length, 0);
  assert.ok((await api('')).sources[0].lastTestAt > 0);
  const event = { eventType: 'Download', series: { id: 7, title: 'Slow Horses', tvdbId: 123 }, episodes: [{ seasonNumber: 4, episodeNumber: 2 }], release: { quality: 'WEBDL-2160p' } };
  await webhook(source, event);
  const history = await sentHistory(1);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((message) => message.to), ['ExpoPushToken[first_phone]', 'ExpoPushToken[second_phone]']);
  for (const message of batches[0]) {
    assert.equal(message.title, 'Download complete');
    assert.equal(message.body, 'Slow Horses S04E02 has finished downloading');
    assert.deepEqual(message.data, { alertId: history[0].id, companion: loadMobileState().mobileInstallationId, kind: 'download', sourceServiceId: 'sonarr:home', target: { service: 'sonarr', id: 7, tvdbId: 123, season: 4, episode: 2 } });
  }
  assert.equal(loadAlertsState().receipts.length, 2);
  assert.equal((await api(`/sources/${source.id}/sample`)).events[0].fields.episode, 'S04E02');
  assert.deepEqual(await api('/test', { sourceId: source.id }), { v: 1, result: 'sent' });
  assert.equal(batches[1].length, 1);
  assert.equal(batches[1][0].to, 'ExpoPushToken[first_phone]');
  assert.equal(revokeDevice(first.deviceId).ok, true);
  await webhook(source, event);
  await sentHistory(3);
  assert.equal(batches[2].length, 1);
  assert.equal(batches[2][0].to, 'ExpoPushToken[second_phone]');
});
