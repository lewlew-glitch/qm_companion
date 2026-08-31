import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('docker JSON reads honour a tcp DOCKER_HOST socket proxy', async (t) => {
  const requests = [];
  const containers = [
    {
      Id: 'a'.repeat(64), Names: ['/radarr-hd'], Image: 'lscr.io/linuxserver/radarr:latest',
      Ports: [{ Type: 'tcp', PrivatePort: 7878, PublicPort: 17878 }], Labels: {},
    },
    {
      Id: 'b'.repeat(64), Names: ['/radarr-4k'], Image: 'lscr.io/linuxserver/radarr:latest',
      Ports: [{ Type: 'tcp', PrivatePort: 7878, PublicPort: 27878 }], Labels: {},
    },
  ];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/too-large') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(20 * 1024 * 1024) });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/containers/json?all=1') res.end(JSON.stringify(containers));
    else if (req.url === '/volumes') res.end(JSON.stringify({ Volumes: [] }));
    else res.end(req.url === '/networks' ? '[]' : '{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const previousHost = process.env.DOCKER_HOST;
  const address = server.address();
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${address.port}`;
  t.after(() => {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  });
  const stackDir = mkdtempSync(join(tmpdir(), 'qm-detect-test-'));
  t.after(() => rmSync(stackDir, { recursive: true, force: true }));
  for (const [name, key] of [['radarr-hd', 'key-hd'], ['radarr-4k', 'key-4k']]) {
    const instanceDir = join(stackDir, name);
    mkdirSync(instanceDir);
    writeFileSync(join(instanceDir, 'config.xml'), `<Config><ApiKey>${key}</ApiKey><Port>7878</Port></Config>`);
  }

  const { dockerGetJson } = await import(`../src/docker.js?transport=${Date.now()}`);
  assert.deepEqual(await dockerGetJson('/containers/json?all=1'), containers);
  assert.equal(await dockerGetJson('/too-large'), null);
  const { detectServices } = await import(`../src/detect.js?transport=${Date.now()}`);
  const detected = await detectServices(stackDir);
  assert.equal(detected.length, 2);
  assert.deepEqual(detected.map((row) => row.port).sort(), [17878, 27878]);
  assert.deepEqual(detected.map((row) => row.apiKey).sort(), ['key-4k', 'key-hd']);
  assert.equal(requests.includes('GET /containers/json?all=1'), true);
  assert.equal(requests.some((request) => request.includes('/archive')), false);
});

test('one failed container stat does not blank every healthy row', async (t) => {
  const first = 'c'.repeat(64);
  const second = 'd'.repeat(64);
  const rows = [first, second].map((Id, index) => ({
    Id,
    Names: [`/service-${index + 1}`],
    Image: `example/service-${index + 1}:latest`,
    State: 'running',
    Status: 'Up 2 minutes',
    Ports: [],
    Labels: {},
  }));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/containers/json?all=1') return res.end(JSON.stringify(rows));
    if (req.url === `/containers/${first}/stats?stream=false`) {
      return res.end(JSON.stringify({
        cpu_stats: { cpu_usage: { total_usage: 200, percpu_usage: [200] }, system_cpu_usage: 1_000, online_cpus: 1 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
        memory_stats: { usage: 256, limit: 1024, stats: {} },
        networks: {},
        blkio_stats: {},
      }));
    }
    if (req.url === `/containers/${second}/stats?stream=false`) return res.end('{}');
    if (req.url === `/containers/${first}/json`) return res.end(JSON.stringify({ RestartCount: 2 }));
    if (req.url === `/containers/${second}/json`) return res.end(JSON.stringify({ RestartCount: 0 }));
    if (req.url === '/info') return res.end(JSON.stringify({ MemTotal: 4096 }));
    if (req.url === '/networks') return res.end('[]');
    if (req.url === '/volumes') return res.end(JSON.stringify({ Volumes: [] }));
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const previousHost = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${server.address().port}`;
  t.after(() => {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  });

  const { allContainerStats } = await import(`../src/docker.js?partial-stats=${Date.now()}`);
  const snapshot = await allContainerStats();
  assert.equal(snapshot.unavailable, 1);
  assert.equal(snapshot.stats.length, 1);
  assert.equal(snapshot.stats[0].id, first);
  assert.equal(snapshot.stats[0].restarts, 2);

  const dashboard = await import(`../src/docker.js?dashboard-partial=${Date.now()}`);
  const aggregate = await dashboard.dockerStats();
  assert.equal(aggregate.metricsUnavailable, 1);
  assert.equal(typeof aggregate.cpu, 'number');
  assert.equal(aggregate.mem, 6.25);
  assert.equal(aggregate.top.length, 1);
  assert.equal(aggregate.top[0].mem, 6.25);
  assert.equal(aggregate.disk.total, 0);
});
