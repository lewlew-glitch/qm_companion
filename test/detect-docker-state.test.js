import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

test('maps Docker lifecycle state to service availability', async (t) => {
  const states = ['running', 'exited', 'created', 'paused', 'restarting', 'dead', 'removing'];
  const containers = states.map((state, index) => ({
    Id: index.toString(16).padStart(64, '0'),
    Names: [`/radarr-${state}`],
    Image: 'lscr.io/linuxserver/radarr:latest',
    State: state,
    Ports: state === 'running' ? [{ Type: 'tcp', PrivatePort: 7878, PublicPort: 17878 }] : [],
    Labels: {},
  }));
  const server = createServer((req, res) => {
    if (req.url === '/containers/json?all=1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(containers));
      return;
    }
    res.writeHead(404).end();
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

  const { detectServices, mergeLiveProbes } = await import(`../src/detect.js?docker-state=${Date.now()}`);
  const detected = await detectServices(undefined);
  assert.equal(detected.length, states.length);
  for (const state of states) {
    const row = detected.find((candidate) => candidate.name === `radarr-${state}`);
    assert.equal(row.dockerState, state, `${state} is carried verbatim`);
    assert.equal(row.availability, state === 'running' ? 'unverified' : 'not-running', `${state} before any probe`);
    assert.equal(row.up, state === 'running' ? undefined : false);
  }
  const probed = mergeLiveProbes(detected, [{ kind: 'radarr', port: 17878, up: true, confirmed: true, url: 'http://nas:17878' }], 'nas');
  assert.equal(probed.find((row) => row.name === 'radarr-running').availability, 'reachable');
  assert.equal(probed.filter((row) => row.availability === 'not-running').length, states.length - 1);
});
