import test from 'node:test';
import assert from 'node:assert/strict';

import { createHub, HUB_MAX_CLIENTS, HUB_MAX_PER_SESSION } from '../src/hub.js';

function fakeTimers() {
  const active = new Map();
  let seq = 0;
  return {
    setInterval(fn, ms) {
      seq += 1;
      active.set(seq, { fn, ms });
      return seq;
    },
    clearInterval(id) {
      active.delete(id);
    },
    intervals() {
      return [...active.values()];
    },
    async fire(ms) {
      for (const { fn, ms: every } of [...active.values()]) {
        if (every === ms) await fn();
      }
    },
  };
}

function collector(sessionDigest = 'd1') {
  const frames = [];
  return { frames, client: { topics: ['counts'], sessionDigest, write: (chunk) => frames.push(chunk) } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a topic emits on change only and stays quiet on identical payloads', async () => {
  const timers = fakeTimers();
  let payload = { running: 3, stopped: 1 };
  const hub = createHub({ fetchers: { counts: async () => payload }, timers });
  const { frames, client } = collector();
  const leave = hub.subscribe(client);
  assert.ok(leave, 'subscribe must accept the first client');
  await settle();
  assert.equal(frames.length, 1);
  assert.match(frames[0], /^event: counts\ndata: \{"running":3,"stopped":1\}\n\n$/);

  await timers.fire(2000);
  await timers.fire(2000);
  assert.equal(frames.length, 1, 'an unchanged payload must not be re-sent');

  payload = { stopped: 1, running: 3 };
  await timers.fire(2000);
  assert.equal(frames.length, 1, 'key order is not a change');

  payload = { running: 4, stopped: 0 };
  await timers.fire(2000);
  assert.equal(frames.length, 2);
  assert.match(frames[1], /"running":4/);
  leave();
});

test('a null payload is silence, not an emit', async () => {
  const timers = fakeTimers();
  let payload = null;
  const hub = createHub({ fetchers: { counts: async () => payload }, timers });
  const { frames, client } = collector();
  const leave = hub.subscribe(client);
  await settle();
  assert.equal(frames.length, 0);
  payload = { running: 1 };
  await timers.fire(2000);
  assert.equal(frames.length, 1);
  leave();
});

test('the ping comment goes to every client on its own cadence', async () => {
  const timers = fakeTimers();
  const hub = createHub({ fetchers: { counts: async () => ({ n: 1 }) }, timers });
  const a = collector('d1');
  const b = collector('d2');
  const leaveA = hub.subscribe(a.client);
  const leaveB = hub.subscribe(b.client);
  await settle();
  assert.ok(timers.intervals().some((i) => i.ms === 20000), 'one ping interval while clients exist');
  await timers.fire(20000);
  assert.ok(a.frames.includes(': ping\n\n'));
  assert.ok(b.frames.includes(': ping\n\n'));
  leaveA();
  leaveB();
  assert.ok(!timers.intervals().some((i) => i.ms === 20000), 'the ping stops with the last client');
});

test('a late joiner replays the current snapshot without waiting a poll', async () => {
  const timers = fakeTimers();
  const hub = createHub({ fetchers: { counts: async () => ({ n: 7 }) }, timers });
  const first = collector('d1');
  const leave1 = hub.subscribe(first.client);
  await settle();
  const second = collector('d2');
  const leave2 = hub.subscribe(second.client);
  assert.equal(second.frames.length, 1);
  assert.match(second.frames[0], /"n":7/);
  leave1();
  leave2();
});

test('the global and per-session caps refuse further clients', async () => {
  const timers = fakeTimers();
  const hub = createHub({ fetchers: { counts: async () => ({ n: 1 }) }, timers });
  const leaves = [];
  for (let i = 0; i < HUB_MAX_CLIENTS; i += 1) {
    const leave = hub.subscribe(collector(`digest-${i}`).client);
    assert.ok(leave, `client ${i} fits under the global cap`);
    leaves.push(leave);
  }
  assert.equal(hub.full('digest-new'), true);
  assert.equal(hub.subscribe(collector('digest-new').client), null, 'client 17 is refused');
  for (const leave of leaves) leave();

  for (let i = 0; i < HUB_MAX_PER_SESSION; i += 1) {
    assert.ok(hub.subscribe(collector('one-session').client), `tab ${i} fits under the session cap`);
  }
  assert.equal(hub.full('one-session'), true);
  assert.equal(hub.subscribe(collector('one-session').client), null, 'a seventh tab of one session is refused');
  assert.equal(hub.full('another-session'), false);
});

test('last listener stops polling and the next listener restarts it', async () => {
  const timers = fakeTimers();
  let calls = 0;
  const hub = createHub({ fetchers: { counts: async () => { calls += 1; return { n: 1 }; } }, timers });
  const a = collector('d1');
  const leave = hub.subscribe(a.client);
  await settle();
  assert.ok(timers.intervals().some((i) => i.ms === 2000));
  leave();
  leave();
  assert.equal(hub.clientCount(), 0);
  assert.equal(timers.intervals().length, 0, 'no timers survive the last client');
  const before = calls;
  await timers.fire(2000);
  assert.equal(calls, before);

  const b = collector('d2');
  const leaveB = hub.subscribe(b.client);
  await settle();
  assert.equal(b.frames.length, 1);
  leaveB();
});

test('a throwing fetcher does not kill the loop', async () => {
  const timers = fakeTimers();
  let boom = true;
  const hub = createHub({
    fetchers: { counts: async () => { if (boom) throw new Error('socket fell over'); return { n: 2 }; } },
    timers,
  });
  const { frames, client } = collector();
  const leave = hub.subscribe(client);
  await settle();
  assert.equal(frames.length, 0);
  boom = false;
  await timers.fire(2000);
  assert.equal(frames.length, 1);
  leave();
});
