import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fingerprintsFor, probeOne, probeScheme } from '../src/probe.js';
import { schemeFor } from '../src/kinds.js';

function selfSignedCert(dir) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('probe uses HTTPS kinds and Portainer overrides', () => {
  for (const kind of ['portainer', 'unifi', 'truenas', 'proxmox']) assert.equal(schemeFor(kind), 'https');
  for (const kind of ['radarr', 'sonarr', 'jellyfin', 'sabnzbd']) assert.equal(schemeFor(kind), 'http');
  const [plain] = fingerprintsFor('portainer', 9000);
  const [tls] = fingerprintsFor('portainer', 9443);
  assert.equal(probeScheme(plain), 'http', 'Portainer on 9000 is probed over http');
  assert.equal(probeScheme(tls), 'https', 'Portainer on 9443 is probed over https');
  assert.equal(probeScheme({ kind: 'radarr', port: 7878 }), 'http');
  assert.equal(probeScheme({ kind: 'unifi', port: 443 }), 'https');
  assert.equal(probeScheme({ kind: 'unifi', port: 8080, scheme: 'http' }), 'http', 'an explicit entry wins');
});

test('Portainer TLS probe accepts its self-signed certificate', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qm-probe-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tls = createHttpsServer(selfSignedCert(dir), (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Version: '2.21.0', InstanceID: 'portainer-test' }));
  });
  const plain = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Version: '2.21.0' }));
  });
  const tlsPort = await listen(tls);
  const plainPort = await listen(plain);
  t.after(() => new Promise((resolve) => tls.close(resolve)));
  t.after(() => new Promise((resolve) => plain.close(resolve)));

  const [entry9443] = fingerprintsFor('portainer', 9443);
  const [entry9000] = fingerprintsFor('portainer', 9000);
  const overTls = await probeOne('127.0.0.1', { ...entry9443, port: tlsPort }, 3000);
  assert.deepEqual(overTls, { kind: 'portainer', port: tlsPort, url: `https://127.0.0.1:${tlsPort}`, up: true, confirmed: true });
  const overPlain = await probeOne('127.0.0.1', { ...entry9000, port: plainPort }, 3000);
  assert.deepEqual(overPlain, { kind: 'portainer', port: plainPort, url: `http://127.0.0.1:${plainPort}`, up: true, confirmed: true }, 'the 9000 entry speaks plain http');

  const wrongWay = await probeOne('127.0.0.1', { ...entry9000, port: tlsPort }, 1500);
  assert.equal(wrongWay.up, false);
  const wrongWayBack = await probeOne('127.0.0.1', { ...entry9443, port: plainPort }, 1500);
  assert.equal(wrongWayBack.up, false);

  await assert.rejects(fetch(`https://127.0.0.1:${tlsPort}/api/system/status`), 'expected failure');
});

test('treats a login redirect as reachable', async () => {
  const server = createHttpServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Radarr</title></html>');
  });
  const port = await listen(server);
  try {
    const [fp] = fingerprintsFor('radarr', 7878);
    const result = await probeOne('127.0.0.1', { ...fp, port }, 3000);
    assert.equal(result.up, true);
    assert.equal(result.confirmed, true);
  } finally {
    server.close();
  }
});

test('does not follow a cross-origin redirect', async () => {
  let elsewhereHits = 0;
  const elsewhere = createHttpServer((_req, res) => {
    elsewhereHits += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Radarr</title></html>');
  });
  const elsewherePort = await listen(elsewhere);
  const redirector = createHttpServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${elsewherePort}/` });
    res.end();
  });
  const port = await listen(redirector);
  try {
    const [fp] = fingerprintsFor('radarr', 7878);
    const result = await probeOne('127.0.0.1', { ...fp, port }, 3000);
    assert.equal(elsewhereHits, 0);
    assert.equal(result.up, true);
    assert.equal(result.confirmed, false);
  } finally {
    redirector.close();
    elsewhere.close();
  }
});

test('redirects without Location count as reachable', async () => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(302);
    res.end();
  });
  const port = await listen(server);
  try {
    const [fp] = fingerprintsFor('radarr', 7878);
    const result = await probeOne('127.0.0.1', { ...fp, port }, 3000);
    assert.equal(result.up, true);
    assert.equal(result.confirmed, false);
  } finally {
    server.close();
  }
});

test('redirect chain follows one hop', async () => {
  let hops = 0;
  const server = createHttpServer((req, res) => {
    hops += 1;
    if (req.url === '/') { res.writeHead(302, { location: '/one' }); res.end(); return; }
    if (req.url === '/one') { res.writeHead(302, { location: '/two' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Radarr</title></html>');
  });
  const port = await listen(server);
  try {
    const [fp] = fingerprintsFor('radarr', 7878);
    const result = await probeOne('127.0.0.1', { ...fp, port }, 3000);
    assert.equal(hops, 2);
    assert.equal(result.up, true);
    assert.equal(result.confirmed, false);
  } finally {
    server.close();
  }
});

test('a service that answers 401 is reachable', async () => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/html' });
    res.end('<html><title>Radarr</title></html>');
  });
  const port = await listen(server);
  try {
    const [fp] = fingerprintsFor('radarr', 7878);
    const result = await probeOne('127.0.0.1', { ...fp, port }, 3000);
    assert.equal(result.up, true);
    assert.equal(result.confirmed, true);
  } finally {
    server.close();
  }
});

test('fetchTextBounded rejects redirects by default', async () => {
  const { fetchTextBounded } = await import('../src/net.js');
  const server = createHttpServer((_req, res) => {
    res.writeHead(302, { location: '/elsewhere' });
    res.end();
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      fetchTextBounded(`http://127.0.0.1:${port}/`, {}, { timeoutMs: 2000 }),
      'expected failure',
    );
    const seen = await fetchTextBounded(`http://127.0.0.1:${port}/`, {}, { timeoutMs: 2000, redirect: 'manual' });
    assert.equal(seen.response.status, 302, 'an opted-in caller sees the redirect instead');
  } finally {
    server.close();
  }
});
