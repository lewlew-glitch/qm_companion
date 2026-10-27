import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainerStatsReader } from '../src/docker-stats.js';

const container = (id = 'a') => ({ id: id.repeat(64), name: id, kind: 'other', state: 'running' });
const response = (json, status = 200) => ({ status, json });
const sample = (total = 100, system = 1000) => ({
  cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: system, online_cpus: 4 },
  memory_stats: { usage: 400, limit: 1000, stats: { inactive_file: 100 } },
  networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 2, tx_bytes: 3 } },
  blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 7 }, { op: 'Write', value: 9 }] },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('stats share the list and resource reads in flight and for ten seconds after completion', async () => {
  let clock = 0, lists = 0;
  const listing = deferred(), requests = [];
  const read = createContainerStatsReader({
    now: () => clock,
    listContainers: () => { lists++; return listing.promise; },
    request: async (method, path) => {
      requests.push([method, path]);
      return response(path.endsWith('/json') ? { RestartCount: 2 } : sample());
    },
  });
  const first = read(), second = read();
  assert.equal(first, second);
  assert.equal(lists, 1);
  assert.equal(requests.length, 0);
  clock = 5000;
  listing.resolve([container()]);
  const result = await first;
  assert.equal(result.stats[0].cpu, null);
  assert.equal(result.stats[0].memUsed, 300);
  assert.equal(result.stats[0].mem, 30);
  assert.deepEqual(result.stats[0].net, { rx: 12, tx: 23 });
  assert.deepEqual(result.stats[0].disk, { read: 7, write: 9 });
  clock = 14_999;
  assert.equal(await read(), result);
  assert.equal(lists, 1);
  assert.equal(requests.length, 2);
  clock = 15_000;
  await read();
  assert.equal(lists, 2);
  assert.equal(requests.length, 3, 'restart inspect stays cached for thirty seconds');
});

test('stats and inspect requests together never exceed four concurrent Docker requests', async () => {
  let active = 0, maximum = 0;
  const pending = [], requests = [];
  const rows = Array.from({ length: 9 }, (_, index) => container(String(index)));
  const read = createContainerStatsReader({
    listContainers: async () => rows,
    request: (method, path) => {
      requests.push([method, path]);
      active++; maximum = Math.max(maximum, active);
      return new Promise((resolve) => pending.push(() => {
        active--;
        resolve(response(path.endsWith('/json') ? { RestartCount: 0 } : sample()));
      }));
    },
  });
  let done = false;
  const result = read().then((value) => { done = true; return value; });
  await flush();
  assert.equal(active, 4);
  for (let round = 0; !done && round < 20; round++) {
    pending.splice(0).forEach((finish) => finish());
    await flush();
  }
  assert.equal(done, true);
  assert.equal((await result).stats.length, 9);
  assert.equal(maximum, 4);
  const stats = requests.filter(([, path]) => path.includes('/stats?'));
  assert.equal(stats.length, 9);
  assert.ok(stats.every(([method, path]) => method === 'GET' && path.endsWith('/stats?stream=false&one-shot=true')));
  assert.equal(requests.filter(([, path]) => path.endsWith('/json')).length, 9);
});

test('CPU uses successive shared samples and preserves idle, reset, and invalid readings', async () => {
  let clock = 0, index = 0;
  const samples = [sample(100, 1000), sample(300, 2000), sample(300, 3000), sample(1, 4000),
    sample(101, 5000), sample(201, 5000), sample(301, 4000), sample(401, NaN)];
  const read = createContainerStatsReader({ now: () => clock, listContainers: async () => [container()],
    request: async (method, path) => response(path.endsWith('/json') ? { RestartCount: 0 } : samples[index++]),
  });
  for (const expected of [null, 80, 0, null, 40, null, null, null]) {
    assert.equal((await read()).stats[0].cpu, expected);
    clock += 10_000;
  }
});

test('stats failures retain the ten second throttle and preserve successful containers', async () => {
  let clock = 0, listCalls = 0, requests = 0, listFails = true;
  const read = createContainerStatsReader({ now: () => clock,
    listContainers: async () => { listCalls++; return listFails ? null : [container('a'), container('b')]; },
    request: async (method, path) => {
      requests++;
      if (path.endsWith('/json')) return response({ RestartCount: 0 });
      return path.includes('/' + 'a'.repeat(64) + '/') ? response(sample()) : response(null, 0);
    },
  });
  assert.equal(await read(), null);
  listFails = false; clock = 9999;
  assert.equal(await read(), null);
  assert.equal(listCalls, 1); assert.equal(requests, 0);
  clock = 10_000;
  const result = await read();
  assert.equal(result.unavailable, 1); assert.equal(result.running, 2);
  assert.equal(result.stats.length, 1); assert.equal(result.stats[0].id, 'a'.repeat(64));
  clock = 19_999;
  assert.equal(await read(), result);
  assert.equal(requests, 4);
});

test('stopped containers discard their CPU and restart samples before returning', async () => {
  let clock = 0, running = true, total = 100, system = 1000, inspections = 0;
  const read = createContainerStatsReader({ now: () => clock,
    listContainers: async () => running ? [container()] : [],
    request: async (method, path) => response(path.endsWith('/json')
      ? { RestartCount: ++inspections } : sample(total, system)),
  });
  assert.equal((await read()).stats[0].cpu, null);
  clock = 10_000; total = 300; system = 2000;
  assert.equal((await read()).stats[0].cpu, 80);
  clock = 20_000; running = false;
  assert.deepEqual(await read(), { stats: [], running: 0, unavailable: 0 });
  clock = 30_000; running = true;
  const returned = (await read()).stats[0];
  assert.equal(returned.cpu, null);
  assert.equal(returned.restarts, 2);
});

test('failed restart inspections wait thirty seconds before another attempt', async () => {
  let clock = 0, inspections = 0;
  const read = createContainerStatsReader({ now: () => clock, listContainers: async () => [container()],
    request: async (method, path) => {
      if (!path.endsWith('/json')) return response(sample());
      inspections++; return response(null, 0);
    },
  });
  for (const at of [0, 10_000, 20_000]) {
    clock = at; assert.equal((await read()).stats[0].restarts, null);
  }
  assert.equal(inspections, 1);
  clock = 30_000; await read(); assert.equal(inspections, 2);
});

test('thrown list and stats adapters are throttled after failure', async () => {
  for (const failure of ['list', 'stats']) {
    let clock = 0, lists = 0;
    const read = createContainerStatsReader({ now: () => clock,
      listContainers: async () => { lists++; if (failure === 'list') throw new Error('offline'); return [container()]; },
      request: async () => { throw new Error('offline'); },
    });
    assert.equal(await read(), null);
    clock = 9999; assert.equal(await read(), null); assert.equal(lists, 1);
    clock = 10_000; assert.equal(await read(), null); assert.equal(lists, 2);
  }
});
