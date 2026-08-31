import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const RUNNING_ID = 'a'.repeat(64);
const EXITED_ID = 'b'.repeat(64);

function jsonRes(res, value) {
  const body = JSON.stringify(value);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const daemon = createServer((req, res) => {
  const path = req.url;
  if (path === '/containers/json?all=1') {
    return jsonRes(res, [
      { Id: RUNNING_ID, Names: ['/jellyfin'], Image: 'jellyfin/jellyfin:latest', State: 'running', Status: 'Up 3 days (healthy)', Ports: [{ PrivatePort: 8096, PublicPort: 8096, Type: 'tcp' }], Labels: {} },
      { Id: EXITED_ID, Names: ['/backup'], Image: 'example/backup:1', State: 'exited', Status: 'Exited (3) 2 hours ago', Ports: [], Labels: {} },
    ]);
  }
  if (path === '/info') return jsonRes(res, { Name: 'nas', ServerVersion: '29.4.3', OperatingSystem: 'Debian', Architecture: 'x86_64', NCPU: 4, MemTotal: 8 * 1024 ** 3, Images: 2 });
  if (path === '/networks') return jsonRes(res, []);
  if (path === '/volumes') return jsonRes(res, { Volumes: [] });
  if (path === '/system/df') return jsonRes(res, { LayersSize: 0, Images: [], Containers: [], Volumes: [], BuildCache: [] });
  if (path === '/images/json') return jsonRes(res, []);
  if (path === `/containers/${RUNNING_ID}/stats?stream=false`) {
    return jsonRes(res, {
      cpu_stats: { cpu_usage: { total_usage: 400 }, system_cpu_usage: 2000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 500 * 1024 ** 2, limit: 2 * 1024 ** 3, stats: { inactive_file: 100 * 1024 ** 2 } },
    });
  }
  if (path === `/containers/${RUNNING_ID}/json`) {
    return jsonRes(res, { Id: RUNNING_ID, Created: '2026-08-01T10:00:00Z', RestartCount: 2, State: { Running: true, StartedAt: '2026-08-25T09:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 }, Config: { Labels: {} } });
  }
  if (path === `/containers/${EXITED_ID}/json`) {
    return jsonRes(res, { Id: EXITED_ID, Created: '2026-08-01T10:00:00Z', RestartCount: 0, State: { Running: false, StartedAt: '2026-08-27T09:00:00Z', FinishedAt: '2026-08-27T22:00:00Z', ExitCode: 3 }, Config: { Labels: {} } });
  }
  res.writeHead(404).end();
});
await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
test.after(() => new Promise((r) => daemon.close(r)));

process.env.SECRET_KEY = 'ab'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-depth-'));
process.env.QM_HOST = '127.0.0.1';
process.env.DOCKER_HOST = `tcp://127.0.0.1:${daemon.address().port}`;

const { summaryDto, updatesDto, containerDetailDto } = await import('../src/mobile/summary.js');
const { createMobileRouter, resetMobileLimitersForTest, MOBILE_CAPABILITIES } = await import('../src/mobile/routes.js');
const { hostProcMetrics, resetHostProcMetricsForTest } = await import('../src/docker.js');
const { existsSync, writeFileSync: wf } = await import('node:fs');

test('reads host CPU and memory from /proc', () => {
  resetHostProcMetricsForTest();
  const dir = mkdtempSync(join(tmpdir(), 'qm-proc-'));
  const statPath = join(dir, 'stat');
  const memPath = join(dir, 'meminfo');
  wf(statPath, 'cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 0 1 1 0 0 0 0\ncpu1 1 0 1 1 0 0 0 0\ncpu2 1 0 1 1 0 0 0 0\ncpu3 1 0 1 1 0 0 0 0\n');
  wf(memPath, 'MemTotal:       8000000 kB\nMemFree:        1000000 kB\nMemAvailable:   6000000 kB\n');
  const first = hostProcMetrics(statPath, memPath);
  assert.equal(first.cpuPct, undefined);
  assert.equal(first.cpuCores, 4);
  assert.ok(Math.abs(first.memPct - 25) < 0.01, `2GB of 8GB in use, got ${first.memPct}`);
  wf(statPath, 'cpu  300 0 300 1200 200 0 0 0 0 0\ncpu0 1 0 1 1 0 0 0 0\ncpu1 1 0 1 1 0 0 0 0\ncpu2 1 0 1 1 0 0 0 0\ncpu3 1 0 1 1 0 0 0 0\n');
  const second = hostProcMetrics(statPath, memPath);
  assert.ok(Math.abs(second.cpuPct - 40) < 0.01, `400 busy of 1000 ticks, got ${second.cpuPct}`);
});

test('missing /proc returns no metrics group', () => {
  resetHostProcMetricsForTest();
  assert.equal(hostProcMetrics('/nonexistent/stat', '/nonexistent/meminfo'), null);
});

test('summary metrics use the host kind', async () => {
  const out = await summaryDto();
  assert.equal(out.docker, 'available');
  if (existsSync('/proc/stat')) {
    if (out.metrics) {
      for (const key of Object.keys(out.metrics)) {
        assert.ok(['cpuPct', 'cpuCores', 'memPct', 'tempC', 'driveTempC', 'driveCount'].includes(key), key);
      }
    }
  } else {
    assert.ok(!out.metrics || out.metrics.cpuPct === undefined, `no /proc, yet cpuPct=${out.metrics?.cpuPct}`);
  }
});

test('a stale update read starts one background check and reports it', async () => {
  let warms = 0;
  const slowWarm = () => new Promise((resolve) => { warms += 1; setTimeout(resolve, 30); });
  const first = await updatesDto(slowWarm);
  assert.equal(first.docker, 'available');
  assert.equal(first.checking, true);
  assert.equal(first.checkedAt, null);
  const second = await updatesDto(slowWarm);
  assert.equal(second.checking, true);
  assert.equal(warms, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const third = await updatesDto(slowWarm);
  assert.equal(third.checking, false);
  assert.equal(warms, 1, 'and the debounce holds afterwards');
  assert.equal(third.checkFailed, true);
});

test('meta capabilities name the detail route that gates drill-in', () => {
  assert.ok(MOBILE_CAPABILITIES.includes('containers.detail'));
});

test('container detail omits topology data', async () => {
  const running = await containerDetailDto(RUNNING_ID.slice(0, 12));
  assert.equal(running.docker, 'available');
  const c = running.container;
  assert.equal(c.name, 'jellyfin');
  assert.equal(c.restarts, 2);
  assert.ok(c.startedAt > 0, 'a running container states when it started');
  assert.ok(Math.abs(c.cpuPct - 80) < 0.01, 'live cpu in docker convention, 100 = one core');
  assert.equal(c.memBytes, 400 * 1024 ** 2);
  assert.equal(c.memLimitBytes, 2 * 1024 ** 3);
  for (const forbidden of ['ports', 'env', 'mounts', 'labels', 'networks', 'ip']) {
    assert.ok(!(forbidden in c), `no ${forbidden} on the device DTO`);
  }

  const exited = await containerDetailDto(EXITED_ID.slice(0, 12));
  assert.equal(exited.container.exitCode, 3);
  assert.ok(exited.container.finishedAt > 0);
  assert.ok(!('cpuPct' in exited.container));

  const missing = await containerDetailDto('c'.repeat(12));
  assert.equal(missing.container, null, 'an unknown id returns null');
});

test('the detail route is bearer-gated like every other read', async () => {
  resetMobileLimitersForTest();
  const route = createMobileRouter({ origin: 'https://127.0.0.1:8788', tlsLeafFingerprint: 'ee'.repeat(32) }, { enrolment: false });
  const server = createServer((req, res) => route(req, res).catch(() => res.end()));
  const base = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  try {
    const anon = await fetch(`${base}/api/mobile/v1/containers/${RUNNING_ID.slice(0, 12)}`);
    assert.equal(anon.status, 401);
    const badId = await fetch(`${base}/api/mobile/v1/containers/not-a-real-id`);
    assert.equal(badId.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
