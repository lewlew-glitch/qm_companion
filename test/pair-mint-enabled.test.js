import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';


async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(origin, child) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    try { if ((await fetch(`${origin}/healthz`)).status === 200) return; } catch {  }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('server did not start');
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
    ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(values.join(', '));
  return match ? `${name}=${match[1]}` : '';
}

const SENTINEL = 'do-not-echo-admin-password-9f3a';

test('enabled mint kinds use the detected origin', async (t) => {
  const JELLYFIN_PORT = 8096;
  const created = [];
  let sawPassword = false;
  const jelly = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (body.includes(SENTINEL) && req.url.includes('AuthenticateByName')) sawPassword = true;
      if (req.method === 'POST' && req.url.startsWith('/Users/AuthenticateByName')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ AccessToken: 'admin-access-token' }));
      }
      if (req.method === 'POST' && req.url.startsWith('/Auth/Keys?App=Quartermaster')) {
        created.push(Date.now());
        return res.writeHead(204).end();
      }
      if (req.method === 'GET' && req.url === '/Auth/Keys') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ Items: [
          { AppName: 'Other', AccessToken: 'nope', DateCreated: '2020-01-01T00:00:00Z' },
          { AppName: 'Quartermaster', AccessToken: 'MINTED-JELLYFIN-KEY', DateCreated: '2026-08-26T10:00:00Z' },
        ] }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ServerName: 'jellyfin' }));
    });
  });
  await new Promise((r, j) => { jelly.once('error', j); jelly.listen(JELLYFIN_PORT, '127.0.0.1', r); });

  const docker = createHttpServer((req, res) => {
    if (req.url === '/containers/json?all=1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{
        Id: 'a'.repeat(64), Names: ['/jellyfin'], Image: 'jellyfin/jellyfin:latest', State: 'running',
        Labels: {}, Ports: [{ PrivatePort: 8096, PublicPort: 8096, Type: 'tcp' }],
      }]));
    }
    res.writeHead(404).end();
  });
  const dockerPort = await new Promise((r, j) => { docker.once('error', j); docker.listen(0, '127.0.0.1', () => r(docker.address().port)); });

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mint-enabled-'));
  const stackDir = join(dataDir, 'stack');
  mkdirSync(stackDir, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env, SECRET_KEY: '67'.repeat(32), DATA_DIR: dataDir, QM_HOST: '127.0.0.1',
      QM_STACK: stackDir, BIND_ADDRESS: '127.0.0.1', PORT: String(port), DOCKER_HOST: `tcp://127.0.0.1:${dockerPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  t.after(async () => {
    if (child.exitCode == null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
    await new Promise((r) => jelly.close(r));
    await new Promise((r) => docker.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(origin, child);
  const setupToken = await waitForSetupToken(() => stdout, child);
  const claim = await fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken, password: 'owner-password' }).toString(),
    redirect: 'manual',
  });
  assert.equal(claim.status, 303, stderr);
  const cookie = responseCookie(claim, 'qm_sess');

  const pair = await fetch(`${origin}/pair`, { headers: { cookie, accept: 'text/html' } });
  const html = await pair.text();
  const csrf = (html.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  const instanceId = (html.match(/data-instance="([^"]+)" data-kind="jellyfin"/) || [])[1];
  assert.ok(csrf && instanceId, 'the jellyfin row is present with csrf');
  const row = html.slice(html.indexOf(`data-instance="${instanceId}"`), html.indexOf('</section>', html.indexOf(`data-instance="${instanceId}"`)));
  assert.match(row, /data-mint-btn>Create key for me/, 'the create-for-me button is offered');
  assert.match(row, /data-manual-key/);

  const mint = async (baseUrl) => {
    const res = await fetch(`${origin}/pair/keys/mint`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ instanceId, baseUrl, credentials: { username: 'admin', password: SENTINEL } }),
    });
    return res.text();
  };

  const hostile = await mint('http://10.99.99.99:8096');
  assert.doesNotMatch(hostile, new RegExp(SENTINEL));
  assert.match(hostile, /"ok":true/);
  assert.ok(sawPassword);

  const services = await (await fetch(`${origin}/api/services`, { headers: { cookie } })).json();
  const jf = services.services.find((s) => s.instanceId === instanceId);
  assert.equal(jf.hasKey, true, 'the minted key is now held by Companion');
  assert.equal(jf.credentialState, 'included', 'and the row reads as included');
  assert.ok(created.length >= 1, 'a Quartermaster key was created on the service');
});

test('paused mint kinds reject before network access', async (t) => {
  const docker = createHttpServer((req, res) => {
    if (req.url === '/containers/json?all=1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{
        Id: 'b'.repeat(64), Names: ['/technitium'], Image: 'technitium/dns-server:latest', State: 'running',
        Labels: {}, Ports: [{ PrivatePort: 5380, PublicPort: 5380, Type: 'tcp' }],
      }]));
    }
    res.writeHead(404).end();
  });
  const dockerPort = await new Promise((r, j) => { docker.once('error', j); docker.listen(0, '127.0.0.1', () => r(docker.address().port)); });
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mint-paused-'));
  const stackDir = join(dataDir, 'stack');
  mkdirSync(stackDir, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env, SECRET_KEY: '68'.repeat(32), DATA_DIR: dataDir, QM_HOST: '127.0.0.1',
      QM_STACK: stackDir, BIND_ADDRESS: '127.0.0.1', PORT: String(port), DOCKER_HOST: `tcp://127.0.0.1:${dockerPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  t.after(async () => {
    if (child.exitCode == null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
    await new Promise((r) => docker.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(origin, child);
  const setupToken = await waitForSetupToken(() => stdout, child);
  const claim = await fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken, password: 'owner-password' }).toString(),
    redirect: 'manual',
  });
  const cookie = responseCookie(claim, 'qm_sess');
  const pair = await fetch(`${origin}/pair`, { headers: { cookie, accept: 'text/html' } });
  const html = await pair.text();
  const csrf = (html.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  const instanceId = (html.match(/data-instance="([^"]+)" data-kind="technitium"/) || [])[1];
  assert.ok(instanceId, 'technitium row present');
  const row = html.slice(html.indexOf(`data-instance="${instanceId}"`), html.indexOf('</section>', html.indexOf(`data-instance="${instanceId}"`)));
  assert.doesNotMatch(row, /data-mint-btn/, 'a paused kind offers no create button');
  const res = await fetch(`${origin}/pair/keys/mint`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ instanceId, baseUrl: 'http://127.0.0.1:5380', credentials: { username: 'admin', password: SENTINEL } }),
  });
  const text = await res.text();
  assert.match(text, /"paused":true/, 'the route refuses a paused kind');
  assert.doesNotMatch(text, new RegExp(SENTINEL));
});
