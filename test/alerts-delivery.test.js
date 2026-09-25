// Expo requests, retries and receipt cleanup against a local server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-alerts-delivery-'));
process.env.SECRET_KEY = 'd8'.repeat(32);
process.env.DATA_DIR = dataDir;
process.env.QM_HOST = 'nas.local';

const { createAlertDelivery } = await import('../src/alerts/delivery.js');
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const INPUT = Object.freeze({
  source: { serviceId: 'sonarr:1' },
  parsed: { data: { kind: 'download', target: { service: 'sonarr', id: 4 }, downloadId: 'download:3' } },
  rule: { sound: true, level: 'timeSensitive' },
  record: { id: 'al_history', title: 'Download complete', body: 'A programme has finished downloading' },
});

async function fixture(t, overrides = {}) {
  const requests = [];
  const replies = [];
  const waits = [];
  const logs = [];
  const clock = { at: 100_000_000 };
  const settings = { alertsEnabled: true, alertsPushUrl: 'https://expo.test/send' };
  let state = { devices: [], receipts: [] };
  const mobile = { mobileInstallationId: 'mobile-installation', devices: [] };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const received = { path: req.url, method: req.method, headers: req.headers, body: JSON.parse(body) };
    requests.push(received);
    const reply = replies.shift();
    if (reply) return reply(req, res, received);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: received.body.map((_, index) => ({ status: 'ok', id: `ticket-${requests.length}-${index}` })) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const urls = [];
  const options = {
    fetchImpl: (url, init) => {
      urls.push({ url, init });
      return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
    },
    now: () => clock.at,
    wait: async (ms) => { waits.push(ms); },
    loadState: () => structuredClone(state),
    updateState: (mutate) => {
      const next = structuredClone(state);
      state = mutate(next) ?? next;
      return structuredClone(state);
    },
    loadMobile: () => structuredClone(mobile),
    settings,
    log: (line) => logs.push(line),
    ...overrides,
  };
  const delivery = createAlertDelivery(options);
  function register(id) {
    state.devices.push({ deviceId: id, expoToken: `ExpoPushToken[token_${id}]`, name: null, registeredAt: clock.at, lastSentAt: null, lastResult: null });
    mobile.devices.push({ deviceId: id, revokedAt: null, refreshAbsoluteDeadlineAt: clock.at + 86_400_000, refreshIdleDeadlineAt: clock.at + 86_400_000 });
  }
  register('device_1');
  return {
    ...delivery, requests, replies, waits, logs, clock, settings, mobile, register, urls,
    get state() { return state; },
    reply(payload, status = 200) {
      replies.push((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    },
  };
}

test('sends the complete message shape without an authorisation header', async (t) => {
  const h = await fixture(t);
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: true });
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.accept, 'application/json');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['user-agent'], 'Quartermaster-Companion');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(h.urls[0].init.redirect, 'manual');
  assert.equal(h.urls[0].init.signal instanceof AbortSignal, true);
  assert.deepEqual(request.body, [{
    to: 'ExpoPushToken[token_device_1]',
    title: INPUT.record.title,
    body: INPUT.record.body,
    sound: 'default',
    priority: 'high',
    interruptionLevel: 'time-sensitive',
    ttl: 86400,
    data: { alertId: 'al_history', companion: 'mobile-installation', kind: 'download', sourceServiceId: 'sonarr:1', target: { service: 'sonarr', id: 4 }, downloadId: 'download:3' },
  }]);
  assert.equal(h.state.devices[0].lastSentAt, h.clock.at);
  assert.equal(h.state.devices[0].lastResult, 'ok');
  assert.deepEqual(h.state.receipts, [{ id: 'ticket-1-0', deviceId: 'device_1', at: h.clock.at }]);
});

test('omits empty tap data and supports passive silent alerts', async (t) => {
  const h = await fixture(t);
  await h.deliverAlert({ ...INPUT, source: { serviceId: null }, parsed: { data: { kind: '', target: {}, downloadId: null } }, rule: { sound: false, level: 'passive' } });
  const message = h.requests[0].body[0];
  assert.equal(message.sound, null);
  assert.equal(message.priority, 'normal');
  assert.equal(message.interruptionLevel, 'passive');
  assert.deepEqual(message.data, { alertId: 'al_history', companion: 'mobile-installation' });
  await h.deliverAlert({ ...INPUT, source: null, parsed: { data: {} } });
  assert.deepEqual(h.requests[1].body[0].data, { alertId: 'al_history', companion: 'mobile-installation' });
});

test('sends at most one hundred messages per request and can select one phone', async (t) => {
  const h = await fixture(t);
  for (let index = 2; index <= 205; index += 1) h.register(`device_${index}`);
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: true });
  assert.deepEqual(h.requests.map((request) => request.body.length), [100, 100, 5]);
  assert.deepEqual(await h.deliverAlert({ ...INPUT, deviceId: 'device_2' }), { ok: true });
  assert.equal(h.requests[3].body.length, 1);
  assert.equal(h.requests[3].body[0].to, 'ExpoPushToken[token_device_2]');
});

test('handles mixed tickets and removes unregistered phones immediately', async (t) => {
  const h = await fixture(t);
  h.register('device_2');
  h.register('device_3');
  h.reply({ data: [
    { status: 'error', details: { error: 'DeviceNotRegistered' } },
    { status: 'error', details: { error: 'MessageTooBig' } },
    { status: 'ok', id: 'accepted' },
  ] });
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: true });
  assert.deepEqual(h.state.devices.map((device) => [device.deviceId, device.lastResult]), [['device_2', 'failed'], ['device_3', 'ok']]);
  assert.deepEqual(h.state.receipts, [{ id: 'accepted', deviceId: 'device_3', at: h.clock.at }]);
  assert.equal(h.logs.length, 1);
});

test('returns the expo error code when every ticket fails', async (t) => {
  const h = await fixture(t);
  h.reply({ data: [{ status: 'error', details: { error: 'InvalidCredentials' } }] });
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'InvalidCredentials' });
  assert.equal(h.state.devices[0].lastResult, 'failed');
  assert.equal(h.state.receipts.length, 0);
});

test('retries network failures and server errors only once after thirty seconds', async (t) => {
  for (const status of [null, 500, 503]) {
    await t.test(status === null ? 'network failure' : `status ${status}`, async (child) => {
      const h = await fixture(child);
      if (status === null) h.replies.push((req) => req.socket.destroy());
      else h.reply({ errors: [{ code: 'SERVER_ERROR' }] }, status);
      assert.deepEqual(await h.deliverAlert(INPUT), { ok: true });
      assert.equal(h.requests.length, 2);
      assert.deepEqual(h.waits, [30_000]);
    });
  }
  const h = await fixture(t);
  h.reply({}, 503);
  h.reply({}, 503);
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'HTTP_503' });
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.waits, [30_000]);
  assert.equal(h.state.devices[0].lastResult, 'failed');
});

test('does not retry client errors or follow redirects', async (t) => {
  for (const status of [400, 401, 429]) {
    await t.test(`status ${status}`, async (child) => {
      const h = await fixture(child);
      h.reply({ errors: [{ code: 'UNAUTHORIZED' }] }, status);
      assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'UNAUTHORIZED' });
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.waits, []);
    });
  }
  const h = await fixture(t);
  h.replies.push((_req, res) => {
    res.writeHead(302, { location: '/should-not-follow' });
    res.end();
  });
  assert.equal((await h.deliverAlert(INPUT)).ok, false);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.waits, []);
  assert.equal(h.requests.every((request) => request.path === '/send'), true);
});

test('keeps the http retry decision when the response body fails', async (t) => {
  for (const [status, body] of [[400, 'stalled'], [302, 'stalled'], [503, 'stalled'], [503, 'oversized'], [503, 'malformed']]) {
    await t.test(`status ${status}, ${body} body`, async (child) => {
      const h = await fixture(child, { timeoutMs: 50 });
      h.replies.push((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
        res.write('{');
        if (body === 'oversized') res.end('x'.repeat(256 * 1024));
        if (body === 'malformed') res.end('broken');
      });
      const result = await h.deliverAlert(INPUT);
      if (status === 503) {
        assert.deepEqual(result, { ok: true });
        assert.equal(h.requests.length, 2);
        assert.deepEqual(h.waits, [30_000]);
      } else {
        assert.deepEqual(result, { ok: false, detail: 'Timeout' });
        assert.equal(h.requests.length, 1);
        assert.deepEqual(h.waits, []);
        assert.deepEqual(h.logs, [`  alerts: delivery failed (${status})\n`]);
      }
    });
  }
});

test('rechecks revocation before retrying and excludes expired or absent pairings', async (t) => {
  let h;
  h = await fixture(t, { wait: async () => { h.mobile.devices[0].revokedAt = h.clock.at; } });
  h.reply({}, 503);
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'not-registered' });
  assert.equal(h.requests.length, 1);
  h.register('device_2');
  h.register('device_3');
  h.mobile.devices.find((device) => device.deviceId === 'device_2').refreshIdleDeadlineAt = h.clock.at;
  h.mobile.devices = h.mobile.devices.filter((device) => device.deviceId !== 'device_3');
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'not-registered' });
  assert.equal(h.requests.length, 1);
});

test('does not apply a stale ticket to a replaced registration', async (t) => {
  const h = await fixture(t);
  h.replies.push((_req, res) => {
    h.state.devices[0].expoToken = 'ExpoPushToken[replacement]';
    res.end(JSON.stringify({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }));
  });
  assert.equal((await h.deliverAlert(INPUT)).ok, false);
  assert.equal(h.state.devices.length, 1);
  assert.equal(h.state.devices[0].expoToken, 'ExpoPushToken[replacement]');
  assert.equal(h.state.devices[0].lastResult, null);
});

test('does not send requests while disabled including a pending retry', async (t) => {
  let h;
  h = await fixture(t, { wait: async () => { h.settings.alertsEnabled = false; } });
  h.settings.alertsEnabled = false;
  h.state.receipts.push({ id: 'old', deviceId: 'device_1', at: h.clock.at - 900_001 });
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'disabled' });
  await h.checkAlertReceipts();
  assert.equal(h.requests.length, 0);
  h.settings.alertsEnabled = true;
  h.reply({}, 503);
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'disabled' });
  assert.equal(h.requests.length, 1);
});

test('checks old receipts, removes unregistered phones and drops every checked id', async (t) => {
  const h = await fixture(t);
  h.register('device_2');
  h.state.receipts.push(
    { id: 'gone', deviceId: 'device_1', at: h.clock.at - 900_001 },
    { id: 'ok', deviceId: 'device_2', at: h.clock.at - 900_001 },
    { id: 'missing', deviceId: 'device_2', at: h.clock.at - 900_001 },
    { id: 'recent', deviceId: 'device_2', at: h.clock.at },
    { id: 'expired', deviceId: 'device_2', at: h.clock.at - 86_400_000 },
  );
  h.reply({ data: { gone: { status: 'error', details: { error: 'DeviceNotRegistered' } }, ok: { status: 'ok' } } });
  await h.checkAlertReceipts();
  assert.equal(h.urls[0].url, 'https://exp.host/--/api/v2/push/getReceipts');
  assert.deepEqual(h.requests[0].body, { ids: ['gone', 'ok', 'missing'] });
  assert.equal(h.requests[0].headers.authorization, undefined);
  assert.deepEqual(h.state.devices.map((device) => device.deviceId), ['device_2']);
  assert.deepEqual(h.state.receipts.map((receipt) => receipt.id), ['recent']);
  await h.checkAlertReceipts();
  assert.equal(h.requests.length, 1);
});

test('limits receipt batches and drops revoked devices without contacting expo', async (t) => {
  const h = await fixture(t);
  h.state.receipts = Array.from({ length: 1005 }, (_, index) => ({ id: `receipt-${index}`, deviceId: 'device_1', at: h.clock.at - 900_001 }));
  h.reply({ data: {} });
  await h.checkAlertReceipts();
  assert.equal(h.requests[0].body.ids.length, 1000);
  assert.equal(h.state.receipts.length, 5);
  h.mobile.devices[0].revokedAt = h.clock.at;
  await h.checkAlertReceipts();
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.receipts.length, 0);
});

test('rechecks registrations before retrying receipt requests', async (t) => {
  let h;
  h = await fixture(t, { wait: async () => { h.state.devices = []; } });
  h.state.receipts.push({ id: 'receipt', deviceId: 'device_1', at: h.clock.at - 900_001 });
  h.reply({}, 503);
  await h.checkAlertReceipts();
  assert.equal(h.requests.length, 1);
});

test('caps responses including streamed bodies and rejects malformed tickets', async (t) => {
  for (const declared of [true, false]) {
    await t.test(declared ? 'declared size' : 'streamed size', async (child) => {
      const h = await fixture(child);
      h.replies.push((_req, res) => {
        if (declared) res.setHeader('content-length', 256 * 1024 + 1);
        else res.setHeader('transfer-encoding', 'chunked');
        res.write('x'.repeat(128 * 1024));
        res.end('x'.repeat(128 * 1024 + 1));
      });
      assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'ResponseTooLarge' });
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.waits, []);
    });
  }
  const h = await fixture(t);
  h.reply({ data: [{ status: 'ok' }] });
  assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'InvalidResponse' });
  assert.deepEqual(h.state.receipts, []);
});

test('times out headers and bodies with the same request deadline', async (t) => {
  for (const sendHeaders of [false, true]) {
    await t.test(sendHeaders ? 'body deadline' : 'header deadline', async (child) => {
      const h = await fixture(child, { timeoutMs: 25 });
      for (let index = 0; index < 2; index += 1) h.replies.push((_req, res) => {
        if (sendHeaders) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{');
        }
      });
      assert.deepEqual(await h.deliverAlert(INPUT), { ok: false, detail: 'Timeout' });
      assert.equal(h.requests.length, 2);
      assert.deepEqual(h.waits, [30_000]);
    });
  }
});

test('logs only a sanitised status or code at most once per minute', async (t) => {
  const h = await fixture(t);
  for (let index = 0; index < 3; index += 1) {
    h.reply({ data: [{ status: 'error', message: INPUT.record.body, details: { error: 'private_text' } }] });
    await h.deliverAlert(INPUT);
    if (index === 1) h.clock.at += 60_000;
  }
  assert.deepEqual(h.logs, ['  alerts: delivery failed (DeliveryFailed)\n', '  alerts: delivery failed (DeliveryFailed)\n']);
});
