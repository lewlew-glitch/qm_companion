import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-companion-pages-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = 'nas.local';
process.env.DATA_DIR = dataDir;

const { consolePage } = await import('../src/ui/pages/console.js');
const { activityPage } = await import('../src/ui/pages/activity.js');
const { cronPage } = await import('../src/ui/pages/cron.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

const CONTAINERS = [
  { id: 'a'.repeat(12), name: 'radarr', image: 'radarr:latest', state: 'running', health: 'healthy' },
  { id: 'b'.repeat(12), name: 'sonarr', image: 'sonarr:latest', state: 'exited' },
];

function pageScript(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
  return scripts.find((s) => s.includes('function load()'));
}

function node(extra = {}) {
  const classes = new Set();
  const self = {
    dataset: {}, style: {}, listeners: {},
    textContent: '', innerHTML: '', value: '', className: '',
    disabled: false, hidden: false, scrollTop: 0, scrollHeight: 0,
    addEventListener(type, fn) { (self.listeners[type] || (self.listeners[type] = [])).push(fn); },
    fire(type, event = {}) { (self.listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, ...event })); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; },
    scrollIntoView() {}, focus() {}, closest() { return null; },
    add() {},
  };
  self.classList = {
    add: (...c) => c.forEach((x) => classes.add(x)),
    remove: (...c) => c.forEach((x) => classes.delete(x)),
    contains: (c) => classes.has(c),
    toggle(c, on) {
      const want = on === undefined ? !classes.has(c) : !!on;
      if (want) classes.add(c); else classes.delete(c);
      return want;
    },
  };
  self.classes = classes;
  return Object.assign(self, extra);
}

function consoleHarness(replies) {
  const ids = {};
  for (const id of ['loglay', 'logpane', 'logconsole', 'logsearch', 'logtail', 'logfollow', 'logstatus',
    'loglive', 'logmatch', 'loglevels', 'logtimes', 'cname', 'cfilter', 'logmode', 'cstate',
    'shelltoggle', 'shellpane', 'termout', 'termform', 'termin', 'termprompt', 'logrows']) ids[id] = node();
  ids.logtail.value = '200';
  const rows = CONTAINERS.map((c) => {
    const dot = node();
    const row = node({ dataset: { id: c.id, name: c.name, state: c.state, protected: '', find: c.name } });
    row.querySelector = (sel) => (sel === '.sdot' ? dot : null);
    row.dot = dot;
    return row;
  });
  const document = {
    getElementById: (id) => ids[id] || null,
    querySelectorAll: () => rows,
    querySelector: (sel) => (sel === 'meta[name=csrf]' ? { content: 'csrf' } : null),
    addEventListener() {},
  };
  const calls = [];
  const fetchStub = (url, init) => {
    calls.push({ url, init });
    const reply = replies.shift() || { status: 200, body: { text: '' } };
    if (reply.reject) return Promise.reject(new Error('offline'));
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    });
  };
  const live = {};
  const window = { qmLive: (o) => { live.opts = o; return { close() {} } }, EventSource: function () {} };
  return { ids, rows, calls, live, document, window, fetchStub };
}

function runConsole(script, h) {
  const fn = new Function('document', 'window', 'fetch', 'setInterval', 'setTimeout', 'location', 'history', script);
  fn(h.document, h.window, h.fetchStub, () => 1, (cb) => { cb(); return 1; }, { search: '' }, { replaceState() {} });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a container that exits mid-session loses its running dot and its shell', async () => {
  const html = consolePage(CONTAINERS, 'a'.repeat(12), true, 'csrf-token', true);
  const script = pageScript(html);
  const h = consoleHarness([{ status: 200, body: { text: 'line one' } }]);
  runConsole(script, h);
  await settle();

  assert.equal(h.rows[0].dataset.state, 'running');
  assert.equal(h.ids.termin.disabled, false);
  assert.ok(h.live.opts, 'the console subscribes to the docker event feed');
  assert.deepEqual(h.live.opts.topics, ['events']);

  h.live.opts.onmessage('events', [{ time: 9, type: 'container', action: 'die', name: 'radarr', exitCode: '137' }]);
  assert.equal(h.rows[0].dataset.state, 'exited');
  assert.equal(h.rows[0].dot.className, 'sdot ');
  assert.equal(h.ids.termin.disabled, true);
  assert.match(h.ids.termout.textContent, /radarr is now exited, exit code 137/);
  assert.match(h.ids.termout.textContent, /nothing can run in a container that is not running/);
  assert.equal(h.ids.cstate.textContent, 'exited');

  h.live.opts.onmessage('events', [{ time: 10, type: 'container', action: 'start', name: 'radarr' }]);
  assert.equal(h.rows[0].dataset.state, 'running');
  assert.equal(h.rows[0].dot.className, 'sdot ok');
  assert.equal(h.ids.termin.disabled, false);
});

test('renders Docker log-read failures', async () => {
  const script = pageScript(consolePage(CONTAINERS, 'a'.repeat(12), true, 'csrf-token', true));
  const h = consoleHarness([{ status: 403, body: { error: 'The socket proxy is blocking container logs.' } }]);
  runConsole(script, h);
  await settle();

  assert.doesNotMatch(h.ids.logpane.textContent, /Loading/);
  assert.match(h.ids.logpane.textContent, /Docker did not return logs for radarr\./);
  assert.match(h.ids.logpane.textContent, /The socket proxy is blocking container logs\./);
  assert.match(h.ids.logpane.textContent, /set CONTAINERS: 1 on qm-socket-proxy/);
  assert.match(h.ids.logpane.textContent, /keeping every -f it already has/);
  assert.ok(h.ids.loglive.classList.contains('off'), 'the Live dot goes out when the read failed');
});

test('a 200 with no log text is a failure, not an empty container', async () => {
  const script = pageScript(consolePage(CONTAINERS, 'a'.repeat(12), true, 'csrf-token', true));
  const h = consoleHarness([{ status: 200, body: {} }]);
  runConsole(script, h);
  await settle();
  assert.match(h.ids.logpane.textContent, /Docker did not return logs for radarr\./);

  const quiet = consoleHarness([{ status: 200, body: { text: '' } }]);
  runConsole(script, quiet);
  await settle();
  assert.match(quiet.ids.logpane.textContent, /has not written any log lines Docker kept/);
  assert.ok(!quiet.ids.loglive.classList.contains('off'));
});

test('the shell reports a refusal and names the way to turn shell access on', async () => {
  const script = pageScript(consolePage(CONTAINERS, 'a'.repeat(12), true, 'csrf-token', true));
  const h = consoleHarness([
    { status: 200, body: { text: 'line one' } },
    { status: 403, body: { error: 'Docker shell access is off' } },
  ]);
  runConsole(script, h);
  await settle();

  h.ids.termin.value = 'ls -la';
  h.ids.termform.fire('submit');
  await settle();
  assert.equal(h.calls[1].url, '/api/exec');
  assert.match(h.ids.termout.textContent, /\[Docker shell access is off\]/);
  assert.match(h.ids.termout.textContent, /Choose Management \+ shell under Docker access in the sidebar/);
  assert.match(h.ids.termout.textContent, /docker compose -f docker-compose\.example\.yml -f docker-compose\.shell\.yml up -d/);
  assert.equal(h.ids.termin.disabled, true);
});

test('renders an empty Docker events state without a live Follow status', () => {
  const empty = activityPage([], 'csrf-token', '24', []);
  assert.match(empty, /No Docker events in the last 24 hours/);
  assert.match(empty, /Choose a longer range/);
  const oneHour = activityPage([], 'csrf-token', '1', []);
  assert.match(oneHour, /No Docker events in the last hour/);

  const busy = activityPage([{ time: 1, action: 'die', type: 'container', name: 'radarr', image: 'radarr', exitCode: '1' }], 'csrf-token', '24', []);
  assert.doesNotMatch(busy, /No Docker events/);

  assert.match(busy, /id="followlost"/);
  assert.match(busy, /Live updates stopped/);
  assert.match(busy, /fallbackPoll: liveDown/);
  assert.match(busy, /function liveDown\(\) \{ lostLive = true; paintLive\(\); \}/);
  assert.match(busy, /follow\.classList\.toggle\('on', !lostLive\)/);
  assert.match(busy, /lost\.classList\.toggle\('hidden', !lostLive\)/);
  assert.match(busy, /if \(!window\.qmLive\)/);
  for (const s of [...busy.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])) assert.doesNotThrow(() => new Function(s));
});

const CLAIM_AT = 1755900000000;
const CRON_CONTAINERS = [{ id: 'a'.repeat(12), name: 'radarr' }];

test('missing cron result renders Interrupted', () => {
  const jobs = [{
    id: 'prune-images', name: 'Prune dangling images', does: 'Removes dangling images.', action: 'images',
    schedule: { type: 'daily', hour: 3, minute: 0 }, enabled: true, lastRunAt: CLAIM_AT,
    lastResult: { ok: true, note: 'done', ms: 900 },
    history: [{ at: CLAIM_AT - 86400000, ms: 900, ok: true, note: 'done', trigger: 'schedule' }],
  }];
  const html = cronPage(jobs, CRON_CONTAINERS, true, 'csrf-token', '', true);
  const row = html.slice(html.indexOf('data-jid="prune-images"'), html.indexOf('<div class="cron-x'));
  const lastCell = row.slice(row.indexOf('data-col="last"'), row.indexOf('data-col="next"'));
  assert.match(lastCell, /<span class="state warn"[^>]*><i><\/i>Interrupted<\/span>/);
  assert.doesNotMatch(lastCell, /in 0ms/);
  assert.doesNotMatch(lastCell, /class="state ok"|class="state bad"/);
  assert.match(row, /data-open-claim="1"/);
  assert.match(row, /data-lastok=""/);
  assert.match(row, /data-lastnote=""/);
  const expander = html.slice(html.indexOf('id="x-prune-images"'), html.indexOf('</div>', html.indexOf('Companion records the start')));
  assert.match(expander, /no result was recorded, so there is no history row/);
  assert.match(expander, /records the start before Docker work and the result after/);
  assert.match(html, /now\.dataset\.openClaim === '1'/);
  assert.match(html, /started, no result recorded yet/);
});

test('clearing the history does not turn every past run into an interruption', () => {
  const jobs = [{
    id: 'prune-images', name: 'Prune dangling images', does: 'Removes dangling images.', action: 'images',
    schedule: { type: 'daily', hour: 3, minute: 0 }, enabled: true, lastRunAt: CLAIM_AT,
    lastResult: { ok: true, note: 'done', ms: 900 }, history: [],
  }];
  const html = cronPage(jobs, CRON_CONTAINERS, true, 'csrf-token', '', true);
  const row = html.slice(html.indexOf('data-jid="prune-images"'), html.indexOf('<div class="cron-x'));
  const cell = row.slice(row.indexOf('data-col="last"'), row.indexOf('data-col="next"'));
  assert.doesNotMatch(cell, /Interrupted/);
  assert.match(cell, /class="state ok"/);
  assert.match(cell, /in 900ms/);
});

test('completed runs retain verdict and duration', () => {
  const jobs = [{
    id: 'prune-images', name: 'Prune dangling images', does: 'Removes dangling images.', action: 'images',
    schedule: { type: 'daily', hour: 3, minute: 0 }, enabled: true, lastRunAt: CLAIM_AT,
    lastResult: { ok: false, note: 'docker would not prune (500)', ms: 120 },
    history: [{ at: CLAIM_AT, ms: 120, ok: false, note: 'docker would not prune (500)', trigger: 'manual' }],
  }];
  const html = cronPage(jobs, CRON_CONTAINERS, true, 'csrf-token', '', true);
  const row = html.slice(html.indexOf('data-jid="prune-images"'), html.indexOf('<div class="cron-x'));
  const done = row.slice(row.indexOf('data-col="last"'), row.indexOf('data-col="next"'));
  assert.match(done, /class="state bad"/);
  assert.match(done, /in 120ms/);
  assert.doesNotMatch(row, /Interrupted/);
  assert.match(row, /data-lastok="0"/);
  assert.match(row, /data-open-claim=""/);
});

const note = (html) => {
  const at = html.indexOf('more Docker access than this Companion has');
  return at === -1 ? '' : html.slice(html.lastIndexOf('<p class="sub">', at), html.indexOf('</p>', at));
};

test('locked jobs report the required access mode', () => {
  const jobs = [
    { id: 'prune-images', name: 'Prune dangling images', does: 'Removes dangling images.', action: 'images', schedule: { type: 'daily', hour: 3, minute: 0 }, enabled: false, history: [] },
    { id: 'custom-exec', kind: 'custom', name: 'Back up config', action: { type: 'exec', ref: 'a'.repeat(12), cmd: 'backup-now' }, schedule: { type: 'daily', hour: 1, minute: 0 }, enabled: false, history: [] },
  ];
  const readOnly = cronPage(jobs, CRON_CONTAINERS, false, 'csrf-token', '', false);
  assert.match(readOnly, /2 jobs here need more Docker access than this Companion has/);
  assert.match(readOnly, /Choose Management \+ shell under Docker access/);
  assert.match(note(readOnly), /docker compose -f docker-compose\.example\.yml -f docker-compose\.shell\.yml up -d/);
  assert.match(note(readOnly), /Keep the same <code class="mono">-f<\/code> files in the same order/);

  const managed = cronPage(jobs, CRON_CONTAINERS, true, 'csrf-token', '', false);
  assert.match(managed, /1 job here needs more Docker access/);
  assert.match(note(managed), /docker-compose\.shell\.yml/);

  const pruneOnly = cronPage([jobs[0]], CRON_CONTAINERS, false, 'csrf-token', '', false);
  assert.match(note(pruneOnly), /Choose Management under Docker access/);
  assert.match(note(pruneOnly), /docker-compose\.management\.yml/);
  assert.doesNotMatch(note(pruneOnly), /docker-compose\.shell\.yml/);

  const shellMode = cronPage(jobs, CRON_CONTAINERS, true, 'csrf-token', '', true);
  assert.doesNotMatch(shellMode, /more Docker access than this Companion has/);
});

test('no page tells the owner to re-run a bare compose up', () => {
  const pages = [
    consolePage(CONTAINERS, 'a'.repeat(12), true, 'csrf-token', true),
    activityPage([], 'csrf-token', '24', []),
    cronPage([{ id: 'prune-images', name: 'Prune', does: 'd', action: 'images', schedule: { type: 'daily', hour: 3, minute: 0 }, enabled: false, history: [] }], CRON_CONTAINERS, false, 'csrf-token', '', false),
  ];
  for (const page of pages) assert.doesNotMatch(page, /docker compose up -d/);
});
