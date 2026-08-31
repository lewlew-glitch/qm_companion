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

function sonarr(name, id, ports) {
  return {
    Id: String(id).repeat(64),
    Names: [`/${name}`],
    Image: 'lscr.io/linuxserver/sonarr:latest',
    State: 'running',
    Labels: {},
    Ports: ports,
  };
}

const SERVICE_PORT = 18989;
const OTHER_SERVICE_PORT = 28989;

test('multiple host ports choose the same usable route regardless of order', async (t) => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-port-ambiguity-'));
  const containers = [
    sonarr('sonarr-alpha', 1, [...dualStack(8989, SERVICE_PORT), ...dualStack(8989, OTHER_SERVICE_PORT)]),
    sonarr('sonarr-omega', 2, [...dualStack(8989, OTHER_SERVICE_PORT), ...dualStack(8989, SERVICE_PORT)]),
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

  const service = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Sonarr</title></html>');
  });
  await listen(service, SERVICE_PORT);

  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '4d'.repeat(32),
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
    daemon.closeAllConnections();
    service.closeAllConnections();
    await new Promise((resolve) => daemon.close(resolve));
    await new Promise((resolve) => service.close(resolve));
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

  const rows = ['sonarr-alpha', 'sonarr-omega'].map(rowFor);
  for (const row of rows) {
    const index = (row.match(/name="service_(\d+)"/) || [])[1];
    assert.ok(index !== undefined, 'the row is a real form row');
    assert.match(row, new RegExp(`port ${SERVICE_PORT}`));
    assert.match(row, new RegExp(`<span class="mono">http://127\\.0\\.0\\.1:${SERVICE_PORT}</span>`), 'and hands the phone that address');
    assert.match(row, new RegExp(`id="base_${index}"[^>]*value="http://127\\.0\\.0\\.1:${SERVICE_PORT}"`));
    assert.doesNotMatch(row, new RegExp(`include_${index}"[^>]*disabled`));
    assert.match(row, /data-avail="reachable"/);
    assert.match(row, new RegExp(`name="include_${index}" checked`), 'a reachable row is preselected for the transfer');
    assert.doesNotMatch(row, /Companion could not reach it/);
    assert.match(row, new RegExp(`Docker publishes this on ports ${SERVICE_PORT} and ${OTHER_SERVICE_PORT}`));
    assert.match(row, /change the address below if your phone should use one of the others/);
  }
  const facts = (row) => ({
    port: (row.match(/port (\d+)</) || [])[1],
    route: (row.match(/<span class="mono">([^<]*)<\/span>/) || [])[1],
    choice: (row.match(/data-port-choice>([^<]*)</) || [])[1],
    availability: (row.match(/data-avail="([^"]*)"/) || [])[1],
  });
  assert.deepEqual(facts(rows[0]), facts(rows[1]));

  const reached = await fetch(`http://127.0.0.1:${SERVICE_PORT}/`);
  assert.equal(reached.status, 200);
});

test('mapping helper preserves unambiguous routes only', async () => {
  const { publishedMappingOf } = await import('../src/detect.js');
  const both = { privatePort: 8989, publicPort: 18989, alternatePublicPorts: [28989] };
  assert.deepEqual(publishedMappingOf([...dualStack(8989, 18989), ...dualStack(8989, 28989)], 'sonarr'), both);
  assert.deepEqual(publishedMappingOf([...dualStack(8989, 28989), ...dualStack(8989, 18989)], 'sonarr'), both);
  assert.deepEqual(publishedMappingOf([...dualStack(80, 8979), ...dualStack(80, 7979)], 'audiobookshelf'), {
    privatePort: 80, publicPort: 7979, alternatePublicPorts: [8979],
  });
  assert.equal(publishedMappingOf([...dualStack(80, 7979), ...dualStack(443, 7443)], 'audiobookshelf'), undefined);
  assert.deepEqual(publishedMappingOf(dualStack(8989, 18989), 'sonarr'), { privatePort: 8989, publicPort: 18989 });
  assert.deepEqual(publishedMappingOf(dualStack(8989, 8989), 'sonarr'), { privatePort: 8989, publicPort: 8989 });
});
