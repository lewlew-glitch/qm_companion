import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskUsageCache } from '../src/docker-disk.js';

const response = (json, status = 200) => ({ status, json });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('disk scans start only when read and cold reads share a background scan', async () => {
  let clock = 0, calls = 0;
  const pending = deferred();
  const cache = createDiskUsageCache({ now: () => clock, request: (method, path) => {
    assert.equal(method, 'GET'); assert.equal(path, '/system/df');
    calls++; return pending.promise;
  } });
  clock = 2_000_000; await flush();
  assert.equal(calls, 0, 'idle time never starts a filesystem walk');
  assert.equal(cache.read(), null);
  assert.equal(cache.read(), null); assert.equal(calls, 1);
  const flight = cache.refresh();
  assert.equal(cache.refresh(true), flight, 'owner refresh joins the reader scan');
  pending.resolve(response({ LayersSize: 10 }));
  const result = await flight;
  assert.equal(cache.read(), result); assert.equal(result.disk.total, 10);
});

test('stale reads return immediately and refresh only images and build cache after the first walk', async () => {
  let clock = 0;
  const requests = [];
  const cache = createDiskUsageCache({ now: () => clock, request: (method, path) => {
    const pending = deferred(); requests.push({ path, pending }); return pending.promise;
  } });
  assert.equal(cache.read(), null); assert.equal(requests[0].path, '/system/df');
  clock = 5000; requests[0].pending.resolve(response({
    LayersSize: 10, Containers: [{ SizeRw: 5 }], Volumes: [{ Name: 'data', UsageData: { Size: 7 } }], BuildCache: [],
  }));
  const first = await cache.refresh();
  assert.equal(first.disk.total, 22); assert.equal(first.measuredAt, 5000);
  clock = 604_999;
  assert.equal(cache.read(), first); assert.equal(requests.length, 1);
  clock = 605_000;
  assert.equal(cache.read(), first, 'the stale value returns before Docker replies');
  for (let i = 0; i < 20; i++) assert.equal(cache.read(), first);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, '/system/df?type=image&type=build-cache', 'a background read never walks layers or volumes');
  requests[1].pending.resolve(response({ LayersSize: 20, Containers: null, Volumes: null, BuildCache: [{ Size: 3 }] }));
  await flush();
  const light = cache.read();
  assert.deepEqual(light.disk, { images: 20, containers: 5, volumes: 7, build: 3, total: 35 });
  assert.equal(light.volumes.data.size, 7); assert.equal(light.measuredAt, 5000, 'layer and volume sizes keep their own age');
  clock = 1_204_999; cache.read(); assert.equal(requests.length, 2);
  clock = 1_205_000; cache.read(); assert.equal(requests[2].path, '/system/df?type=image&type=build-cache');
});

test('an owner refresh during a background read still walks layers and volumes', async () => {
  let clock = 0;
  const requests = [];
  const cache = createDiskUsageCache({ now: () => clock, request: (method, path) => {
    const pending = deferred(); requests.push({ path, pending }); return pending.promise;
  } });
  cache.read(); requests[0].pending.resolve(response({ LayersSize: 10 })); await cache.refresh();
  clock = 600_000; cache.read();
  assert.equal(requests[1].path, '/system/df?type=image&type=build-cache');
  const forced = cache.refresh(true);
  assert.equal(requests.length, 2, 'the owner waits for the background read');
  requests[1].pending.resolve(response({ LayersSize: 20 })); await flush();
  assert.equal(requests[2].path, '/system/df');
  cache.refresh(true); cache.refresh(); assert.equal(requests.length, 3, 'later refreshes join the walk');
  requests[2].pending.resolve(response({ LayersSize: 30, Containers: [{ SizeRw: 1 }] }));
  assert.equal((await forced).disk.total, 31);
  assert.equal(requests.length, 3);
});

test('a Docker that ignores the type filter is only measured again on request', async () => {
  let clock = 0, calls = 0;
  const cache = createDiskUsageCache({ now: () => clock, request: async () => {
    calls++; return response({ LayersSize: 10, Containers: [], Volumes: [] });
  } });
  cache.read(); await flush();
  clock = 600_000; cache.read(); await flush();
  assert.equal(calls, 2);
  clock = 1_200_000; cache.read(); await flush();
  clock = 9_000_000; cache.read(); await flush();
  assert.equal(calls, 2, 'background reads stop once Docker answers a light read in full');
  assert.equal((await cache.refresh(true)).disk.total, 10); assert.equal(calls, 3);
});

test('owner refresh has a thirty second floor after every completed scan and shares in-flight work', async () => {
  let clock = 0;
  const requests = [];
  const cache = createDiskUsageCache({ now: () => clock, request: () => {
    const pending = deferred(); requests.push(pending); return pending.promise;
  } });
  cache.read();
  clock = 5000; requests[0].resolve(response({ LayersSize: 10 }));
  const first = await cache.refresh();
  clock = 34_999;
  assert.equal(await cache.refresh(true), first); assert.equal(requests.length, 1);
  clock = 35_000;
  const forced = cache.refresh(true);
  assert.equal(requests.length, 2);
  assert.equal(cache.refresh(true), forced); assert.equal(cache.refresh(), forced);
  assert.equal(cache.read(), first);
  clock = 200_000;
  assert.equal(cache.refresh(true), forced, 'a long scan is still shared after the floor elapses');
  requests[1].resolve(response({ LayersSize: 20 }));
  const second = await forced;
  clock = 229_999;
  assert.equal(await cache.refresh(true), second); assert.equal(requests.length, 2);
  clock = 230_000;
  const next = cache.refresh(true); assert.equal(requests.length, 3);
  requests[2].resolve(response({ LayersSize: 30 })); await next;
});

test('disk totals avoid shared-layer duplication and negative or invalid size sentinels', async () => {
  const cache = createDiskUsageCache({ request: async () => response({
    LayersSize: 100, Images: [{ Size: 900 }], Containers: [{ SizeRw: 20 }, { SizeRw: -1 }, null],
    Volumes: [{ Name: 'data', UsageData: { Size: 30 } }, { Name: 'unknown', UsageData: { Size: -1 } },
      { Name: 'absent' }, { Name: 'invalid', UsageData: { Size: NaN } },
      { Name: '__proto__', UsageData: { Size: 7 } }, null],
    BuildCache: [{ Size: 40 }, { Size: -1 }, { Size: Infinity }],
  }) });
  const result = await cache.refresh();
  assert.deepEqual(result.disk, { images: 100, containers: 20, volumes: 37, build: 40, total: 197 });
  assert.equal(result.volumes.unknown.size, -1); assert.equal(result.volumes.absent.size, -1);
  assert.equal(result.volumes.invalid.size, -1);
  assert.equal(Object.hasOwn(result.volumes, '__proto__'), true);
  assert.equal(result.volumes.__proto__.size, 7);
  const fallback = createDiskUsageCache({ request: async () => response({ Images: [{ Size: 10 }, { Size: -1 }] }) });
  assert.equal((await fallback.refresh()).disk.images, 10);
});

for (const [label, failed, expected] of [
  ['blocked', response(null, 403), 'blocked'], ['transport failure', response(null, 0), null],
  ['server error', response({}, 500), null], ['malformed data', response([]), null],
]) {
  test(`disk ${label} clears old data and throttles background and owner retries`, async () => {
    let clock = 0, calls = 0, next = response({ LayersSize: 10 });
    const cache = createDiskUsageCache({ now: () => clock, request: async () => { calls++; return next; } });
    const first = await cache.refresh();
    next = failed; clock = 600_000;
    assert.equal(cache.read(), first, 'a failed refresh cannot delay the stale read');
    assert.equal(await cache.refresh(), expected); assert.equal(cache.read(), expected);
    assert.equal(calls, 3, 'the background read and the walk after it both failed');
    next = response({ LayersSize: 20 }); clock = 629_999;
    assert.equal(await cache.refresh(true), expected); assert.equal(calls, 3);
    clock = 630_000;
    assert.equal((await cache.refresh(true)).disk.total, 20); assert.equal(calls, 4);
  });

  test(`disk ${label} retains a ten minute background failure window`, async () => {
    let clock = 0, calls = 0, next = failed;
    const cache = createDiskUsageCache({ now: () => clock, request: async () => { calls++; return next; } });
    cache.read(); assert.equal(await cache.refresh(), expected);
    next = response({ LayersSize: 20 }); clock = 599_999;
    assert.equal(cache.read(), expected); assert.equal(await cache.refresh(), expected); assert.equal(calls, 1);
    clock = 600_000;
    assert.equal(cache.read(), expected);
    assert.equal((await cache.refresh()).disk.total, 20); assert.equal(calls, 2);
  });
}

test('thrown disk adapters are caught in background and obey both retry windows', async () => {
  let clock = 0, calls = 0;
  const cache = createDiskUsageCache({ now: () => clock, request: async () => { calls++; throw new Error('offline'); } });
  assert.equal(cache.read(), null); await flush();
  assert.equal(calls, 1);
  clock = 29_999; assert.equal(await cache.refresh(true), null); assert.equal(calls, 1);
  clock = 30_000; assert.equal(await cache.refresh(true), null); assert.equal(calls, 2);
  clock = 629_999; assert.equal(cache.read(), null); await flush(); assert.equal(calls, 2);
  clock = 630_000; assert.equal(cache.read(), null); await flush(); assert.equal(calls, 3);
});
