import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryCache } from '../src/discovery-cache.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

test('pages within a minute share one discovery sweep and concurrent pages share the one in flight', async () => {
  let clock = 0, calls = 0;
  const pending = [];
  const discover = createDiscoveryCache({ now: () => clock, gather: () => { calls++; const d = deferred(); pending.push(d); return d.promise; } });
  const first = discover(); const second = discover();
  assert.equal(first, second); assert.equal(calls, 1);
  const rows = [{ kind: 'radarr' }];
  pending[0].resolve(rows);
  assert.equal(await first, rows);
  clock = 59_999;
  assert.equal(await discover(), rows); assert.equal(calls, 1);
  clock = 60_000;
  const next = discover(); assert.equal(calls, 2);
  pending[1].resolve([]); assert.deepEqual(await next, []);
});

test('a fresh sweep skips the minute but still joins a sweep in flight', async () => {
  let calls = 0;
  const pending = [];
  const discover = createDiscoveryCache({ now: () => 0, gather: () => { calls++; const d = deferred(); pending.push(d); return d.promise; } });
  const first = discover(); pending[0].resolve([1]); await first;
  const fresh = discover({ fresh: true }); assert.equal(calls, 2);
  assert.equal(discover({ fresh: true }), fresh, 'a second fresh request joins the first');
  pending[1].resolve([2]); assert.deepEqual(await fresh, [2]);
  assert.deepEqual(await discover(), [2]); assert.equal(calls, 2);
});

test('a failed sweep is not kept and the next page sweeps again', async () => {
  let calls = 0;
  const discover = createDiscoveryCache({ now: () => 0, gather: async () => { calls++; if (calls === 1) throw new Error('stack unreadable'); return [3]; } });
  await assert.rejects(discover(), /stack unreadable/);
  assert.deepEqual(await discover(), [3]); assert.equal(calls, 2);
});
