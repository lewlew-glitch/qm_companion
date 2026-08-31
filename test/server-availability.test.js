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

function listen(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}

test('rejects stale forced submissions and rechecks reissues', async (t) => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-server-availability-'));
  const container = {
    Id: 'c'.repeat(64),
    Names: ['/sonarr'],
    Image: 'lscr.io/linuxserver/sonarr:latest',
    State: 'running',
    Ports: [{ Type: 'tcp', PrivatePort: 8989, PublicPort: 8989 }],
    Labels: {},
  };
  const daemon = createHttpServer((req, res) => {
    if (req.url === '/containers/json?all=1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([container]));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(daemon, 0);
  const sonarr = createHttpServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>Sonarr</title></html>'); });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '33'.repeat(32),
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
    await new Promise((resolve) => daemon.close(resolve));
    if (sonarr.listening) await new Promise((resolve) => sonarr.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(origin, child);
  const setupToken = await waitForSetupToken(() => stdout, child);
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const claim = await fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { ...form, 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken, password: 'correct-owner-password' }).toString(),
    redirect: 'manual',
  });
  assert.equal(claim.status, 303, stderr);
  const sessionCookie = responseCookie(claim, 'qm_sess');

  const pairConfig = await fetch(`${origin}/pair`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
  assert.equal(pairConfig.status, 200, stderr);
  const configHtml = await pairConfig.text();
  const csrf = (configHtml.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  const sonarrRow = (html) => {
    const at = html.indexOf('data-kind="sonarr"');
    assert.notEqual(at, -1, 'the Sonarr container row is on the page');
    return html.slice(html.lastIndexOf('<section class="pair-service', at), html.indexOf('</section>', at));
  };
  const configRow = sonarrRow(configHtml);
  const index = (configRow.match(/name="service_(\d+)"/) || [])[1];
  const instanceId = (configRow.match(/name="service_\d+" value="([^"]+)"/) || [])[1];
  assert.ok(csrf && instanceId && index !== undefined);
  assert.match(configRow, /data-avail="unreachable" data-docker-state="running"/);
  assert.match(configRow, /data-include-anyway/);
  assert.match(configHtml, new RegExp(`data-pair-section="unreachable">[\\s\\S]*data-instance="${instanceId}"`));

  const services = async () => (await (await fetch(`${origin}/api/services`, { headers: { cookie: sessionCookie, accept: 'application/json' } })).json()).services.filter((s) => s.instanceId === instanceId);
  let [row] = await services();
  assert.equal(row.availability, 'unreachable');
  assert.equal(row.dockerState, 'running');
  assert.equal(row.up, false);

  const pairHeaders = { cookie: sessionCookie, ...form, 'sec-fetch-site': 'same-origin' };
  const body = (forced) => new URLSearchParams({
    csrf, [`service_${index}`]: instanceId, [`include_${index}`]: 'on', [`base_${index}`]: 'http://127.0.0.1:8989', [`remote_${index}`]: '', ...(forced ? { [`force_${index}`]: 'on' } : {}),
  }).toString();

  const unforced = await fetch(`${origin}/pair`, { method: 'POST', headers: pairHeaders, body: body(false), redirect: 'manual' });
  assert.equal(unforced.status, 400, stderr);
  assert.match(await unforced.text(), /is running but Companion cannot reach it\. Check its address, or choose Include anyway/);

  const forced = await fetch(`${origin}/pair`, { method: 'POST', headers: pairHeaders, body: body(true), redirect: 'manual' });
  assert.equal(forced.status, 200, stderr);
  assert.match(await forced.text(), /One-time transfer ready/);
  const reissued = await fetch(`${origin}/pair/reissue`, { method: 'POST', headers: pairHeaders, body: new URLSearchParams({ csrf }).toString(), redirect: 'manual' });
  assert.equal(reissued.status, 200, stderr);
  assert.match(await reissued.text(), /One-time transfer ready/);

  container.State = 'exited';
  container.Ports = [];
  [row] = await services();
  assert.equal(row.availability, 'not-running');
  assert.equal(row.dockerState, 'exited');
  const staleForced = await fetch(`${origin}/pair`, { method: 'POST', headers: pairHeaders, body: body(true), redirect: 'manual' });
  assert.equal(staleForced.status, 400);
  const staleHtml = await staleForced.text();
  assert.match(staleHtml, /is stopped in Docker\. Start it, then create the transfer again\./);
  const staleRow = sonarrRow(staleHtml);
  assert.match(staleRow, /data-avail="not-running" data-docker-state="exited"/);
  assert.doesNotMatch(staleRow, /data-include-anyway|Include anyway/);
  assert.match(staleRow, /<input type="checkbox" name="include_\d+"\s+disabled>/);
  const staleReissue = await fetch(`${origin}/pair/reissue`, { method: 'POST', headers: pairHeaders, body: new URLSearchParams({ csrf }).toString(), redirect: 'manual' });
  assert.equal(staleReissue.status, 400);
  assert.match(await staleReissue.text(), /is stopped in Docker/);

  container.State = 'paused';
  const paused = await fetch(`${origin}/pair`, { method: 'POST', headers: pairHeaders, body: body(true), redirect: 'manual' });
  assert.equal(paused.status, 400);
  assert.match(await paused.text(), /is paused in Docker/);

  container.State = 'running';
  container.Ports = [{ Type: 'tcp', PrivatePort: 8989, PublicPort: 8989 }];
  await listen(sonarr, 8989);
  [row] = await services();
  assert.equal(row.availability, 'reachable');
  assert.equal(row.up, true);
  const plain = await fetch(`${origin}/pair`, { method: 'POST', headers: pairHeaders, body: body(false), redirect: 'manual' });
  assert.equal(plain.status, 200, stderr);
  assert.match(await plain.text(), /One-time transfer ready/);
});
