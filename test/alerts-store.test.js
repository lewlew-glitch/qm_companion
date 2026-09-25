// Alerts sidecar authentication, retention and atomic storage.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SECRET_KEY = 'ac'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-alerts-store-'));
process.env.QM_HOST = 'nas.local';

const { config } = await import('../src/config.js');
const { seal, open } = await import('../src/secrets.js');
const { ALERT_KINDS, EVENTS_BY_KIND, MAX_ALERTS_STATE_BYTES, defaultEventRules, validateEventRules, validateAlertsState } = await import('../src/alerts/schema.js');
const { parseAlert } = await import('../src/alerts/parsers.js');
let sequence = 0;

test.after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

async function freshStore() {
  rmSync(join(process.env.DATA_DIR, 'qm-alerts-v1.json'), { force: true });
  return import(`../src/alerts/store.js?test=${sequence++}`);
}

function source(kind = 'sonarr') {
  return {
    id: `src_${randomBytes(16).toString('base64url')}`, kind, serviceId: null, label: 'My Sonarr',
    secret: randomBytes(32).toString('base64url'), createdAt: 1000, lastEventAt: null, lastTestAt: null,
    events: defaultEventRules(kind),
  };
}

function history(sourceId, at = Date.now()) {
  return {
    id: `al_${randomBytes(12).toString('base64url')}`, at, sourceId, event: 'download',
    title: 'Download complete', body: 'Slow Horses S04E02 has finished downloading', outcome: 'sent',
  };
}

function device(deviceId = 'phone-one') {
  return { deviceId, expoToken: 'ExponentPushToken[abcdefgh12345678]', name: 'My iPhone', registeredAt: 1000, lastSentAt: null, lastResult: null };
}

function sample(at = Date.now()) {
  return { at, event: 'download', fields: { series: 'Slow Horses', requestedBy: 'Lewis' }, title: 'Download complete', body: 'Slow Horses is ready' };
}

function envelope(payload, context = 'qm-alerts:v1') {
  const sealed = seal(typeof payload === 'string' ? payload : JSON.stringify(payload), context);
  const mac = createHmac('sha256', config.stateKey).update('qm-alerts:v1\0').update(sealed).digest('hex');
  return JSON.stringify({ version: 1, sealed, mac });
}

function child(source, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, ...env }, encoding: 'utf8',
  });
}

function watchReads(run) {
  const read = fs.readSync;
  const clone = globalThis.structuredClone;
  const calls = { reads: 0, clones: 0 };
  fs.readSync = (...args) => { calls.reads += 1; return read(...args); };
  globalThis.structuredClone = (...args) => { calls.clones += 1; return clone(...args); };
  syncBuiltinESMExports();
  try { return run(calls); } finally {
    fs.readSync = read;
    globalThis.structuredClone = clone;
    syncBuiltinESMExports();
  }
}

test('the whole alerts payload is sealed and returns detached copies', async () => {
  const store = await freshStore();
  const initial = store.loadAlertsState();
  assert.deepEqual(initial, { sources: [], devices: [], history: [], samples: {}, throttle: {}, receipts: [] });
  const entry = source();
  const saved = store.updateAlertsState((state) => {
    state.sources.push(entry);
    state.devices.push(device());
    state.history.push(history(entry.id));
    state.samples[entry.id] = [sample()];
    state.throttle[`${entry.id}:download`] = 1000;
    state.receipts.push({ id: 'ticket-one', deviceId: 'phone-one', at: Date.now() });
  });
  const raw = readFileSync(store.ALERTS_STATE_FILE, 'utf8');
  const stored = JSON.parse(raw);
  assert.deepEqual(Object.keys(stored).sort(), ['mac', 'sealed', 'version']);
  assert.equal(stored.version, 1);
  assert.equal(stored.mac, createHmac('sha256', config.stateKey).update('qm-alerts:v1\0').update(stored.sealed).digest('hex'));
  assert.deepEqual(JSON.parse(open(stored.sealed, 'qm-alerts:v1')), saved);
  for (const secret of [entry.secret, 'Slow Horses', 'Lewis', 'abcdefgh12345678']) assert.equal(raw.includes(secret), false);
  assert.equal(statSync(store.ALERTS_STATE_FILE).mode & 0o777, 0o600);
  assert.equal(statSync(process.env.DATA_DIR).mode & 0o777, 0o700);
  assert.equal(readdirSync(process.env.DATA_DIR).includes('qm-companion.json'), false);
  const loaded = store.loadAlertsState();
  loaded.sources[0].events.download.on = false;
  saved.sources[0].label = 'Changed';
  entry.label = 'Changed again';
  assert.equal(store.loadAlertsState().sources[0].label, 'My Sonarr');
  assert.equal(store.loadAlertsState().sources[0].events.download.on, true);
  const reopened = await import(`../src/alerts/store.js?test=${sequence++}`);
  assert.deepEqual(reopened.loadAlertsState(), store.loadAlertsState());
});

test('edited, foreign and malformed sidecars are refused without replacement', async () => {
  const store = await freshStore();
  const state = store.loadAlertsState();
  const valid = readFileSync(store.ALERTS_STATE_FILE, 'utf8');
  const edited = JSON.parse(valid);
  edited.mac = '00'.repeat(32);
  const cases = [
    '{broken', 'null', '[]', JSON.stringify({ ...JSON.parse(valid), extra: true }),
    JSON.stringify({ ...JSON.parse(valid), version: 2 }), JSON.stringify(edited),
    JSON.stringify({ ...JSON.parse(valid), sealed: 'bad' }), envelope(state, 'another-sidecar'),
    envelope('{bad'), envelope({ ...state, extra: true }),
  ];
  for (const raw of cases) {
    writeFileSync(store.ALERTS_STATE_FILE, raw);
    const reader = await import(`../src/alerts/store.js?test=${sequence++}`);
    assert.throws(() => reader.loadAlertsState(), { code: 'QM_ALERTS_STATE_INVALID', status: 503 });
    assert.throws(() => reader.saveAlertsState(state), { code: 'QM_ALERTS_STATE_INVALID' });
    assert.equal(readFileSync(store.ALERTS_STATE_FILE, 'utf8'), raw);
    writeFileSync(store.ALERTS_STATE_FILE, valid);
    assert.deepEqual(reader.loadAlertsState(), state);
  }
  writeFileSync(store.ALERTS_STATE_FILE, valid);
  const foreign = child(`
    const { loadAlertsState } = await import('./src/alerts/store.js');
    try { loadAlertsState(); process.exitCode = 1; }
    catch (error) { process.stdout.write(error.code); }
  `, { SECRET_KEY: 'bd'.repeat(32) });
  assert.equal(foreign.status, 0, foreign.stderr);
  assert.equal(foreign.stdout, 'QM_ALERTS_STATE_INVALID');
  assert.equal(readFileSync(store.ALERTS_STATE_FILE, 'utf8'), valid);
});

test('history and samples retain the newest records at their limits', async () => {
  const store = await freshStore();
  const entry = source();
  const state = store.updateAlertsState((draft) => {
    draft.sources.push(entry);
    draft.history = Array.from({ length: 501 }, (_, index) => history(entry.id, index));
    draft.samples[entry.id] = Array.from({ length: 6 }, (_, index) => sample(index));
  });
  assert.equal(state.history.length, 500);
  assert.equal(state.history[0].at, 500);
  assert.equal(state.history.at(-1).at, 1);
  assert.deepEqual(state.samples[entry.id].map((record) => record.at), [5, 4, 3, 2, 1]);
  assert.equal(validateAlertsState(state).ok, true);
  const oversized = structuredClone(state);
  oversized.history.push(history(entry.id, 0));
  assert.equal(validateAlertsState(oversized).ok, false);
  const raw = envelope(oversized);
  writeFileSync(store.ALERTS_STATE_FILE, raw);
  const reader = await import(`../src/alerts/store.js?test=${sequence++}`);
  assert.throws(() => reader.loadAlertsState(), { code: 'QM_ALERTS_STATE_INVALID' });
});

test('the source cap refuses the next source and leaves stored state unchanged', async () => {
  const store = await freshStore();
  const before = store.updateAlertsState((state) => { state.sources = Array.from({ length: 64 }, () => source()); });
  assert.equal(before.sources.length, 64);
  const raw = readFileSync(store.ALERTS_STATE_FILE, 'utf8');
  assert.throws(() => store.updateAlertsState((state) => { state.sources.push(source()); }), { code: 'QM_ALERTS_STATE_INVALID' });
  assert.deepEqual(store.loadAlertsState(), before);
  assert.equal(readFileSync(store.ALERTS_STATE_FILE, 'utf8'), raw);
});

test('large custom samples retain their newest original contents within the file cap', async () => {
  const store = await freshStore();
  const entry = source('custom');
  const baseline = store.updateAlertsState((state) => {
    state.sources.push(entry);
    state.devices.push(device());
    state.history.push(history(entry.id));
    state.receipts.push({ id: 'ticket', deviceId: 'phone-one', at: Date.now() });
  });
  const expected = [];
  for (let index = 0; index < 6; index += 1) {
    const parsed = parseAlert('custom', `${index}:${'x'.repeat(900000)}`, 'Backups');
    const latest = { at: index, event: parsed.event, fields: parsed.fields, title: parsed.title, body: parsed.body };
    expected.unshift(latest);
    const saved = store.updateAlertsState((state) => {
      state.samples[entry.id] = [latest, ...(state.samples[entry.id] || [])];
    });
    assert.deepEqual(saved.samples[entry.id], expected.slice(0, 4));
    assert.ok(statSync(store.ALERTS_STATE_FILE).size <= MAX_ALERTS_STATE_BYTES);
    for (const key of ['sources', 'devices', 'history', 'receipts', 'throttle']) assert.deepEqual(saved[key], baseline[key]);
  }
  const reopened = await import(`../src/alerts/store.js?test=${sequence++}`);
  assert.deepEqual(reopened.loadAlertsState().samples[entry.id], expected.slice(0, 4));
});

test('sample eviction follows age across sources and counts escaped unicode bytes', async () => {
  const store = await freshStore();
  const first = source('custom');
  const second = source('custom');
  const parsed = parseAlert('custom', 'é\n'.repeat(225000), 'Backups');
  const sampleAt = (at) => ({ at, event: parsed.event, fields: parsed.fields, title: parsed.title, body: parsed.body });
  const state = store.updateAlertsState((draft) => {
    draft.sources.push(first, second);
    draft.samples[first.id] = [sampleAt(6), sampleAt(3), sampleAt(1)];
    draft.samples[second.id] = [sampleAt(5), sampleAt(4), sampleAt(2)];
  });
  assert.deepEqual(state.samples[first.id], [sampleAt(6), sampleAt(3)]);
  assert.deepEqual(state.samples[second.id], [sampleAt(5), sampleAt(4)]);
  assert.ok(statSync(store.ALERTS_STATE_FILE).size <= MAX_ALERTS_STATE_BYTES);
});

test('an individually oversized sample is dropped without losing the alert history', async () => {
  const store = await freshStore();
  const entry = source('custom');
  const record = history(entry.id);
  const parsed = parseAlert('custom', '\u0000'.repeat(900000), 'Backups');
  const state = store.updateAlertsState((draft) => {
    draft.sources.push(entry);
    draft.history.push(record);
    draft.samples[entry.id] = [{ at: 1, event: parsed.event, fields: parsed.fields, title: parsed.title, body: parsed.body }];
  });
  assert.deepEqual(state.samples[entry.id], []);
  assert.deepEqual(state.history, [record]);
  assert.ok(statSync(store.ALERTS_STATE_FILE).size <= MAX_ALERTS_STATE_BYTES);
});

test('byte limits do not hide invalid samples or discard other state', async () => {
  const store = await freshStore();
  const entry = source('custom');
  const before = store.updateAlertsState((state) => { state.sources.push(entry); });
  const raw = readFileSync(store.ALERTS_STATE_FILE, 'utf8');
  assert.throws(() => store.updateAlertsState((state) => {
    state.samples[entry.id] = [{ at: 1, event: 'message', fields: { invalid: 1 }, title: '', body: 'x'.repeat(MAX_ALERTS_STATE_BYTES) }];
  }), { code: 'QM_ALERTS_STATE_INVALID', message: 'Alert samples are invalid' });
  assert.throws(() => store.updateAlertsState((state) => {
    state.devices.push({ ...device(), deviceId: 'a'.repeat(MAX_ALERTS_STATE_BYTES / 2) });
  }), { code: 'QM_ALERTS_STATE_INVALID', message: 'Alerts state exceeds the size cap.' });
  assert.deepEqual(store.loadAlertsState(), before);
  assert.equal(readFileSync(store.ALERTS_STATE_FILE, 'utf8'), raw);
});

test('receipts expire after a day and retain the newest thousand', async () => {
  const store = await freshStore();
  const now = Date.now();
  const state = store.updateAlertsState((draft) => {
    draft.devices.push(device());
    draft.receipts = Array.from({ length: 1001 }, (_, index) => ({ id: `ticket-${index}`, deviceId: 'phone-one', at: now - index }));
    draft.receipts.push({ id: 'expired', deviceId: 'phone-one', at: now - 86400000 });
  });
  assert.equal(state.receipts.length, 1000);
  assert.equal(state.receipts[0].id, 'ticket-0');
  assert.equal(state.receipts.at(-1).id, 'ticket-999');
  const saved = JSON.parse(open(JSON.parse(readFileSync(store.ALERTS_STATE_FILE, 'utf8')).sealed, 'qm-alerts:v1'));
  assert.equal(saved.receipts.some((receipt) => receipt.id === 'expired'), false);
});

test('device removal clears its receipts and source removal clears samples and throttle', async () => {
  const store = await freshStore();
  const entry = source();
  store.updateAlertsState((state) => {
    state.sources.push(entry);
    state.devices.push(device(), device('phone-two'));
    state.receipts.push({ id: 'one', deviceId: 'phone-one', at: Date.now() }, { id: 'two', deviceId: 'phone-two', at: Date.now() });
    state.samples[entry.id] = [sample()];
    state.throttle[`${entry.id}:download`] = 1000;
    state.history.push(history(entry.id));
  });
  const remaining = store.removeAlertsDevice('phone-one');
  assert.deepEqual(remaining.devices.map((phone) => phone.deviceId), ['phone-two']);
  assert.deepEqual(remaining.receipts.map((receipt) => receipt.id), ['two']);
  const removed = store.updateAlertsState((state) => { state.sources = []; });
  assert.deepEqual(removed.samples, {});
  assert.deepEqual(removed.throttle, {});
  assert.equal(removed.history.length, 1);
  const empty = store.removeAllAlertsDevices();
  assert.deepEqual(empty.devices, []);
  assert.deepEqual(empty.receipts, []);
});

test('event defaults and partial replacements enforce exact rule fields and bounds', () => {
  const expected = {
    sonarr: ['download', 'failed', 'health'], radarr: ['download', 'failed', 'health'],
    seerr: ['requested', 'approved', 'available'], tracearr: ['violation', 'serverDown', 'serverUp'],
    uptimekuma: ['down', 'up'], custom: ['message'],
  };
  for (const kind of ALERT_KINDS) {
    const rules = defaultEventRules(kind);
    assert.deepEqual(Object.keys(rules), EVENTS_BY_KIND[kind]);
    assert.deepEqual(Object.entries(rules).filter(([, rule]) => rule.on).map(([event]) => event), expected[kind]);
    assert.equal(validateEventRules(kind, rules), true);
    assert.equal(validateEventRules(kind, {}), true);
    assert.equal(validateEventRules(kind, { test: rules[EVENTS_BY_KIND[kind][0]] }), false);
  }
  const rule = defaultEventRules('sonarr').download;
  assert.equal(validateEventRules('sonarr', { download: { ...rule, title: 't'.repeat(500), body: 'b'.repeat(500), throttleMinutes: 1440,
    when: Array.from({ length: 3 }, () => ({ field: 'f'.repeat(32), op: 'is', value: 'v'.repeat(200) })) } }), true);
  for (const patch of [
    { extra: true }, { on: 1 }, { title: 'a'.repeat(501) }, { body: 'a'.repeat(501) },
    { when: [{}] }, { when: [{ field: 'a'.repeat(33), op: 'is', value: '' }] },
    { when: [{ field: 'quality', op: 'is', value: 'a'.repeat(201) }] },
    { when: [{ field: 'quality', op: 'matches', value: '.*' }] },
    { when: Array.from({ length: 4 }, () => ({ field: 'name', op: 'is', value: '' })) },
    { level: 'urgent' }, { sound: 'true' }, { historyOnly: 0 },
    { throttleMinutes: -1 }, { throttleMinutes: 1441 }, { throttleMinutes: 0.5 },
  ]) assert.equal(validateEventRules('sonarr', { download: { ...rule, ...patch } }), false, JSON.stringify(patch));
  const missing = { ...rule };
  delete missing.on;
  assert.equal(validateEventRules('sonarr', { download: missing }), false);
  assert.equal(validateEventRules('constructor', {}), false);
  assert.equal(validateEventRules('sonarr', []), false);
  assert.equal(validateEventRules('sonarr', null), false);
  rule.when.push({ field: 'name', op: 'is', value: 'changed' });
  assert.deepEqual(defaultEventRules('sonarr').download.when, []);
});

test('invalid and duplicate records cannot replace the stored state', async () => {
  const store = await freshStore();
  const baseline = store.updateAlertsState((state) => {
    const entry = source();
    state.sources.push(entry);
    state.devices.push(device());
    state.history.push(history(entry.id));
    state.samples[entry.id] = [sample()];
    state.receipts.push({ id: 'ticket', deviceId: 'phone-one', at: Date.now() });
  });
  const invalidChanges = [
    (state) => { state.sources.push(structuredClone(state.sources[0])); },
    (state) => { state.sources[0].label = ''; },
    (state) => { state.sources[0].label = 'a'.repeat(65); },
    (state) => { state.sources[0].secret = 'short'; },
    (state) => { state.sources[0].serviceId = '../wrong'; },
    (state) => { state.sources[0].createdAt = -1; },
    (state) => { state.devices.push(structuredClone(state.devices[0])); },
    (state) => { state.devices[0].expoToken = 'ExpoPushToken[short]'; },
    (state) => { state.devices[0].lastResult = 'sent'; },
    (state) => { state.history.push(structuredClone(state.history[0])); },
    (state) => { state.history[0].title = 'a'.repeat(121); },
    (state) => { state.history[0].body = 'a'.repeat(1001); },
    (state) => { state.history[0].outcome = 'unknown'; },
    (state) => { state.samples[state.sources[0].id][0].fields.size = 1; },
    (state) => { state.throttle[`${state.sources[0].id}:unknown`] = 1000; },
    (state) => { state.receipts.push(structuredClone(state.receipts[0])); },
    (state) => { state.receipts[0].at = 'today'; },
    (state) => { state.receipts[0].at = -1; },
    (state) => { state.extra = null; },
  ];
  for (const mutate of invalidChanges) {
    assert.throws(() => store.updateAlertsState(mutate), { code: 'QM_ALERTS_STATE_INVALID' });
    assert.deepEqual(store.loadAlertsState(), baseline);
  }
  assert.throws(() => store.updateAlertsState(async () => {}), { code: 'QM_ALERTS_STATE_INVALID' });
  assert.throws(() => store.updateAlertsState(() => store.updateAlertsState(() => {})), { code: 'QM_ALERTS_STATE_INVALID' });
  assert.deepEqual(store.loadAlertsState(), baseline);
});

test('transactions reload changes made by another process', async () => {
  const store = await freshStore();
  store.loadAlertsState();
  const result = child(`
    const store = await import('./src/alerts/store.js');
    store.updateAlertsState((state) => { state.devices.push(${JSON.stringify(device())}); });
  `);
  assert.equal(result.status, 0, result.stderr);
  const state = store.updateAlertsState((draft) => { draft.devices.push(device('phone-two')); });
  assert.deepEqual(state.devices.map((phone) => phone.deviceId), ['phone-one', 'phone-two']);
});

test('removing devices leaves an absent sidecar absent', async () => {
  const store = await freshStore();
  assert.equal(store.removeAlertsDevice('phone-one'), null);
  assert.equal(store.removeAllAlertsDevices(), null);
  assert.deepEqual(readdirSync(process.env.DATA_DIR), []);
});

test('reads refuse changed files and recover when the sidecar is repaired or removed', async () => {
  const store = await freshStore();
  const state = store.updateAlertsState((draft) => { draft.sources.push(source()); });
  const raw = readFileSync(store.ALERTS_STATE_FILE, 'utf8');
  writeFileSync(store.ALERTS_STATE_FILE, '{broken');
  assert.throws(() => store.loadAlertsState(), { code: 'QM_ALERTS_STATE_INVALID' });
  writeFileSync(store.ALERTS_STATE_FILE, raw);
  assert.deepEqual(store.loadAlertsState(), state);
  rmSync(store.ALERTS_STATE_FILE);
  assert.deepEqual(store.loadAlertsState(), { sources: [], devices: [], history: [], samples: {}, throttle: {}, receipts: [] });
});

test('source lookups do not create an absent sidecar', async () => {
  const store = await freshStore();
  watchReads((calls) => {
    assert.equal(store.findAlertSource('a'.repeat(43)), null);
    assert.equal(store.findAlertSource('short'), null);
    assert.equal(store.findAlertSource(null), null);
    assert.deepEqual(calls, { reads: 0, clones: 0 });
  });
  assert.deepEqual(readdirSync(process.env.DATA_DIR), []);
});

test('source lookups reuse the committed index without reading or copying a large sidecar', async () => {
  const store = await freshStore();
  const entry = source('custom');
  store.updateAlertsState((state) => {
    state.sources.push(entry);
    state.samples[entry.id] = [{ at: 1, event: 'message', fields: { message: 'x'.repeat(900000) }, title: 'Backups', body: 'x'.repeat(900000) }];
  });
  assert.ok(statSync(store.ALERTS_STATE_FILE).size > 3 * 1024 * 1024);
  const expected = { id: entry.id, kind: entry.kind, label: entry.label };
  watchReads((calls) => {
    const found = store.findAlertSource(entry.secret);
    assert.deepEqual(found, expected);
    found.label = 'Changed';
    for (let index = 0; index < 100; index += 1) {
      assert.equal(store.findAlertSource(String(index).padStart(43, 'a')), null);
      assert.deepEqual(store.findAlertSource(entry.secret), expected);
    }
    assert.deepEqual(calls, { reads: 0, clones: 0 });
    store.loadAlertsState();
    assert.ok(calls.reads > 0);
    assert.ok(calls.clones > 0);
    const before = { ...calls };
    assert.deepEqual(store.findAlertSource(entry.secret), expected);
    assert.equal(store.findAlertSource('z'.repeat(43)), null);
    assert.deepEqual(calls, before);
  });
  const reader = await import(`../src/alerts/store.js?test=${sequence++}`);
  watchReads((calls) => {
    assert.equal(reader.findAlertSource('z'.repeat(43)), null);
    assert.ok(calls.reads > 0);
    assert.equal(calls.clones, 0);
    const before = { ...calls };
    assert.deepEqual(reader.findAlertSource(entry.secret), expected);
    assert.equal(reader.findAlertSource('z'.repeat(43)), null);
    assert.deepEqual(calls, before);
  });
});

test('source changes immediately refresh the index without an extra read', async () => {
  const store = await freshStore();
  const entry = source();
  store.updateAlertsState((state) => { state.sources.push(entry); });
  const secret = randomBytes(32).toString('base64url');
  store.updateAlertsState((state) => { state.sources[0].secret = secret; state.sources[0].label = 'TV'; });
  watchReads((calls) => {
    assert.equal(store.findAlertSource(entry.secret), null);
    assert.deepEqual(store.findAlertSource(secret), { id: entry.id, kind: entry.kind, label: 'TV' });
    assert.deepEqual(calls, { reads: 0, clones: 0 });
  });
  store.updateAlertsState((state) => { state.sources = []; });
  watchReads((calls) => {
    assert.equal(store.findAlertSource(secret), null);
    assert.deepEqual(calls, { reads: 0, clones: 0 });
  });
});

test('unchanged malformed files cache their refusal and repair invalidates it', async () => {
  const store = await freshStore();
  const entry = source();
  store.updateAlertsState((state) => { state.sources.push(entry); });
  const good = readFileSync(store.ALERTS_STATE_FILE, 'utf8');
  const fixedTime = new Date('2024-01-01T00:00:00Z');
  fs.utimesSync(store.ALERTS_STATE_FILE, fixedTime, fixedTime);
  assert.ok(store.findAlertSource(entry.secret));
  const before = statSync(store.ALERTS_STATE_FILE, { bigint: true });
  const bad = good.replace(/"mac": "[0-9a-f]{64}"/, `"mac": "${'0'.repeat(64)}"`);
  writeFileSync(store.ALERTS_STATE_FILE, bad);
  fs.utimesSync(store.ALERTS_STATE_FILE, fixedTime, fixedTime);
  const changed = statSync(store.ALERTS_STATE_FILE, { bigint: true });
  assert.equal(changed.size, before.size);
  assert.equal(changed.mtimeNs, before.mtimeNs);
  assert.notEqual(changed.ctimeNs, before.ctimeNs);
  watchReads((calls) => {
    assert.throws(() => store.findAlertSource(entry.secret), { code: 'QM_ALERTS_STATE_INVALID' });
    assert.ok(calls.reads > 0);
    const reads = calls.reads;
    for (let index = 0; index < 10; index += 1) {
      assert.throws(() => store.findAlertSource('z'.repeat(43)), { code: 'QM_ALERTS_STATE_INVALID' });
    }
    assert.equal(calls.reads, reads);
    assert.equal(calls.clones, 0);
    writeFileSync(store.ALERTS_STATE_FILE, good);
    fs.utimesSync(store.ALERTS_STATE_FILE, fixedTime, fixedTime);
    assert.deepEqual(store.findAlertSource(entry.secret), { id: entry.id, kind: entry.kind, label: entry.label });
    assert.ok(calls.reads > reads);
  });
});

test('source lookup detects replacement, removal and recreation of the sidecar', async () => {
  const store = await freshStore();
  const entry = source();
  const state = store.updateAlertsState((draft) => { draft.sources.push(entry); });
  const fixedTime = new Date('2024-01-01T00:00:00Z');
  fs.utimesSync(store.ALERTS_STATE_FILE, fixedTime, fixedTime);
  assert.ok(store.findAlertSource(entry.secret));
  const original = statSync(store.ALERTS_STATE_FILE, { bigint: true });
  const secret = randomBytes(32).toString('base64url');
  state.sources[0].secret = secret;
  const replacement = join(process.env.DATA_DIR, 'replacement.json');
  writeFileSync(replacement, `${JSON.stringify(JSON.parse(envelope(state)), null, 2)}\n`);
  fs.utimesSync(replacement, fixedTime, fixedTime);
  fs.renameSync(replacement, store.ALERTS_STATE_FILE);
  const changed = statSync(store.ALERTS_STATE_FILE, { bigint: true });
  assert.notEqual(changed.ino, original.ino);
  assert.equal(changed.size, original.size);
  assert.equal(changed.mtimeNs, original.mtimeNs);
  assert.equal(store.findAlertSource(entry.secret), null);
  assert.deepEqual(store.findAlertSource(secret), { id: entry.id, kind: entry.kind, label: entry.label });
  rmSync(store.ALERTS_STATE_FILE);
  assert.equal(store.findAlertSource(secret), null);
  assert.deepEqual(readdirSync(process.env.DATA_DIR), []);
  writeFileSync(store.ALERTS_STATE_FILE, envelope(state));
  assert.ok(store.findAlertSource(secret));
});

test('oversized files are refused without reading their contents and recover after repair', async () => {
  const store = await freshStore();
  const fd = fs.openSync(store.ALERTS_STATE_FILE, 'w');
  try { fs.ftruncateSync(fd, MAX_ALERTS_STATE_BYTES + 1); } finally { fs.closeSync(fd); }
  watchReads((calls) => {
    for (let index = 0; index < 10; index += 1) {
      assert.throws(() => store.findAlertSource('z'.repeat(43)), { code: 'QM_ALERTS_STATE_INVALID', message: 'Alerts state exceeds the size cap.' });
    }
    assert.throws(() => store.loadAlertsState(), { code: 'QM_ALERTS_STATE_INVALID' });
    assert.deepEqual(calls, { reads: 0, clones: 0 });
    writeFileSync(store.ALERTS_STATE_FILE, envelope({ sources: [], devices: [], history: [], samples: {}, throttle: {}, receipts: [] }));
    assert.equal(store.findAlertSource('z'.repeat(43)), null);
    assert.ok(calls.reads > 0);
  });
});

test('a replacement during reading cannot give old sources the new file stamp', async () => {
  const store = await freshStore();
  const entry = source();
  const state = store.updateAlertsState((draft) => { draft.sources.push(entry); });
  const reader = await import(`../src/alerts/store.js?test=${sequence++}`);
  const secret = randomBytes(32).toString('base64url');
  state.sources[0].secret = secret;
  const replacement = join(process.env.DATA_DIR, 'replacement.json');
  writeFileSync(replacement, envelope(state));
  const read = fs.readSync;
  let replaced = false;
  fs.readSync = (...args) => {
    const bytes = read(...args);
    if (!replaced) {
      replaced = true;
      fs.renameSync(replacement, store.ALERTS_STATE_FILE);
    }
    return bytes;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => reader.findAlertSource(entry.secret), { code: 'QM_ALERTS_STATE_INVALID' });
  } finally {
    fs.readSync = read;
    syncBuiltinESMExports();
  }
  assert.equal(reader.findAlertSource(entry.secret), null);
  assert.ok(reader.findAlertSource(secret));
});

test('a replacement after rename does not receive the committed source index', async () => {
  const store = await freshStore();
  store.loadAlertsState();
  const entry = source();
  const replacement = join(process.env.DATA_DIR, 'replacement.json');
  writeFileSync(replacement, '{broken');
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    rename(...args);
    if (args[1] === store.ALERTS_STATE_FILE) rename(replacement, store.ALERTS_STATE_FILE);
  };
  syncBuiltinESMExports();
  try { store.updateAlertsState((state) => { state.sources.push(entry); }); } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.throws(() => store.findAlertSource(entry.secret), { code: 'QM_ALERTS_STATE_INVALID' });
});

test('a failed rename preserves the committed bytes and removes its temporary file', async () => {
  const store = await freshStore();
  store.loadAlertsState();
  const raw = readFileSync(store.ALERTS_STATE_FILE, 'utf8');
  const result = child(`
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const store = await import('./src/alerts/store.js');
    store.loadAlertsState();
    fs.renameSync = () => { const error = new Error('blocked'); error.code = 'EIO'; throw error; };
    syncBuiltinESMExports();
    try { store.updateAlertsState((state) => { state.devices.push(${JSON.stringify(device())}); }); process.exitCode = 1; }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, devices: store.loadAlertsState().devices })); }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { code: 'QM_ALERTS_STATE_INVALID', devices: [] });
  assert.equal(readFileSync(store.ALERTS_STATE_FILE, 'utf8'), raw);
  assert.deepEqual(readdirSync(process.env.DATA_DIR), ['qm-alerts-v1.json']);
});

test('a directory fsync failure retains committed state and refuses further use', async () => {
  const store = await freshStore();
  store.loadAlertsState();
  const result = child(`
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const store = await import('./src/alerts/store.js');
    const original = fs.fsyncSync;
    fs.fsyncSync = (fd) => { if (fs.fstatSync(fd).isDirectory()) throw new Error('directory fsync failed'); original(fd); };
    syncBuiltinESMExports();
    const errors = [];
    try { store.updateAlertsState((state) => { state.devices.push(${JSON.stringify(device())}); }); }
    catch (error) { errors.push(error.code); }
    try { store.loadAlertsState(); } catch (error) { errors.push(error.code); }
    try { store.updateAlertsState(() => {}); } catch (error) { errors.push(error.code); }
    try { store.findAlertSource('z'.repeat(43)); } catch (error) { errors.push(error.code); }
    process.stdout.write(JSON.stringify(errors));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), Array(4).fill('QM_ALERTS_STATE_INVALID'));
  const reopened = await import(`../src/alerts/store.js?test=${sequence++}`);
  assert.deepEqual(reopened.loadAlertsState().devices, [device()]);
});
