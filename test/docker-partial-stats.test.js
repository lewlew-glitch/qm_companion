import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

test('dashboard totals measured CPU and marks newly started or unavailable containers as partial', async (t) => {
  const realNow = Date.now, previousHost = process.env.DOCKER_HOST;
  let clock = realNow(), generation = 0, secondFails = false, empty = false, diskReads = 0;
  Date.now = () => clock;
  t.after(() => {
    Date.now = realNow;
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  });
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  const daemon = createServer((req, res) => {
    const send = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/containers/json?all=1') return send((empty ? [] : generation ? [first, second] : [first]).map((id) => ({
      Id: id, Names: ['/' + id.slice(0, 6)], Image: 'example/app:1', State: 'running', Status: 'Up', Labels: {},
    })));
    if (req.url.includes('/stats?')) {
      assert.ok(req.url.endsWith('?stream=false&one-shot=true'));
      if (secondFails && req.url.includes(second)) return send({}, 500);
      return send({
        cpu_stats: { cpu_usage: { total_usage: 100 + generation * 200 }, system_cpu_usage: 1000 + generation * 1000, online_cpus: 4 },
        memory_stats: { usage: 300, limit: 1000 },
      });
    }
    if (req.url.endsWith('/json')) return send({ RestartCount: 0 });
    if (req.url === '/info') return send({ MemTotal: 2000, NCPU: 4 });
    if (req.url === '/networks') return send([]);
    if (req.url === '/volumes') return send({ Volumes: [] });
    if (req.url === '/system/df') { diskReads++; return send({ LayersSize: 0 }); }
    return send({});
  });
  await new Promise((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  t.after(() => { daemon.closeAllConnections(); return new Promise((resolve) => daemon.close(resolve)); });
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${daemon.address().port}`;
  const { allContainerStats, dockerStats } = await import('../src/docker.js');
  assert.equal(diskReads, 0);
  await allContainerStats();
  assert.equal(diskReads, 0, 'a container metrics read does not ask for storage');
  const cold = await dockerStats();
  assert.equal(cold.cpu, null);
  assert.equal(cold.cpuPartial, false, 'no measured total exists yet');
  assert.equal(cold.cpuUnavailable, 1);

  generation = 1; clock += 10_000;
  const started = await dockerStats();
  assert.equal(started.cpu, 80, 'a new container does not blank measured CPU');
  assert.equal(started.cpuPartial, true);
  assert.equal(started.cpuUnavailable, 1);
  assert.equal(started.metricsUnavailable, 0, 'the new container still has memory metrics');
  generation = 2; clock += 10_000;
  const complete = await dockerStats();
  assert.equal(complete.cpu, 160);
  assert.equal(complete.cpuPartial, false);
  assert.equal(complete.cpuUnavailable, 0);

  generation = 3; clock += 10_000; secondFails = true;
  const failed = await dockerStats();
  assert.equal(failed.cpu, 80);
  assert.equal(failed.cpuPartial, true);
  assert.equal(failed.cpuUnavailable, 1);
  assert.equal(failed.metricsUnavailable, 1);
  clock += 10_000; empty = true;
  const stopped = await dockerStats();
  assert.equal(stopped.cpu, 0);
  assert.equal(stopped.cpuPartial, false);
  assert.equal(stopped.cpuUnavailable, 0);
});
