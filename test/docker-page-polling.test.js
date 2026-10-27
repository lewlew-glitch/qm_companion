import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-docker-page-polling-'));
process.env.DATA_DIR = dataDir;
process.env.SECRET_KEY = '24'.repeat(32);
process.env.QM_HOST = '192.168.1.20';
const { dashboardPage } = await import('../src/ui/pages/dashboard.js');
const { containersPage } = await import('../src/ui/pages/containers.js');
const { stacksPage } = await import('../src/ui/pages/stacks.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const stats = { stats: [{ id: 'one', cpu: null, mem: 25, memUsed: 1024, memLimit: 4096, net: { rx: 8, tx: 4 }, disk: { read: 2, write: 1 } }] };
function element(dataset = {}) {
  const listeners = new Map();
  return {
    dataset, textContent: '·', innerHTML: '', style: {}, attributes: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { listeners.set(name, fn); },
    event(name) { listeners.get(name)?.(); },
  };
}
function source(page) {
  const html = page === 'dashboard'
    ? dashboardPage([], { now: [], arr: [] }, { counts: { total: 1, running: 1 }, info: {}, events: [], containers: [] }, 'fixture')
    : page === 'containers' ? containersPage([{ id: 'one', name: 'One', image: 'example/app', state: 'running', ports: [], labels: {} }], false, 'fixture') : stacksPage([], false, 'fixture');
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((value) => value.includes("fetch('/api/" + (page === 'dashboard' ? 'docker' : 'containers') + '/stats'));
  assert.ok(script, `${page} has its metrics script`);
  if (page === 'containers') return script.slice(0, script.indexOf('var panel =')) + '\n})();';
  if (page === 'stacks') return script.slice(script.indexOf('function fb('), script.indexOf('// Read update state'));
  return script;
}
function harness(page, { hidden = false, live = true, detail = false } = {}) {
  const requests = [], intervals = [], documentListeners = new Map(), windowListeners = new Map();
  const ids = new Map(), selectors = new Map();
  let liveOptions;
  const document = {
    hidden, getElementById: (id) => ids.get(id) || null,
    querySelector: (selector) => selector === 'meta[name=csrf]' ? { content: 'fixture-csrf' } : null,
    querySelectorAll: (selector) => selectors.get(selector) || [],
    addEventListener(name, fn) { const list = documentListeners.get(name) || []; list.push(fn); documentListeners.set(name, list); },
  };
  const window = { addEventListener(name, fn) { const list = windowListeners.get(name) || []; list.push(fn); windowListeners.set(name, list); } };
  const context = {
    document, window,
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })); },
  };
  if (live) window.qmLive = context.qmLive = (options) => { liveOptions = options; };
  for (const id of ['env-big-cpu', 'env-big-mem', 'env-chart-state', 'env-top', 'disk', 'ds-total', 'refresh-disk', 'cnote', 'stack-metric-note', 'd-cpu-path', 'd-mem-path', 'd-cpu', 'd-mem']) ids.set(id, element());
  for (const name of ['cpu', 'mem', 'cpu-detail', 'temp', 'temp-detail']) selectors.set('[data-live="' + name + '"]', [element()]);
  const row = element({ cid: 'one', state: 'running' });
  selectors.set('.t-ctr[data-cid]', [row]);
  for (const name of ['cpu', 'mem', 'rst', 'net', 'disk']) selectors.set('.' + name + '[data-cid]', [element({ cid: 'one' })]);
  for (const name of ['cpu', 'mem', 'net', 'dsk']) {
    const word = element({ cid: 'one' }), bar = element();
    selectors.set('.m-' + name, [{ querySelector: (selector) => selector === 'b' ? word : bar, word, bar }]);
  }
  for (const name of ['cpu', 'mem']) {
    const aggregate = element({ ids: 'one' }); aggregate.closest = () => row;
    selectors.set('.agg-' + name, [aggregate]);
  }
  const script = source(page);
  runInNewContext(detail ? script.replace('var open = null;', "var open = 'one';") : script, context);
  const event = (listeners, name) => (listeners.get(name) || []).forEach((fn) => fn());
  event(windowListeners, 'DOMContentLoaded');
  return {
    document, requests, intervals, ids, selectors, row, liveOptions: () => liveOptions,
    interval: () => intervals.forEach((fn) => fn()),
    visibility(hidden) { document.hidden = hidden; event(documentListeners, 'visibilitychange'); },
    reply(request, body) { request.resolve({ ok: true, json: () => Promise.resolve(body) }); },
  };
}

for (const page of ['dashboard', 'containers', 'stacks']) {
  test(`${page} skips hidden polling and refreshes once when visible`, async () => {
    const h = harness(page, { hidden: true, live: false });
    assert.equal(h.requests.length, 0, 'an initially hidden page does no work');
    h.interval(); h.visibility(true); assert.equal(h.requests.length, 0);
    h.visibility(false);
    const metrics = h.requests.filter((request) => request.url.endsWith('/stats'));
    assert.equal(metrics.length, 1, 'returning to the tab makes one metrics read');
    for (const request of h.requests) h.reply(request, request.url.endsWith('/stats') ? page === 'dashboard' ? { cpu: null, mem: 25, top: [] } : stats : { disk: null });
    await flush();
    h.visibility(true); h.interval();
    assert.equal(h.requests.filter((request) => request.url.endsWith('/stats')).length, 1);
    h.visibility(false);
    assert.equal(h.requests.filter((request) => request.url.endsWith('/stats')).length, 2);
  });
}

test('dashboard uses streamed stats while healthy and exposes a guarded fallback', async () => {
  const h = harness('dashboard');
  const live = h.liveOptions();
  assert.ok(live.topics.includes('stats'));
  assert.equal(live.always, undefined);
  assert.equal(h.intervals.length, 0, 'healthy streaming does not own a polling interval');
  assert.equal(h.requests.filter((request) => request.url.endsWith('/stats')).length, 1);
  live.onmessage('stats', { cpu: null, mem: 25, top: [{ name: 'One', cpu: null, mem: 25 }] });
  assert.equal(h.selectors.get('[data-live="cpu"]')[0].textContent, '-');
  assert.equal(h.selectors.get('[data-live="mem"]')[0].textContent, '25.0%');
  assert.match(h.ids.get('env-top').innerHTML, /class="dk-val">-<\/span>/);
  assert.notEqual(h.ids.get('env-big-mem').attributes.d, '');
  h.visibility(true); live.fallbackPoll();
  assert.equal(h.requests.filter((request) => request.url.endsWith('/stats')).length, 1);
  h.visibility(false); live.onmessage('stats', { cpu: 20, cores: 4, mem: 30, top: [] });
  assert.equal(h.selectors.get('[data-live="cpu"]')[0].textContent, '5%');
  assert.equal(h.selectors.get('[data-live="mem"]')[0].textContent, '30.0%');
});

test('dashboard reads cached storage and only its refresh control requests a new scan', async () => {
  const h = harness('dashboard');
  const cached = h.requests.find((request) => request.url === '/api/docker/df');
  const button = h.ids.get('refresh-disk');
  assert.ok(cached); assert.equal(button.disabled, true);
  assert.equal(cached.options, undefined, 'ordinary storage reads use GET');
  button.event('click');
  assert.equal(h.requests.filter((request) => request.url.startsWith('/api/docker/df')).length, 1, 'storage reads coalesce');
  h.reply(cached, { disk: { images: 1024, containers: 0, volumes: 0, build: 0, total: 1024 } });
  await flush();
  assert.equal(button.disabled, false); assert.equal(h.ids.get('ds-total').textContent, '1.0 KB');
  button.event('click');
  const refreshed = h.requests.at(-1);
  assert.equal(refreshed.url, '/api/docker/df');
  assert.equal(refreshed.options.method, 'POST');
  assert.equal(refreshed.options.headers['x-csrf-token'], 'fixture-csrf');
  refreshed.reject(new Error('offline')); await flush();
  assert.equal(button.disabled, false); assert.match(h.ids.get('disk').innerHTML, /Docker storage unavailable/);
  h.visibility(true); button.event('click');
  assert.equal(h.requests.at(-1), refreshed, 'a hidden tab cannot start a storage scan');
});

test('streamed storage recovers a cold cache and reflects later background results', async () => {
  const h = harness('dashboard'), live = h.liveOptions();
  h.requests.find((request) => request.url === '/api/docker/df').reject(new Error('cold cache'));
  await flush();
  assert.match(h.ids.get('disk').innerHTML, /Docker storage unavailable/);
  const disk = { images: 1024, containers: 0, volumes: 0, build: 0, total: 1024 };
  live.onmessage('stats', { cpu: 20, mem: 25, top: [], disk });
  assert.equal(h.ids.get('ds-total').textContent, '1.0 KB');
  assert.match(h.ids.get('disk').innerHTML, /ring-wrap/);
  h.ids.get('refresh-disk').event('click');
  live.onmessage('stats', { cpu: 20, mem: 25, top: [], disk: null });
  assert.equal(h.ids.get('ds-total').textContent, '1.0 KB', 'streamed cache does not overwrite a pending owner refresh');
  h.reply(h.requests.at(-1), { disk: { ...disk, images: 2048, total: 2048 } });
  await flush();
  assert.equal(h.ids.get('ds-total').textContent, '2.0 KB');
  live.onmessage('stats', { cpu: 20, mem: 25, top: [], disk: null });
  assert.equal(h.ids.get('ds-total').textContent, '');
  assert.match(h.ids.get('disk').innerHTML, /Docker storage unavailable/);
});

test('dashboard shows the measured CPU total and marks incomplete coverage as partial', () => {
  const h = harness('dashboard'), live = h.liveOptions();
  live.onmessage('stats', { cpu: 20, cores: 4, cpuPartial: true, cpuUnavailable: 1, mem: 25, top: [] });
  assert.equal(h.selectors.get('[data-live="cpu"]')[0].textContent, '5% partial');
  assert.equal(h.selectors.get('[data-live="cpu-detail"]')[0].textContent, '0.2 of 4 cores in use · partial total');
  assert.equal(h.selectors.get('[data-live="mem"]')[0].textContent, '25.0%');
  assert.notEqual(h.ids.get('env-big-cpu').attributes.d, '', 'known CPU still reaches the chart');
  live.onmessage('stats', { cpu: 20, cores: 4, cpuPartial: false, cpuUnavailable: 0, mem: 25, top: [] });
  assert.equal(h.selectors.get('[data-live="cpu"]')[0].textContent, '5%');
  assert.equal(h.selectors.get('[data-live="cpu-detail"]')[0].textContent, '0.2 of 4 cores in use');
  live.onmessage('stats', { cpu: null, cores: 4, cpuPartial: false, cpuUnavailable: 2, mem: 25, top: [] });
  assert.equal(h.selectors.get('[data-live="cpu"]')[0].textContent, '-');
  assert.equal(h.selectors.get('[data-live="cpu-detail"]')[0].textContent, '100% is one core busy');
});

test('dashboard clears unavailable memory independently and preserves gaps on the shared timeline', () => {
  const h = harness('dashboard'), live = h.liveOptions();
  live.onmessage('stats', { cpu: null, mem: 10, top: [] });
  live.onmessage('stats', { cpu: 20, mem: null, top: [] });
  assert.equal(h.selectors.get('[data-live="cpu"]')[0].textContent, '20.0%');
  assert.equal(h.selectors.get('[data-live="mem"]')[0].textContent, 'Unavailable');
  live.onmessage('stats', { cpu: null, mem: 30, top: [] });
  live.onmessage('stats', { cpu: 40, mem: 40, top: [] });
  const cpuPath = h.ids.get('env-big-cpu').attributes.d;
  const memPath = h.ids.get('env-big-mem').attributes.d;
  assert.match(cpuPath, /^M6\.7,160 L6\.7,/);
  assert.match(cpuPath, / Z M20\.2,160 L20\.2,/);
  assert.equal((cpuPath.match(/M/g) || []).length, 2, 'unknown CPU separates the two known samples');
  assert.match(memPath, /^M0\.0,160 L0\.0,/);
  assert.match(memPath, / Z M13\.5,160 L13\.5,/);
  assert.match(memPath, / L20\.2,/);
});

for (const page of ['containers', 'stacks']) {
  test(`${page} keeps memory and network metrics when the first CPU sample is null`, async () => {
    const h = harness(page, { detail: page === 'containers' }); h.reply(h.requests[0], stats); await flush();
    if (page === 'containers') {
      assert.equal(h.selectors.get('.cpu[data-cid]')[0].textContent, '-');
      assert.equal(h.selectors.get('.mem[data-cid]')[0].textContent, '1.0K/4.0K');
      assert.match(h.selectors.get('.net[data-cid]')[0].innerHTML, /8/);
      assert.equal(h.row.dataset.cpu, '');
      assert.equal(h.ids.get('d-cpu').textContent, '-');
      assert.equal(h.ids.get('d-mem').textContent, '25.0%');
      assert.equal(h.ids.get('d-cpu-path').attributes.d, '');
      assert.notEqual(h.ids.get('d-mem-path').attributes.d, '');
    } else {
      assert.equal(h.selectors.get('.m-cpu')[0].word.textContent, '-');
      assert.equal(h.selectors.get('.m-mem')[0].word.textContent, '25.0%');
      assert.equal(h.selectors.get('.m-net')[0].word.textContent, '12B');
      assert.equal(h.selectors.get('.agg-cpu')[0].textContent, '-');
      assert.equal(h.selectors.get('.agg-mem')[0].textContent, '1.0K');
    }
    h.interval(); h.reply(h.requests.at(-1), { stats: [{ ...stats.stats[0], cpu: 12.5 }] }); await flush();
    assert.equal(page === 'containers' ? h.selectors.get('.cpu[data-cid]')[0].textContent : h.selectors.get('.agg-cpu')[0].textContent, '12.5%');
  });
}

test('stack CPU totals remain partial until every container has a second sample', async () => {
  const h = harness('stacks');
  h.selectors.get('.agg-cpu')[0].dataset.ids = 'one,two';
  h.selectors.get('.agg-mem')[0].dataset.ids = 'one,two';
  h.reply(h.requests[0], { stats: [stats.stats[0], { ...stats.stats[0], id: 'two', cpu: 8 }] });
  await flush();
  assert.equal(h.selectors.get('.agg-cpu')[0].textContent, '8.0% partial');
  assert.equal(h.selectors.get('.agg-mem')[0].textContent, '2.0K');
});

test('container CPU history preserves missing sample positions beside its memory history', async () => {
  const h = harness('containers', { detail: true });
  for (const [index, cpu] of [null, 20, null, 40].entries()) {
    if (index) h.interval();
    h.reply(h.requests.at(-1), { stats: [{ ...stats.stats[0], cpu }] });
    await flush();
  }
  const cpuPath = h.ids.get('d-cpu-path').attributes.d;
  const memPath = h.ids.get('d-mem-path').attributes.d;
  assert.match(cpuPath, /^M2\.4,44 L2\.4,/);
  assert.match(cpuPath, / Z M7\.1,44 L7\.1,/);
  assert.equal((cpuPath.match(/M/g) || []).length, 2);
  assert.match(memPath, /^M0\.0,44 L0\.0,/);
  assert.match(memPath, / L2\.4,.* L4\.7,.* L7\.1,/);
  assert.equal((memPath.match(/M/g) || []).length, 1);
});
