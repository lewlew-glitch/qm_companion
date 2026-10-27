import test from 'node:test';
import assert from 'node:assert/strict';

import { createContainerStatReader } from '../src/docker-container-stat.js';

const ID = 'a'.repeat(64);
const sample = (total = 100, system = 1000) => ({
  cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: system, online_cpus: 4 },
  memory_stats: { usage: 400, limit: 1000, stats: { inactive_file: 100 } },
});
const response = (json, status = 200) => ({ json, status });

test('detail reads use one-shot stats, share in-flight requests and keep the existing next-read cadence', async () => {
  let finish;
  const requests = [];
  const read = createContainerStatReader({ request: (method, path) => {
    requests.push([method, path]);
    return new Promise((resolve) => { finish = resolve; });
  } });
  const first = read(ID), joined = read(ID);
  assert.equal(first, joined);
  assert.deepEqual(requests, [['GET', `/containers/${ID}/stats?stream=false&one-shot=true`]]);
  finish(response(sample()));
  assert.deepEqual(await first, { cpu: null, memUsed: 300, memLimit: 1000 });
  const next = read(ID);
  assert.equal(requests.length, 2, 'a later detail read collects a new sample without a ten-second browser cache');
  finish(response({ ...sample(300, 2000), precpu_stats: { cpu_usage: { total_usage: 299 }, system_cpu_usage: 1999 } }));
  assert.equal((await next).cpu, 80, 'the local prior sample is used instead of Docker precpu_stats');
});

test('detail CPU keeps independent baselines per container', async () => {
  const other = 'b'.repeat(64);
  let current = sample();
  const read = createContainerStatReader({ request: async () => response(current) });
  assert.equal((await read(ID)).cpu, null);
  current = sample(9000, 20_000);
  assert.equal((await read(other)).cpu, null);
  current = sample(300, 2000);
  assert.equal((await read(ID)).cpu, 80);
});

test('detail CPU distinguishes first, idle, reset and invalid samples', async () => {
  const samples = [sample(100, 1000), sample(300, 2000), sample(300, 3000), sample(1, 4000),
    sample(101, 5000), sample(201, 5000), sample(301, 4000), sample(401, NaN)];
  const read = createContainerStatReader({ request: async () => response(samples.shift()) });
  for (const expected of [null, 80, 0, null, 40, null, null, null]) {
    assert.equal((await read(ID)).cpu, expected);
  }
});

test('failed detail reads clear prior CPU and never return a fake zero sample', async () => {
  let current = response(sample()), throws = false;
  const read = createContainerStatReader({ request: async () => {
    if (throws) throw new Error('unreachable');
    return current;
  } });
  assert.equal((await read(ID)).cpu, null);
  for (const failed of [response(sample(), 500), response(null, 0), response({}), response(null)]) {
    current = failed;
    assert.equal(await read(ID), null);
    current = response(sample(300, 2000));
    assert.equal((await read(ID)).cpu, null, 'recovery starts a new baseline');
  }
  throws = true;
  assert.equal(await read(ID), null);
  throws = false; current = response(sample(500, 3000));
  assert.equal((await read(ID)).cpu, null);
});

test('detail CPU baselines expire after a minute without a sample', async () => {
  let at = 0, current = sample();
  const read = createContainerStatReader({ now: () => at, request: async () => response(current) });
  assert.equal((await read(ID)).cpu, null);
  at = 59_999; current = sample(300, 2000);
  assert.equal((await read(ID)).cpu, 80);
  at = 119_999; current = sample(500, 3000);
  assert.equal((await read(ID)).cpu, null);
  at = 124_999; current = sample(700, 4000);
  assert.equal((await read(ID)).cpu, 80);
});

test('detail baseline memory is capped and recently sampled containers retain their baseline', async () => {
  let total = 0;
  const read = createContainerStatReader({ request: async () => {
    total++;
    return response(sample(total * 100, total * 1000));
  } });
  const id = (index) => index.toString(16).padStart(64, '0');
  for (let index = 0; index <= 256; index++) assert.equal((await read(id(index))).cpu, null);
  assert.equal((await read(id(0))).cpu, null, 'the oldest baseline is evicted past 256 containers');
  assert.equal((await read(id(256))).cpu, 40, 'a recently sampled container retains its own baseline');
});

test('invalid detail container identifiers do not reach Docker', async () => {
  let calls = 0;
  const read = createContainerStatReader({ request: async () => { calls++; return response(sample()); } });
  for (const id of ['', 'abc', '../stats', 'g'.repeat(64), 'a'.repeat(65)]) assert.equal(await read(id), null);
  assert.equal(calls, 0);
});
