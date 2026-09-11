import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-pair-polling-'));
process.env.DATA_DIR = dataDir;
process.env.SECRET_KEY = '12'.repeat(32);
process.env.QM_HOST = '192.168.1.20';
const { pairPage } = await import('../src/ui/pages/pair.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));
const service = { instanceId: 'radarr-one', kind: 'radarr', name: 'Radarr', port: 7878, up: true, dockerState: 'running' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(stage) {
  const model = stage === 'configure'
    ? { stage, detected: [service], draft: { services: [{ instanceId: service.instanceId, included: true, baseUrl: 'http://nas:7878' }], edgeAccess: {} }, csrf: 'fixture' }
    : { stage, bundle: { summary: [{ ...service, label: 'Radarr', hasKey: false, credentialState: 'missing-key', baseUrl: 'http://nas:7878' }], companion: { bundleId: 'fixture', expiresAt: '2099-01-01' }, setupCode: 'fixture' }, qrDataUrl: 'data:image/png;base64,AAAA', filePath: '/pair/file/fixture', csrf: 'fixture' };
  const html = pairPage(model);
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((value) => value.includes("fetch('/api/services'"));
  const marker = stage === 'configure' ? '// Surface polling failures' : '// Poll for keys';
  const block = script.slice(script.indexOf(marker), script.lastIndexOf('})();'));
  const listeners = { window: new Map(), document: new Map() };
  const intervals = new Map(), timeouts = new Map(), requests = [], failures = [], timeoutDelays = [];
  const form = { hidden: true }, message = { textContent: '' };
  const row = { dataset: {}, checked: false, baseUrl: 'http://edited-nas:7878', remoteBaseUrl: 'https://edited.example.test' };
  let nextId = 1, ok = 0, retry;
  const events = (target) => ({ addEventListener(name, fn) {
    const list = listeners[target].get(name) || []; list.push(fn); listeners[target].set(name, list);
  } });
  const document = { hidden: false, ...events('document'), getElementById: (id) => id === 'reissue' ? form : message };
  const context = {
    document, window: events('window'), AbortController,
    setInterval: (fn) => { const id = nextId++; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, delay) => { const id = nextId++; timeouts.set(id, fn); timeoutDelays.push(delay); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    fetch: (_url, options) => { const result = deferred(); requests.push({ ...result, options }); return result.promise; },
    qmLiveCheck: () => ({ ok: () => ok++, fail: (status) => failures.push(status), onRetry: (fn) => { retry = fn; } }),
    byId: { [service.instanceId]: row }, setChip: (target, state) => { target.dataset.credState = state; },
    refreshRung() {}, setAvailability: (target, availability) => { target.dataset.availability = availability; }, recount() {},
  };
  runInNewContext(block, context);
  return {
    requests, failures, intervals, timeouts, timeoutDelays, row, form, message, document, ok: () => ok,
    retry: () => retry(),
    event: (target, name) => (listeners[target].get(name) || []).forEach((fn) => fn({ persisted: true })),
    interval: () => [...intervals.values()].forEach((fn) => fn()),
    deadline: () => { for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); } },
  };
}
const good = { services: [{ ...service, credentialState: 'included', hasKey: true, storedCredential: true, availability: 'reachable' }] };
const reply = (body = good, status = 200) => ({ ok: status === 200, status, json: () => Promise.resolve(body) });

for (const stage of ['configure', 'ready']) {
  test(`${stage} coalesces interval, focus, visible and retry while preserving edits`, async () => {
    const h = harness(stage); h.retry(); await flush();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.timeoutDelays, [90000], 'slow discovery retains its bounded 90-second budget');
    for (let i = 0; i < 3; i++) { h.interval(); h.event('window', 'focus'); h.event('document', 'visibilitychange'); h.retry(); }
    await flush(); assert.equal(h.requests.length, 1);
    const body = deferred(); h.requests[0].resolve({ ok: true, json: () => body.promise }); await flush();
    h.retry(); await flush(); assert.equal(h.requests.length, 1, 'JSON body is part of the active check');
    body.resolve(good); await flush();
    assert.equal(h.ok(), 1); assert.equal(h.timeouts.size, 0);
    assert.equal(h.row.checked, false); assert.equal(h.row.baseUrl, 'http://edited-nas:7878');
    assert.equal(h.row.remoteBaseUrl, 'https://edited.example.test');
    if (stage === 'ready') { assert.equal(h.form.hidden, false); assert.match(h.message.textContent, /Radarr/); }
    h.retry(); await flush(); assert.equal(h.requests.length, 2);
  });
  test(`${stage} timeout aborts stalled headers or body and a retry owns later results`, async () => {
    for (const bodyWait of [false, true]) {
      const h = harness(stage); h.retry(); await flush();
      const old = h.requests[0], body = deferred();
      if (bodyWait) { old.resolve({ ok: true, json: () => body.promise }); await flush(); }
      h.deadline(); await flush();
      assert.equal(old.options.signal.aborted, true); assert.deepEqual(h.failures, [0]);
      h.retry(); await flush(); assert.equal(h.requests.length, 2);
      if (bodyWait) body.resolve(good); else old.resolve(reply());
      await flush(); assert.equal(h.ok(), 0, 'timed-out response cannot publish');
      h.requests[1].resolve(reply()); await flush(); assert.equal(h.ok(), 1);
    }
  });
  test(`${stage} pagehide retires work; bfcache pageshow rearms exactly once`, async () => {
    const h = harness(stage); h.retry(); await flush(); const old = h.requests[0];
    h.event('window', 'pagehide'); assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 0);
    assert.equal(old.options.signal.aborted, true);
    h.retry(); h.event('window', 'focus'); h.event('document', 'visibilitychange'); await flush();
    assert.equal(h.requests.length, 1);
    h.event('window', 'pageshow'); h.event('window', 'pageshow'); await flush();
    assert.equal(h.intervals.size, 1); assert.equal(h.requests.length, 2);
    old.resolve(reply()); await flush(); assert.equal(h.ok(), 0);
    h.retry(); await flush(); assert.equal(h.requests.length, 2, 'old finally cannot release the new check');
    h.requests[1].resolve(reply()); await flush(); assert.equal(h.ok(), 1);
    h.event('window', 'pagehide'); h.event('window', 'pageshow'); await flush();
    assert.equal(h.intervals.size, 1); assert.equal(h.requests.length, 3);
  });
  test(`${stage} refused, invalid and rejected checks finish so the next retry works`, async () => {
    const h = harness(stage);
    for (const failure of ['unauthorized', 'invalid', 'null', 'json', 'network']) {
      h.retry(); await flush(); const active = h.requests.at(-1);
      if (failure === 'network') active.reject(new Error('offline'));
      else if (failure === 'json') active.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('invalid JSON')) });
      else active.resolve(failure === 'unauthorized' ? reply({}, 401) : reply(failure === 'null' ? null : {}));
      await flush(); assert.equal(h.timeouts.size, 0);
    }
    assert.deepEqual(h.failures, [401, 0, 0, 0, 0]);
    h.retry(); await flush(); h.requests.at(-1).resolve(reply()); await flush(); assert.equal(h.ok(), 1);
    h.document.hidden = true; h.interval(); h.event('window', 'focus'); h.retry(); await flush();
    assert.equal(h.requests.length, 6);
  });
}
