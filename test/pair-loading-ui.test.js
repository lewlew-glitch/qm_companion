import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-loading-runtime-'));
process.env.DATA_DIR = dataDir;
process.env.SECRET_KEY = '43'.repeat(32);
process.env.QM_HOST = '192.168.1.20';
const { pairLoadingPage } = await import('../src/ui/pages/pair-loading.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));
const page = pairLoadingPage('fixture-csrf');
const runtime = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]).find((script) => script.includes('pairLoadingRuntime'));
assert.ok(runtime, 'exercise the actual script emitted by the loading shell');
const fragment = '<section data-pair-loaded><h1>Review services</h1><form></form>'
  + '<script>window.runs=(window.runs||0)+1;window.order.push("controller");</script>'
  + '<script>window.order.push("helper");</script></section>';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

// Small DOM fixture for the operations this loader uses. The emitted runtime is unmodified;
// scripts removed from inert template content execute only when appended to the live root.
function harness({ ignoreAbort = false } = {}) {
  const requests = [], timers = new Map(), windowEvents = new Map();
  let nextTimer = 1, mounted = null, context;
  function element() {
    return { hidden: false, style: {}, attributes: {}, textContent: '', listeners: new Map(),
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      focus() { document.activeElement = this; } };
  }
  const root = element(), note = element(), progress = element(), retry = element(), signin = element(), announcement = element();
  const elements = { 'pair-content': root, 'pair-loading-note': note, 'pair-loading-progress': progress,
    'pair-loading-retry': retry, 'pair-loading-signin': signin, 'pair-load-announcement': announcement };
  root.contains = (node) => Object.values(elements).includes(node);
  root.querySelector = (selector) => selector === 'h1' ? mounted?.heading : null;
  root.replaceChildren = (form) => {
    assert.equal(form.scripts.filter((script) => !script.removed).length, 0, 'inert scripts are removed before mounting');
    mounted = form; window.order.push('mounted');
  };
  root.appendChild = (script) => runInContext(script.textContent, context);
  const document = { activeElement: null, getElementById: (id) => elements[id], createElement(tag) {
    if (tag === 'script') return element();
    assert.equal(tag, 'template');
    const template = { content: { querySelector: () => null } };
    Object.defineProperty(template, 'innerHTML', { set(html) {
      const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
        .map((match) => ({ textContent: match[2], external: /\bsrc\s*=/.test(match[1]), removed: false, remove() { this.removed = true; } }));
      const form = { scripts, heading: element(), querySelectorAll: () => scripts,
        querySelector: (selector) => selector === 'script[src]' ? scripts.find((script) => script.external) : null };
      template.content.querySelector = () => /\bdata-pair-loaded\b/.test(html) ? form : null;
    } });
    return template;
  } };
  const window = { runs: 0, order: [], addEventListener(name, listener) {
    const listeners = windowEvents.get(name) || []; listeners.push(listener); windowEvents.set(name, listeners);
  } };
  const abortable = (promise, signal) => ignoreAbort ? promise : new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  context = createContext({ document, window, AbortController,
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      const pending = deferred(); requests.push({ ...pending, url, options });
      return abortable(pending.promise, options.signal);
    } });
  runInContext(runtime, context);
  return { root, note, progress, retry, signin, announcement, requests, timers, window, document,
    mounted: () => mounted,
    clickRetry: () => retry.listeners.get('click')(),
    event: (name) => (windowEvents.get(name) || []).forEach((fn) => fn({ persisted: true })),
    fire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } },
    reply(index = requests.length - 1, { status = 200, type = 'text/html; charset=utf-8', body = fragment } = {}) {
      const request = requests[index];
      request.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => type },
        text: () => abortable(Promise.resolve(body), request.options.signal) });
    },
  };
}

test('the shell is immediately busy, announces slow work and coalesces page events and retries', async () => {
  assert.match(page, /aria-busy="true"/);
  assert.match(page, /role="progressbar"/);
  assert.match(page, /href="\/pair\?full=1"/);
  const h = harness();
  assert.equal(h.root.attributes['aria-busy'], 'true');
  assert.equal(h.progress.hidden, false); assert.equal(h.retry.hidden, true); assert.equal(h.signin.hidden, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/pair/form');
  assert.equal(h.requests[0].options.credentials, 'same-origin');
  assert.equal(h.requests[0].options.cache, 'no-store');
  assert.equal(h.requests[0].options.redirect, 'error');
  assert.deepEqual([...h.timers.values()].map((timer) => timer.delay), [8000, 90000]);
  h.event('pageshow'); h.event('pageshow'); h.clickRetry(); await flush();
  assert.equal(h.requests.length, 1);
  h.fire(8000); assert.match(h.note.textContent, /Still checking/); assert.equal(h.mounted(), null);
  h.event('pagehide'); await flush();
});

test('success mounts the form before running each controller once, restores focus and never remounts', async () => {
  const h = harness(); h.document.activeElement = h.retry;
  h.reply(); await flush();
  assert.equal(h.root.attributes['aria-busy'], 'false');
  assert.equal(h.window.runs, 1); assert.deepEqual(h.window.order, ['mounted', 'controller', 'helper']);
  assert.equal(h.mounted().heading.tabIndex, -1); assert.equal(h.document.activeElement, h.mounted().heading);
  assert.match(h.announcement.textContent, /complete/); assert.equal(h.timers.size, 0);
  h.clickRetry(); h.event('pageshow'); h.event('pagehide'); h.event('pageshow'); await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.window.runs, 1);
});

test('success leaves navigation focus alone when the user moved outside setup', async () => {
  const h = harness(), navigation = {}; h.document.activeElement = navigation;
  h.reply(); await flush(); assert.equal(h.document.activeElement, navigation);
});

test('an expired session offers sign-in and stops the loader without showing Retry', async () => {
  const h = harness(); h.reply(0, { status: 401 }); await flush();
  assert.match(h.note.textContent, /session expired/); assert.equal(h.signin.hidden, false);
  assert.equal(h.retry.hidden, true); assert.equal(h.progress.hidden, true);
  assert.equal(h.root.attributes['aria-busy'], 'false'); assert.equal(h.timers.size, 0);
  assert.equal(h.window.runs, 0);
});

for (const failure of ['http', 'network', 'wrong-type', 'missing-form', 'external-script']) {
  test(`${failure} cannot mount a partial form and permits one successful retry`, async () => {
    const h = harness();
    if (failure === 'network') h.requests[0].reject(new Error('Offline'));
    else h.reply(0, failure === 'http' ? { status: 503 } : failure === 'wrong-type' ? { type: 'application/json' }
      : failure === 'missing-form' ? { body: '<h1>Login</h1>' } : { body: '<div data-pair-loaded><script src="/external.js"></script></div>' });
    await flush(); assert.equal(h.mounted(), null); assert.equal(h.window.runs, 0);
    assert.equal(h.retry.hidden, false); assert.equal(h.signin.hidden, true); assert.equal(h.progress.hidden, true);
    assert.equal(h.timers.size, 0);
    h.clickRetry(); h.clickRetry(); await flush(); assert.equal(h.requests.length, 2);
    assert.equal(h.progress.hidden, false); assert.equal(h.root.attributes['aria-busy'], 'true');
    h.reply(); await flush(); assert.equal(h.window.runs, 1); assert.equal(h.timers.size, 0);
  });
}

for (const bodyWait of [false, true]) {
  test(`the 90-second timeout bounds ${bodyWait ? 'body' : 'headers'} and a fresh retry owns the result`, async () => {
    const h = harness(), body = deferred();
    if (bodyWait) { h.reply(0, { body: body.promise }); await flush(); }
    h.fire(90000); await flush();
    assert.equal(h.requests[0].options.signal.aborted, true); assert.equal(h.retry.hidden, false);
    assert.equal(h.root.attributes['aria-busy'], 'false'); assert.equal(h.timers.size, 0);
    h.clickRetry(); await flush(); assert.equal(h.requests.length, 2);
    if (bodyWait) body.resolve(fragment); else h.reply(0);
    await flush(); assert.equal(h.window.runs, 0); assert.equal(h.root.attributes['aria-busy'], 'true');
    h.reply(1); await flush(); assert.equal(h.window.runs, 1);
  });
  test(`pagehide retires ${bodyWait ? 'body' : 'headers'} completion; bfcache restarts once`, async () => {
    // A queued completion can still run after abort. The loader must check current ownership itself.
    const h = harness({ ignoreAbort: true }), body = deferred();
    if (bodyWait) { h.reply(0, { body: body.promise }); await flush(); }
    h.event('pagehide'); assert.equal(h.requests[0].options.signal.aborted, true); assert.equal(h.timers.size, 0);
    h.clickRetry(); await flush(); assert.equal(h.requests.length, 1);
    h.event('pageshow'); h.event('pageshow'); await flush(); assert.equal(h.requests.length, 2);
    if (bodyWait) body.resolve(fragment); else h.reply(0);
    await flush(); assert.equal(h.window.runs, 0); assert.equal(h.root.attributes['aria-busy'], 'true');
    assert.equal(h.timers.size, 2, 'retired finally must not clear the new deadline');
    h.clickRetry(); assert.equal(h.requests.length, 2);
    h.reply(1); await flush(); assert.equal(h.window.runs, 1); assert.equal(h.timers.size, 0);
  });
}
