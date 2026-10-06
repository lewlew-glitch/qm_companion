// Reachability and service identity when a web page exceeds the probe limit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';

import { mergeLiveProbes } from '../src/detect.js';
import { fingerprintsFor, probeInstance, probeOne } from '../src/probe.js';

const SAB_PAGE = `<!DOCTYPE html><html><head><title data-bind="text: title">SABnzbd</title></head><body><script>${'x'.repeat(300 * 1024)}</script></body></html>`;
const VERSION_PATH = '/api?mode=version&output=json';

function serve(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function sabnzbd(seen, { declared = true } = {}) {
  return serve((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'], cookie: req.headers.cookie });
    if (req.url === VERSION_PATH) {
      res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' }).end('{"version":"5.1.3"}');
      return;
    }
    if (req.url !== '/') { res.writeHead(404).end(); return; }
    if (declared) {
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'content-length': Buffer.byteLength(SAB_PAGE) }).end(SAB_PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
    for (let at = 0; at < SAB_PAGE.length; at += 16 * 1024) res.write(SAB_PAGE.slice(at, at + 16 * 1024));
    res.end();
  });
}

const sabRow = (port) => ({
  instanceId: 'sabnzbd-test', instanceKey: 'sabnzbd-test', kind: 'sabnzbd', name: 'sabnzbd', port,
  publishedPort: port, containerPort: 8080, sources: ['docker'], dockerState: 'running',
});

test('a page larger than the probe limit still proves the service is up', async () => {
  const [sab] = fingerprintsFor('sabnzbd', 8080);
  const [qbittorrent] = fingerprintsFor('qbittorrent', 8080);
  for (const declared of [true, false]) {
    const { server, port } = await sabnzbd([], { declared });
    try {
      const page = await probeOne('127.0.0.1', { ...sab, port, path: '/' }, 3000);
      assert.equal(page.up, true, `declared length ${declared}`);
      assert.equal(page.confirmed, true, 'the start of the page still identifies SABnzbd');
      const neighbour = await probeOne('127.0.0.1', { ...qbittorrent, port }, 3000);
      assert.equal(neighbour.up, true, 'another kind sharing 8080 is not marked down by the large page');
      assert.equal(neighbour.confirmed, false);
      const technitium = await probeInstance('127.0.0.1', {
        instanceId: 'technitium-test', kind: 'technitium', publishedPort: port, containerPort: 5380,
        sources: ['docker'], dockerState: 'running',
      }, 3000);
      assert.equal(technitium.up, true, 'a Docker-identified root page over the limit is reachable');
      assert.equal(technitium.confirmed, true);
    } finally {
      await close(server);
    }
  }
});

test('sabnzbd is identified by its version answer without requesting its page or sending credentials', async () => {
  const seen = [];
  const { server, port } = await sabnzbd(seen);
  try {
    const [sab] = fingerprintsFor('sabnzbd', 8080);
    const swept = await probeOne('127.0.0.1', { ...sab, port }, 3000);
    assert.deepEqual(swept, { kind: 'sabnzbd', port, url: `http://127.0.0.1:${port}`, up: true, confirmed: true });
    const instance = await probeInstance('127.0.0.1', sabRow(port), 3000);
    assert.equal(instance.up, true);
    assert.equal(instance.confirmed, true);
    assert.deepEqual(seen, Array.from({ length: 2 }, () => ({
      path: VERSION_PATH, authorization: undefined, apiKey: undefined, cookie: undefined,
    })));
    const [row] = mergeLiveProbes([sabRow(port)], [swept, instance], '127.0.0.1');
    assert.equal(row.availability, 'reachable');
  } finally {
    await close(server);
  }
});

test('only a sabnzbd-shaped version answer or product name confirms sabnzbd', async () => {
  let status = 200;
  let body = '';
  let name = '';
  const { server, port } = await serve((_req, res) => { res.writeHead(status, name ? { server: name } : {}).end(body); });
  try {
    const [sab] = fingerprintsFor('sabnzbd', 8080);
    const cases = [
      [200, '{"version":"5.1.3"}', true],
      [200, '{"version":"5.2.0Beta2"}', true],
      [403, 'Access denied - Hostname verification failed: https://sabnzbd.org/hostname-check', true],
      [200, '<html><title>SABnzbd - Login</title></html>', true],
      [401, 'Unauthorised', true, 'SABnzbd'],
      [200, '{"version":"5.1.3","name":"other"}', false],
      [200, '{"version":"latest"}', false],
      [200, '{"version":5}', false],
      [200, '["5.1.3"]', false],
      [200, '[{"version":"5.1.3"}]', false],
      [200, '{"status":"up"}', false],
      [404, 'Not Found', false],
    ];
    for (const [code, text, confirmed, serverName = ''] of cases) {
      status = code;
      body = text;
      name = serverName;
      const result = await probeOne('127.0.0.1', { ...sab, port }, 3000);
      assert.equal(result.up, true, text);
      assert.equal(result.confirmed, confirmed, text);
    }
  } finally {
    await close(server);
  }
});

test('an unreachable sabnzbd is still down', async () => {
  const [sab] = fingerprintsFor('sabnzbd', 8080);
  const dead = await freePort();
  assert.equal((await probeOne('127.0.0.1', { ...sab, port: dead }, 1500)).up, false);
  const instance = await probeInstance('127.0.0.1', sabRow(dead), 1500);
  assert.equal(instance.up, false);
  assert.equal(mergeLiveProbes([sabRow(dead)], [instance], '127.0.0.1')[0].availability, 'unreachable');

  const held = new Set();
  const silent = createNetServer((socket) => { held.add(socket); });
  const silentPort = await new Promise((resolve, reject) => {
    silent.once('error', reject);
    silent.listen(0, '127.0.0.1', () => resolve(silent.address().port));
  });
  try {
    assert.equal((await probeOne('127.0.0.1', { ...sab, port: silentPort }, 300)).up, false, 'a port that never answers is down');
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  }
});
