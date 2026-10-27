import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import { createHub, HUB_TOPICS } from '../src/hub.js';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-companion-live-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = '192.168.1.20';
process.env.DATA_DIR = dataDir;
const { appRuntime } = await import('../src/ui/runtime.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));

function fakeTimers() {
  let seq = 0;
  const intervals = new Map(), timeouts = new Map();
  return {
    intervals, timeouts,
    setInterval(fn, ms) { const id = ++seq; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) { const id = ++seq; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    async fireIntervals(ms) {
      for (const task of [...intervals.values()]) if (task.ms === ms) await task.fn();
    },
    fireTimeout() {
      const [id, task] = [...timeouts][0];
      timeouts.delete(id);
      task.fn();
    },
  };
}

function runtime({ eventSource = true, hidden = false } = {}) {
  const timers = fakeTimers(), sources = [], visibility = new Set();
  const document = {
    hidden,
    addEventListener(type, fn) { if (type === 'visibilitychange') visibility.add(fn); },
    removeEventListener(type, fn) { if (type === 'visibilitychange') visibility.delete(fn); },
  };
  class EventSource {
    constructor(url) { this.url = url; this.handlers = {}; this.closed = false; sources.push(this); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    close() { this.closed = true; }
    message(type, data) { this.handlers[type]({ data: JSON.stringify(data) }); }
  }
  const window = eventSource ? { EventSource } : {};
  const script = appRuntime().match(/window\.qmLive = function \(o\) \{[\s\S]*?\n    \};/);
  assert.ok(script, 'the rendered runtime includes the live helper');
  vm.runInNewContext(script[0], { window, document, ...timers });
  return {
    live: window.qmLive, timers, sources, visibility,
    setHidden(value) { document.hidden = value; for (const fn of [...visibility]) fn(); },
  };
}

test('stats is one demand-driven ten-second topic shared by dashboard listeners', async () => {
  assert.ok(HUB_TOPICS.includes('stats'));
  const timers = fakeTimers();
  let calls = 0, finish;
  const hub = createHub({
    timers,
    fetchers: { stats: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } },
  });
  const framesA = [], framesB = [];
  assert.equal(calls, 0);
  const first = hub.subscribe({ topics: ['stats'], sessionDigest: 'a', write: (frame) => framesA.push(frame) });
  const second = hub.subscribe({ topics: ['stats'], sessionDigest: 'b', write: (frame) => framesB.push(frame) });
  assert.equal(calls, 1, 'joining a second tab reuses the running read');
  assert.ok([...timers.intervals.values()].some((task) => task.ms === 10_000));
  await timers.fireIntervals(10_000);
  assert.equal(calls, 1, 'slow reads never overlap');
  finish({ containers: [{ id: 'plex', cpuPercent: null }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(framesA.length, 1);
  assert.deepEqual(framesA, framesB);
  assert.match(framesA[0], /^event: stats\ndata: /);
  const framesC = [];
  const third = hub.subscribe({ topics: ['stats'], sessionDigest: 'c', write: (frame) => framesC.push(frame) });
  assert.deepEqual(framesC, framesA, 'new listeners get the current cached sample');
  first(); second();
  const nextPoll = timers.fireIntervals(10_000);
  assert.equal(calls, 2, 'the remaining listener keeps the shared sampler active');
  finish({ containers: [{ id: 'plex', cpuPercent: 12 }] });
  await nextPoll;
  third();
  assert.equal(timers.intervals.size, 0, 'the final listener stops sampling and pings');
  await timers.fireIntervals(10_000);
  assert.equal(calls, 2);
});

test('healthy streams deliver stats without starting redundant fallback polling', () => {
  const h = runtime();
  let polls = 0, message;
  const live = h.live({ topics: ['counts', 'stats'], always: true, fallbackPoll: () => polls++,
    onmessage: (topic, data) => { message = [topic, data]; } });
  assert.equal(h.sources.length, 1);
  assert.match(h.sources[0].url, /topics=counts%2Cstats$/);
  h.sources[0].onopen();
  h.sources[0].message('stats', { cpuPercent: null });
  assert.equal(JSON.stringify(message), '["stats",{"cpuPercent":null}]');
  assert.equal(polls, 0);
  assert.equal(h.timers.intervals.size, 0);
  live.close();
});

test('repeated stream failures start fallback and a recovered connection stops it', async () => {
  const h = runtime();
  let polls = 0;
  const live = h.live({ topics: ['stats'], fallbackMs: 10_000, fallbackPoll: () => polls++ });
  h.sources[0].onerror();
  assert.equal(polls, 0, 'a single failure only schedules a retry');
  assert.equal([...h.timers.timeouts.values()][0].ms, 5000);
  h.timers.fireTimeout();
  h.sources[1].onerror();
  assert.equal(polls, 1);
  assert.equal([...h.timers.timeouts.values()][0].ms, 10_000);
  await h.timers.fireIntervals(10_000);
  assert.equal(polls, 2);
  h.timers.fireTimeout();
  h.sources[2].onopen();
  assert.equal(h.timers.intervals.size, 0, 'opening a recovered stream stops fallback even before data changes');
  await h.timers.fireIntervals(10_000);
  assert.equal(polls, 2);
  live.close();
});

test('a valid topic message recovers fallback and malformed messages do not', () => {
  const h = runtime();
  let polls = 0;
  const live = h.live({ topics: ['stats'], fallbackPoll: () => polls++ });
  h.sources[0].onerror(); h.timers.fireTimeout();
  h.sources[1].onerror(); h.timers.fireTimeout();
  h.sources[2].handlers.stats({ data: 'invalid' });
  assert.equal(h.timers.intervals.size, 1);
  h.sources[2].message('stats', {});
  assert.equal(h.timers.intervals.size, 0);
  assert.equal(polls, 1);
  live.close();
});

test('streams that repeatedly open then close still activate fallback until data recovers', () => {
  const h = runtime();
  let polls = 0;
  const live = h.live({ topics: ['stats'], fallbackPoll: () => polls++ });
  h.sources[0].onopen(); h.sources[0].onerror(); h.timers.fireTimeout();
  h.sources[1].onopen(); h.sources[1].onerror();
  assert.equal(polls, 1, 'an open handshake does not erase the first failed delivery');
  h.timers.fireTimeout();
  h.sources[2].onopen(); h.sources[2].onerror();
  assert.equal(polls, 2, 'each further failed delivery resumes fallback');
  h.timers.fireTimeout();
  h.sources[3].onopen(); h.sources[3].message('stats', {}); h.sources[3].onerror();
  assert.equal(polls, 2, 'valid data resets the consecutive failure history');
  assert.equal(h.timers.intervals.size, 0);
  live.close();
});

test('unsupported streams poll only while visible and leave visibility refresh to the page', async () => {
  const h = runtime({ eventSource: false });
  let polls = 0;
  const live = h.live({ topics: ['stats'], fallbackMs: 10_000, fallbackPoll: () => polls++ });
  assert.equal(polls, 1);
  const pendingPoll = [...h.timers.intervals.values()][0].fn;
  h.setHidden(true);
  assert.equal(h.timers.intervals.size, 0);
  pendingPoll();
  assert.equal(polls, 1, 'a queued interval does no hidden-tab work');
  h.setHidden(false);
  assert.equal(polls, 1, 'the page owns its one immediate visibility refresh');
  assert.equal(h.timers.intervals.size, 1);
  await h.timers.fireIntervals(10_000);
  assert.equal(polls, 2);
  live.close();
  assert.equal(h.timers.intervals.size, 0);
  assert.equal(h.visibility.size, 0);
});

test('hidden tabs close streams, cancel retries and reconnect once on return', () => {
  const h = runtime({ hidden: true });
  let messages = 0;
  const live = h.live({ topics: ['stats'], onmessage: () => messages++ });
  assert.equal(h.sources.length, 0);
  h.setHidden(false);
  h.setHidden(false);
  assert.equal(h.sources.length, 1);
  h.sources[0].onerror();
  assert.equal(h.timers.timeouts.size, 1);
  const pendingRetry = [...h.timers.timeouts.values()][0].fn;
  h.setHidden(true);
  assert.equal(h.timers.timeouts.size, 0);
  pendingRetry();
  assert.equal(h.sources.length, 1, 'a queued retry cannot connect while hidden');
  h.setHidden(false);
  assert.equal(h.sources.length, 2);
  h.sources[0].message('stats', {});
  assert.equal(messages, 0, 'messages from the previous connection are ignored');
  h.setHidden(true);
  assert.equal(h.sources[1].closed, true);
  live.close();
});

test('closing permanently cancels retries, fallback polling and late callbacks', () => {
  const h = runtime();
  let polls = 0;
  const live = h.live({ topics: ['stats'], fallbackPoll: () => polls++ });
  h.sources[0].onerror(); h.timers.fireTimeout();
  h.sources[1].onerror();
  const pendingRetry = [...h.timers.timeouts.values()][0].fn;
  const pendingPoll = [...h.timers.intervals.values()][0].fn;
  live.close(); live.close();
  assert.equal(h.timers.timeouts.size, 0);
  assert.equal(h.timers.intervals.size, 0);
  assert.equal(h.visibility.size, 0);
  pendingRetry(); pendingPoll(); h.sources[1].onerror(); h.setHidden(false);
  assert.equal(h.sources.length, 2);
  assert.equal(polls, 1);
});
