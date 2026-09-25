// Webhook floods and source revocation during body reads.

import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { freshAlerts } from './helpers/alerts-fixture.mjs';

process.env.SECRET_KEY = 'cd'.repeat(32);
process.env.DATA_DIR = fs.mkdtempSync(join(tmpdir(), 'qm-alerts-intake-limits-'));
process.env.QM_HOST = 'nas.local';

const { config } = await import('../src/config.js');
const { handleAlertIntake, resetAlertIntakeLimiterForTest } = await import('../src/alerts/intake.js');
const { ALERTS_STATE_FILE, loadAlertsState, saveAlertsState, updateAlertsState } = await import('../src/alerts/store.js');
const { defaultEventRules } = await import('../src/alerts/schema.js');

beforeEach(() => {
  config.alertsEnabled = true;
  resetAlertIntakeLimiterForTest();
  saveAlertsState(freshAlerts());
});
after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

function source() {
  return {
    id: `src_${randomBytes(16).toString('base64url')}`, kind: 'sonarr', serviceId: null, label: 'Sonarr',
    secret: randomBytes(32).toString('base64url'), createdAt: Date.now(), lastEventAt: null, lastTestAt: null,
    events: defaultEventRules('sonarr'),
  };
}

function seed(count = 1) {
  const sources = Array.from({ length: count }, source);
  updateAlertsState((state) => {
    state.sources = sources;
    state.samples[sources[0].id] = [{
      at: Date.now(), event: 'download', fields: { series: 'A'.repeat(128 * 1024) },
      title: 'Download complete', body: 'B'.repeat(128 * 1024),
    }];
  });
  return sources;
}

function begin(secret, { peer = '127.0.0.1', forwarded = '198.51.100.1' } = {}) {
  const req = new PassThrough();
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'x-forwarded-for': forwarded };
  req.socket = { remoteAddress: peer };
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) { this.body = JSON.parse(body); },
  };
  const done = handleAlertIntake(req, res, `/hooks/${secret}`).then(() => res);
  return { req, done };
}

async function hook(secret, options = {}) {
  const { req, done } = begin(secret, options);
  req.end('{}');
  return done;
}

function watchStateWork(t) {
  const work = { reads: 0, copies: 0 };
  const read = fs.readFileSync;
  const open = fs.openSync;
  const clone = globalThis.structuredClone;
  const readSpy = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file) === ALERTS_STATE_FILE) work.reads += 1;
    return read(file, ...args);
  });
  const openSpy = t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (String(file) === ALERTS_STATE_FILE) work.reads += 1;
    return open(file, flags, ...args);
  });
  t.mock.method(globalThis, 'structuredClone', (value, ...args) => {
    if (value && Object.hasOwn(value, 'sources') && Object.hasOwn(value, 'samples')) work.copies += 1;
    return clone(value, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    readSpy.mock.restore();
    openSpy.mock.restore();
    syncBuiltinESMExports();
  });
  return work;
}

test('unknown secrets do not reread or copy the alerts payload', async (t) => {
  seed();
  const unknown = randomBytes(32).toString('base64url');
  assert.equal((await hook(unknown)).status, 404);
  const work = watchStateWork(t);
  for (let i = 0; i < 400; i += 1) {
    assert.equal((await hook(randomBytes(32).toString('base64url'))).status, 404);
  }
  assert.deepEqual(work, { reads: 0, copies: 0 });
});

test('requests over a source limit do not reread or copy the alerts payload', async (t) => {
  const [entry] = seed();
  const at = Date.now();
  t.mock.method(Date, 'now', () => at);
  for (let i = 0; i < 60; i += 1) assert.equal((await hook(entry.secret)).status, 200);
  const work = watchStateWork(t);
  for (let i = 0; i < 400; i += 1) {
    const response = await hook(entry.secret);
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers['retry-after']) >= 1);
  }
  assert.deepEqual(work, { reads: 0, copies: 0 });
});

test('the process limit refuses traffic before loading alerts state', async (t) => {
  seed();
  let at = Date.now();
  t.mock.method(Date, 'now', () => at);
  const unknown = randomBytes(32).toString('base64url');
  for (let i = 0; i < 8192; i += 1) {
    const response = await hook(unknown, { peer: `198.51.100.${i % 250 + 1}`, forwarded: `203.0.113.${i % 250 + 1}` });
    assert.equal(response.status, 404);
  }
  const saved = fs.readFileSync(ALERTS_STATE_FILE);
  fs.writeFileSync(ALERTS_STATE_FILE, '{broken');
  try {
    for (const options of [
      { peer: '192.0.2.1', forwarded: '192.0.2.2' },
      { peer: '192.0.2.1', forwarded: '192.0.2.3' },
      { peer: '192.0.2.4', forwarded: '192.0.2.5' },
    ]) {
      const response = await hook(unknown, options);
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers['retry-after']) >= 1);
    }
    at += 60_000;
    assert.equal((await hook(unknown)).status, 503);
  } finally {
    fs.writeFileSync(ALERTS_STATE_FILE, saved);
  }
});

test('all sources retain their allowance on one peer after an unknown burst', async (t) => {
  const entries = seed(64);
  const at = Date.now();
  t.mock.method(Date, 'now', () => at);
  const unknown = randomBytes(32).toString('base64url');
  for (let i = 0; i < 400; i += 1) assert.equal((await hook(unknown)).status, 404);
  for (const entry of entries) {
    for (let i = 0; i < 60; i += 1) assert.equal((await hook(entry.secret)).status, 200);
    assert.equal((await hook(entry.secret)).status, 429);
  }
});

test('rotation and deletion invalidate cached secrets during body reads', async (t) => {
  for (const action of ['rotate', 'delete']) {
    await t.test(action, async () => {
      const [entry] = seed();
      assert.equal((await hook(entry.secret)).status, 200);
      const { req, done } = begin(entry.secret);
      req.write('{"eventType":');
      assert.equal(req.listenerCount('data'), 1);
      updateAlertsState((state) => {
        if (action === 'rotate') state.sources[0].secret = randomBytes(32).toString('base64url');
        else state.sources = [];
      });
      req.end('"Test"}');
      assert.equal((await done).status, 404);
      const state = loadAlertsState();
      assert.deepEqual(state.history, []);
      assert.ok(state.sources.every((item) => item.lastTestAt === null));
    });
  }
});
