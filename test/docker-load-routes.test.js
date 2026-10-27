import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('stats and summaries reuse Docker reads and only the owner can force disk refresh', async (t) => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  t.after(() => { Date.now = realNow; });
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-docker-load-routes-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const id = 'a'.repeat(64);
  const requests = [];
  let diskReads = 0, volumeSize = 30, holdDisk = false, diskStarted;
  const pendingDisk = [];
  const daemon = createServer((req, res) => {
    requests.push(req.url);
    const send = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/system/df') {
      diskReads++;
      const usage = { LayersSize: 100, Containers: [{ SizeRw: 20 }], Volumes: [
        { Name: 'data', UsageData: { Size: volumeSize } }, { Name: 'unsized', UsageData: { Size: -1 } },
      ], BuildCache: [] };
      if (holdDisk) {
        pendingDisk.push(() => send(usage));
        diskStarted?.();
        return;
      }
      return send(usage);
    }
    if (req.url === '/containers/json?all=1') return send([
      { Id: id, Names: ['/media'], Image: 'example/media:1', State: 'running', Status: 'Up 2 hours', Labels: {} },
    ]);
    if (req.url === `/containers/${id}/stats?stream=false&one-shot=true`) return send({
      cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000, online_cpus: 4 },
      memory_stats: { usage: 200, limit: 1000, stats: {} },
    });
    if (req.url === `/containers/${id}/json`) return send({ RestartCount: 2 });
    if (req.url === '/info') return send({ MemTotal: 2000, NCPU: 4 });
    if (req.url === '/networks') return send([]);
    if (req.url === '/volumes') return send({ Volumes: [] });
    return send([]);
  });
  await new Promise((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  t.after(() => { daemon.closeAllConnections(); return new Promise((resolve) => daemon.close(resolve)); });
  Object.assign(process.env, {
    DATA_DIR: dataDir, SECRET_KEY: '31'.repeat(32), QM_HOST: '127.0.0.1',
    DOCKER_HOST: `tcp://127.0.0.1:${daemon.address().port}`, MOBILE_API_ENABLED: 'false',
  });
  const { createPanelSurface } = await import('../src/server.js');
  const { createAuthPlane } = await import('../src/auth-plane.js');
  const { claimPassword, createSession } = await import('../src/auth.js');
  const { addApiToken } = await import('../src/store.js');
  const { systemDf } = await import('../src/docker.js');
  const { summaryDto } = await import('../src/mobile/summary.js');
  claimPassword('fixture-docker-load-password');
  const session = createSession();
  const bearer = 'qmc_' + 'b'.repeat(48);
  addApiToken({ id: 'load-reader', name: 'reader', prefix: bearer.slice(0, 10),
    hashHex: createHash('sha256').update(bearer).digest('hex'), createdAt: Date.now(), lastUsedAt: null });
  const authPlane = createAuthPlane({ sessionCookie: 'qm_test', formCookie: 'qm_test_form', secure: () => false });
  const surface = createPanelSurface({ authPlane });
  const panel = createServer((req, res) => surface(req, res));
  await new Promise((resolve) => panel.listen(0, '127.0.0.1', resolve));
  t.after(() => { panel.closeAllConnections(); return new Promise((resolve) => panel.close(resolve)); });
  const origin = `http://127.0.0.1:${panel.address().port}`;
  const ownerHeaders = { cookie: `qm_test=${session.token}` };
  const refreshHeaders = { ...ownerHeaders, 'x-csrf-token': session.csrf };
  const readerHeaders = { authorization: `Bearer ${bearer}` };
  assert.equal(diskReads, 0, 'an idle Companion never scans Docker storage');
  await systemDf();
  assert.equal(diskReads, 1, 'a reader starts the first scan');

  const responses = await Promise.all(['/api/docker/stats', '/api/containers/stats'].map((path) =>
    fetch(origin + path, { headers: readerHeaders })));
  for (const response of responses) assert.equal(response.status, 200);
  const [dashboard, containers] = await Promise.all(responses.map((response) => response.json()));
  assert.equal(dashboard.cpu, null);
  assert.equal(containers.stats[0].cpu, null);
  assert.equal(containers.stats[0].restarts, 2);
  assert.equal(dashboard.disk.total, 150);
  assert.equal(requests.filter((path) => path.includes('/stats?')).length, 1);
  const afterSample = requests.length;
  await Promise.all(['/api/docker/stats', '/api/containers/stats'].map((path) => fetch(origin + path, { headers: readerHeaders })));
  assert.equal(requests.length, afterSample, 'cached stats do not make any Docker requests');

  const summary = await summaryDto();
  assert.deepEqual(summary.dockerStorage, { volumesTotal: 2, volumesMeasured: 1, volumesBytes: 30 });
  assert.equal(diskReads, 1, 'the mobile summary reads cached storage');
  assert.equal((await fetch(origin + '/api/docker/df?refresh=1')).status, 401);
  const reader = await fetch(origin + '/api/docker/df?refresh=1', { headers: readerHeaders });
  assert.equal(reader.status, 200);
  assert.equal(diskReads, 1, 'a read token cannot force a scan');
  assert.equal((await fetch(origin + '/api/docker/df?refresh=1', { headers: ownerHeaders })).status, 200);
  assert.equal(diskReads, 1, 'GET cannot force a new scan, even for the owner');
  const post = (headers) => fetch(origin + '/api/docker/df', { method: 'POST', headers });
  assert.equal((await post()).status, 401);
  assert.equal((await post(readerHeaders)).status, 401, 'a read token cannot POST');
  assert.equal((await post(ownerHeaders)).status, 403, 'owner refresh requires a CSRF token');
  assert.equal((await post({ ...ownerHeaders, 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal(diskReads, 1, 'refused refreshes never touch Docker storage');
  assert.equal((await post(refreshHeaders)).status, 200);
  assert.equal(diskReads, 1, 'even a valid owner refresh observes the thirty second floor');
  clock += 30_000;
  const refreshed = await post(refreshHeaders);
  assert.equal(refreshed.status, 200);
  assert.equal(diskReads, 2, 'the signed-in owner can explicitly refresh');
  assert.equal((await post(refreshHeaders)).status, 200);
  assert.equal(diskReads, 2, 'repeated taps cannot run back-to-back scans');

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(origin + '/api/stream?topics=stats', { headers: ownerHeaders, signal: controller.signal });
  assert.equal(stream.status, 200);
  const readerStream = stream.body.getReader();
  let frame = '';
  while (!frame.includes('event: stats')) {
    const { value, done } = await readerStream.read();
    assert.equal(done, false);
    frame += new TextDecoder().decode(value);
  }
  assert.match(frame, /"cpu":null/);
  assert.match(frame, /"total":150/);
  assert.equal(requests.filter((path) => path.includes('/stats?')).length, 2, 'the live stream refreshes one expired stats snapshot');
  controller.abort();

  clock += 10 * 60_000;
  holdDisk = true;
  volumeSize = 50;
  const started = new Promise((resolve) => { diskStarted = resolve; });
  const summaries = await Promise.all([summaryDto(), summaryDto()]);
  assert.ok(summaries.every((value) => value.dockerStorage.volumesBytes === 30), 'stale summaries return without waiting for Docker');
  await started;
  assert.equal(diskReads, 3, 'concurrent phone reads start exactly one stale refresh');
  pendingDisk.splice(0).forEach((finish) => finish());
  const fresh = await systemDf();
  assert.equal(fresh.volumes.data.size, 50);
  assert.equal(diskReads, 3, 'waiting for the stale refresh joins the existing scan');
});
