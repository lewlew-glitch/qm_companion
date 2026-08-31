import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';


async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function listen(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}

async function waitForServer(origin, child) {
  let last;
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.status === 200) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw last || new Error('server did not start');
}

async function waitForSetupToken(output, child) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const match = /first-run setup token: ([A-Za-z0-9_-]{43})/.exec(output());
    if (match) return match[1];
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('server did not print a setup token');
}

function responseCookie(response, name) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(values.join(', '));
  return match ? `${name}=${match[1]}` : '';
}

function dualStack(privatePort, publicPort) {
  return [
    { IP: '0.0.0.0', PrivatePort: privatePort, PublicPort: publicPort, Type: 'tcp' },
    { IP: '::', PrivatePort: privatePort, PublicPort: publicPort, Type: 'tcp' },
  ];
}

function container(name, id, image, ports) {
  return {
    Id: String(id).repeat(64),
    Names: [`/${name}`],
    Image: image,
    State: 'running',
    Labels: {},
    Ports: ports,
  };
}

const DOCKHAND_PORT = 6010;
const PIHOLE_PORT = 8888;
const STREAMYSTATS_PORT = 3010;

test('remapped ports bind probe results to their instance', async (t) => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-published-port-'));
  const containers = [
    container('dockhand', 1, 'fnsys/dockhand:latest', dualStack(3000, DOCKHAND_PORT)),
    container('pihole', 2, 'pihole/pihole:latest', dualStack(80, PIHOLE_PORT)),
    container('streamystats', 3, 'ghcr.io/fredrikburmester/streamystats-aio:latest', dualStack(3000, STREAMYSTATS_PORT)),
    container('glances-a', 4, 'nicolargo/glances:latest-full', []),
    container('glances-b', 5, 'nicolargo/glances:latest-full', []),
  ];
  const daemon = createHttpServer((req, res) => {
    if (req.url === '/containers/json?all=1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(containers));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(daemon, 0);

  const dockhand = createHttpServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end('<html><title>Sign in</title></html>');
  });
  await listen(dockhand, DOCKHAND_PORT);

  const pihole = createHttpServer((req, res) => {
    if (req.url.startsWith('/admin')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><title>Login</title><body>password required</body></html>');
      return;
    }
    res.writeHead(404).end();
  });
  await listen(pihole, PIHOLE_PORT);

  const streamystats = createHttpServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
  });
  await listen(streamystats, STREAMYSTATS_PORT);

  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '4e'.repeat(32),
      DATA_DIR: dataDir,
      QM_HOST: '127.0.0.1',
      BIND_ADDRESS: '127.0.0.1',
      PORT: String(port),
      DOCKER_HOST: `tcp://127.0.0.1:${daemon.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill('SIGTERM');
    for (const server of [daemon, dockhand, pihole, streamystats]) server.closeAllConnections();
    for (const server of [daemon, dockhand, pihole, streamystats]) {
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(origin, child);
  const setupToken = await waitForSetupToken(() => stdout, child);
  const claim = await fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken, password: 'correct-owner-password' }).toString(),
    redirect: 'manual',
  });
  assert.equal(claim.status, 303, stderr);
  const sessionCookie = responseCookie(claim, 'qm_sess');

  const page = await fetch(`${origin}/pair`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
  assert.equal(page.status, 200, stderr);
  const html = await page.text();

  const rowFor = (name) => {
    const at = html.indexOf(`<b>${name}</b>`);
    assert.notEqual(at, -1, `the ${name} row is on the page`);
    return html.slice(html.lastIndexOf('<section class="pair-service', at), html.indexOf('</section>', at));
  };

  for (const [name, published] of [['dockhand', DOCKHAND_PORT], ['pihole', PIHOLE_PORT], ['streamystats', STREAMYSTATS_PORT]]) {
    const row = rowFor(name);
    const index = (row.match(/name="service_(\d+)"/) || [])[1];
    assert.ok(index !== undefined, `the ${name} row is a real form row`);
    assert.match(row, /data-avail="reachable"/, `${name}: the published route answered, so the row is reachable`);
    assert.match(row, new RegExp(`name="include_${index}" checked`), `${name}: reachable means preselected`);
    assert.doesNotMatch(row, new RegExp(`include_${index}"[^>]*disabled`), `${name}: and its tick box is live`);
    assert.match(row, new RegExp(`port ${published}<`), `${name}: the row names the published port`);
    assert.match(row, new RegExp(`id="base_${index}"[^>]*value="http://127\\.0\\.0\\.1:${published}"`), `${name}: the phone is handed the published address`);
    assert.doesNotMatch(row, /Companion could not reach it/, `${name}: no unreachable verdict for a route that answered`);
  }

  for (const name of ['glances-a', 'glances-b']) {
    const row = rowFor(name);
    assert.match(row, /data-avail="unverified"/, `${name}: no published address means no verdict`);
    assert.match(row, /Running in Docker\. Companion has not checked its published address\./, `${name}: the note owns what was not checked`);
    assert.doesNotMatch(row, /has no Docker state/, `${name}: Docker state is the one thing Companion does have`);
  }
});

test('probes public ports using container-port protocol metadata', async () => {
  const { instanceProbeTarget } = await import('../src/probe.js');
  assert.deepEqual(instanceProbeTarget({ kind: 'dockhand', containerPort: 3000, publishedPort: 6010 }), {
    scheme: 'http', path: '/api/health', sig: /dockhand/i, publishedPort: 6010,
  });
  const pihole = instanceProbeTarget({ kind: 'pihole', containerPort: 80, publishedPort: 8888 });
  assert.equal(pihole.scheme, 'http');
  assert.equal(pihole.path, '/admin/');
  assert.equal(pihole.publishedPort, 8888);
  assert.equal(instanceProbeTarget({ kind: 'portainer', containerPort: 9443, publishedPort: 19443 }).scheme, 'https');
  assert.equal(instanceProbeTarget({ kind: 'portainer', containerPort: 9000, publishedPort: 18000 }).scheme, 'http');
  assert.equal(instanceProbeTarget({ kind: 'glances' }), undefined);
  assert.equal(instanceProbeTarget({ kind: 'glances', publishedPort: 61208 }), undefined);
});

test('instance probes bind by instanceId', async () => {
  const { mergeLiveProbes } = await import('../src/detect.js');
  const rows = [
    { instanceId: 'dockhand-aaaa', instanceKey: 'dockhand-aaaa', kind: 'dockhand', name: 'dockhand-a', port: 6010, publishedPort: 6010, containerPort: 3000, sources: ['docker'], dockerState: 'running' },
    { instanceId: 'dockhand-bbbb', instanceKey: 'dockhand-bbbb', kind: 'dockhand', name: 'dockhand-b', port: 6010, publishedPort: 6010, containerPort: 3000, sources: ['docker'], dockerState: 'running' },
  ];
  const merged = mergeLiveProbes(rows, [
    { instanceId: 'dockhand-aaaa', kind: 'dockhand', port: 6010, url: 'http://h:6010', up: true, confirmed: true },
    { instanceId: 'dockhand-gone', kind: 'dockhand', port: 6010, url: 'http://h:6010', up: true, confirmed: true },
  ], 'h');
  assert.equal(merged.length, 2);
  const a = merged.find((row) => row.instanceId === 'dockhand-aaaa');
  const b = merged.find((row) => row.instanceId === 'dockhand-bbbb');
  assert.equal(a.availability, 'reachable', 'the probed instance is reachable');
  assert.equal(b.availability, 'unverified', 'its twin on the same kind and port is untouched');
});

test('unconfirmed instance probes remain unverified', async () => {
  const { mergeLiveProbes } = await import('../src/detect.js');
  const rows = [
    { instanceId: 'dockhand-cccc', instanceKey: 'dockhand-cccc', kind: 'dockhand', name: 'dockhand-c', port: 6010, publishedPort: 6010, containerPort: 3000, sources: ['docker'], dockerState: 'running' },
  ];
  const merged = mergeLiveProbes(rows, [
    { instanceId: 'dockhand-cccc', kind: 'dockhand', port: 6010, url: 'http://h:6010', up: true, confirmed: false },
  ], 'h');
  assert.equal(merged[0].availability, 'unverified', 'no verdict is invented from an unproving answer');
  assert.equal(merged[0].up, null, 'and the row is not marked up');
});

test('handles live and dead alternate published ports', async () => {
  const { probeInstance } = await import('../src/probe.js');
  const deadPrimary = await freePort();
  const deadAlternate = await freePort();
  const alternate = createHttpServer((req, res) => { res.writeHead(200).end('up'); });
  const alternatePort = await new Promise((resolve, reject) => {
    alternate.once('error', reject);
    alternate.listen(0, '127.0.0.1', () => resolve(alternate.address().port));
  });
  try {
    const softened = await probeInstance('127.0.0.1', {
      instanceId: 'dockhand-x', kind: 'dockhand', publishedPort: deadPrimary, containerPort: 3000,
      publishedPortAlternates: [alternatePort], sources: ['docker'], dockerState: 'running',
    }, 1500);
    assert.equal(softened.up, true);
    assert.equal(softened.confirmed, false);
    const dead = await probeInstance('127.0.0.1', {
      instanceId: 'dockhand-y', kind: 'dockhand', publishedPort: deadPrimary, containerPort: 3000,
      publishedPortAlternates: [deadAlternate], sources: ['docker'], dockerState: 'running',
    }, 1500);
    assert.equal(dead.up, false);
  } finally {
    alternate.closeAllConnections();
    await new Promise((resolve) => alternate.close(resolve));
  }
});

test('HTTPS probes follow one same-origin login redirect', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync: mkTls, readFileSync, rmSync: rmTls } = await import('node:fs');
  const { createServer: createHttpsServer } = await import('node:https');
  const dir = mkTls(join(tmpdir(), 'qm-instance-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  const tls = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  const server = createHttpsServer(tls, (req, res) => {
    if (req.url === '/') { res.writeHead(302, { location: '/login' }).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><title>Sign in</title></html>');
  });
  const tlsPort = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmTls(dir, { recursive: true, force: true });
  });
  const { probeInstance, instanceProbeTarget } = await import('../src/probe.js');
  const row = { instanceId: 'unifi-x', kind: 'unifi', publishedPort: tlsPort, containerPort: 8443, sources: ['docker'], dockerState: 'running' };
  assert.equal(instanceProbeTarget(row).scheme, 'https', 'the kind default makes this a TLS dial');
  const result = await probeInstance('127.0.0.1', row, 2500);
  assert.equal(result.up, true);
  assert.equal(result.confirmed, true);
});
