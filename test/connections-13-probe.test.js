import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fingerprintsFor, probeOne, probeInstance, instanceProbeTarget } from '../src/probe.js';
import { PORTS } from '../src/kinds.js';

test('new discovery fingerprints identify products without mistaking a login or product mention for one', async (t) => {
  let status = 200;
  let body = '';
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    assert.equal(request.headers.authorization, undefined, 'discovery never sends stored credentials');
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  const port = server.address().port;
  for (const [kind, valid] of [
    ['uptimekuma', '<html><title>Uptime Kuma</title></html>'],
    ['pulsarr', '<html><title>Pulsarr</title></html>'],
    ['peanut', JSON.stringify({ name: 'peanut', version: '6.0.0' })],
  ]) {
    const [fp] = fingerprintsFor(kind, PORTS[kind]);
    body = valid;
    status = 200;
    assert.equal((await probeOne('127.0.0.1', { ...fp, port }, 2000)).confirmed, true);
    for (const invalid of ['<title>Sign in</title>', `This server links to ${kind}`, '<html>{"name":"peanut"}</html>', '{"nested":{"name":"peanut"}}']) {
      body = invalid;
      assert.equal((await probeOne('127.0.0.1', { ...fp, port }, 2000)).confirmed, false, `${kind} rejects a generic mention`);
    }
    body = 'Unauthorized';
    status = 401;
    assert.equal((await probeOne('127.0.0.1', { ...fp, port }, 2000)).confirmed, false);
    const row = { instanceId: `${kind}-mapped`, kind, containerPort: PORTS[kind], publishedPort: port };
    assert.equal(instanceProbeTarget(row).publishedPort, port);
    assert.equal((await probeInstance('127.0.0.1', row, 2000)).confirmed, true,
      'a refusal proves reachability only when Docker already identified the service');
  }
  assert.ok(seen.includes('/api/v1/info'));
});
