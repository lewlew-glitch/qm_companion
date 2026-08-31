import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

async function requirePortFree(port) {
  const answered = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
  assert.equal(answered, false, `this test needs 127.0.0.1:${port} free, and something is answering there`);
}

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

function unescapeHtml(value) {
  return String(value)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function formFieldsFrom(html) {
  const start = html.indexOf('<form method="post" action="/pair"');
  assert.notEqual(start, -1, 'the set-up form is on the page');
  const form = html.slice(start, html.indexOf('</form>', start));
  const body = new URLSearchParams();
  const inputs = form.match(/<input\b[^>]*>/g) || [];
  for (const input of inputs) {
    const name = (input.match(/\bname="([^"]*)"/) || [])[1];
    if (!name || /\bdisabled\b/.test(input)) continue;
    const type = (input.match(/\btype="([^"]*)"/) || [])[1] || 'text';
    if (type === 'checkbox') {
      if (/\bchecked\b/.test(input)) body.append(name, 'on');
      continue;
    }
    body.append(name, unescapeHtml((input.match(/\bvalue="([^"]*)"/) || [])[1] || ''));
  }
  return body;
}

test('preserves Include anyway after a server-side form error', async (t) => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-pair-server-error-'));
  await requirePortFree(6767);
  const container = {
    Id: 'd'.repeat(64),
    Names: ['/bazarr'],
    Image: 'lscr.io/linuxserver/bazarr:latest',
    State: 'running',
    Ports: [{ Type: 'tcp', PrivatePort: 6767, PublicPort: 6767 }],
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
  await new Promise((resolve, reject) => { daemon.once('error', reject); daemon.listen(0, '127.0.0.1', resolve); });

  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '44'.repeat(32),
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

  const first = await fetch(`${origin}/pair`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
  assert.equal(first.status, 200, stderr);
  const firstHtml = await first.text();
  const csrf = (firstHtml.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf);

  const bazarrRow = (html) => {
    const at = html.indexOf('data-kind="bazarr"');
    assert.notEqual(at, -1, 'the Bazarr container row is on the page');
    return html.slice(html.lastIndexOf('<section class="pair-service', at), html.indexOf('</section>', at));
  };
  const firstRow = bazarrRow(firstHtml);
  const index = (firstRow.match(/name="service_(\d+)"/) || [])[1];
  const instanceId = (firstRow.match(/name="service_\d+" value="([^"]+)"/) || [])[1];
  assert.ok(instanceId && index !== undefined);
  assert.match(firstRow, /data-avail="unreachable" data-docker-state="running"/);
  assert.match(firstRow, /data-include-anyway/, 'the override is offered');
  assert.match(firstRow, new RegExp(`name="force_${index}" value=""`));

  const headers = { cookie: sessionCookie, ...form, 'sec-fetch-site': 'same-origin' };
  const mistyped = new URLSearchParams({
    csrf,
    [`service_${index}`]: instanceId,
    [`include_${index}`]: 'on',
    [`force_${index}`]: 'on',
    [`base_${index}`]: '127.0.0.1:6767',
    [`remote_${index}`]: '',
  });
  const rejected = await fetch(`${origin}/pair`, { method: 'POST', headers, body: mistyped.toString(), redirect: 'manual' });
  assert.equal(rejected.status, 400, stderr);
  const rejectedHtml = await rejected.text();
  assert.match(rejectedHtml, /must be a complete http:\/\/ or https:\/\/ address/, 'the error names the address, not the override');

  const rejectedRow = bazarrRow(rejectedHtml);
  assert.match(rejectedRow, new RegExp(`name="force_${index}" value="on"`), 'the override survives the re-render');
  assert.match(rejectedRow, /data-forced="1"/);
  assert.match(rejectedRow, new RegExp(`<input type="checkbox" name="include_${index}" checked\\s*>`), 'the row comes back ticked and enabled');
  assert.doesNotMatch(rejectedRow, new RegExp(`name="include_${index}"[^>]*disabled`));
  assert.match(rejectedRow, new RegExp(`id="base_${index}"[^>]*value="127.0.0.1:6767"`));
  const readyLine = (rejectedHtml.match(/<span id="pair-ready-line">([^<]*)<\/span>/) || [])[1];
  assert.match(rejectedHtml, /manually included/, 'the summary counts it as included, not left out');
  assert.doesNotMatch(rejectedHtml, /running but unreachable from Companion and left out/);
  assert.ok(readyLine !== undefined, 'the readiness line is rendered');
  assert.doesNotMatch(readyLine, /unreachable, not included/);

  const corrected = formFieldsFrom(rejectedHtml);
  assert.equal(corrected.get(`force_${index}`), 'on', 'the browser would send the override back');
  assert.equal(corrected.get(`include_${index}`), 'on');
  corrected.set(`base_${index}`, 'http://127.0.0.1:6767');
  const accepted = await fetch(`${origin}/pair`, { method: 'POST', headers, body: corrected.toString(), redirect: 'manual' });
  const acceptedHtml = await accepted.text();
  assert.doesNotMatch(acceptedHtml, /is running but Companion cannot reach it/, 'the owner is not asked to decide twice');
  assert.doesNotMatch(acceptedHtml, /Pick at least one service to hand over/);
  assert.equal(accepted.status, 200, stderr);
  assert.match(acceptedHtml, /One-time transfer ready/);
});

test('preserves Include anyway across probe-state changes', async (t) => {
  await requirePortFree(6767);
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-pair-forced-carry-'));
  const container = {
    Id: 'e'.repeat(64),
    Names: ['/bazarr'],
    Image: 'lscr.io/linuxserver/bazarr:latest',
    State: 'running',
    Ports: [{ Type: 'tcp', PrivatePort: 6767, PublicPort: 6767 }],
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
  await new Promise((resolve, reject) => { daemon.once('error', reject); daemon.listen(0, '127.0.0.1', resolve); });

  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '46'.repeat(32),
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

  const first = await fetch(`${origin}/pair`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
  assert.equal(first.status, 200, stderr);
  const firstHtml = await first.text();
  const csrf = (firstHtml.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf);

  const bazarrRow = (html) => {
    const at = html.indexOf('data-kind="bazarr"');
    assert.notEqual(at, -1, 'the Bazarr container row is on the page');
    return html.slice(html.lastIndexOf('<section class="pair-service', at), html.indexOf('</section>', at));
  };
  const firstRow = bazarrRow(firstHtml);
  const index = (firstRow.match(/name="service_(\d+)"/) || [])[1];
  const instanceId = (firstRow.match(/name="service_\d+" value="([^"]+)"/) || [])[1];
  assert.ok(instanceId && index !== undefined);
  assert.match(firstRow, /data-avail="unreachable"/);
  assert.match(firstRow, /data-include-anyway/, 'the override is offered');

  container.Ports = [{ Type: 'tcp', PrivatePort: 6767, PublicPort: 16767 }];
  const republished = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Bazarr</title></html>');
  });
  await new Promise((resolve, reject) => { republished.once('error', reject); republished.listen(16767, '127.0.0.1', resolve); });
  t.after(async () => {
    republished.closeAllConnections();
    await new Promise((resolve) => republished.close(resolve));
  });
  const headers = { cookie: sessionCookie, ...form, 'sec-fetch-site': 'same-origin' };
  const mistyped = new URLSearchParams({
    csrf,
    [`service_${index}`]: instanceId,
    [`include_${index}`]: 'on',
    [`force_${index}`]: 'on',
    [`base_${index}`]: '127.0.0.1:16767',
    [`remote_${index}`]: '',
  });
  const rejected = await fetch(`${origin}/pair`, { method: 'POST', headers, body: mistyped.toString(), redirect: 'manual' });
  assert.equal(rejected.status, 400, stderr);
  const rejectedHtml = await rejected.text();
  const rejectedRow = bazarrRow(rejectedHtml);
  assert.match(rejectedRow, /data-avail="reachable"/);
  assert.match(rejectedRow, new RegExp(`name="force_${index}" value="on"`));
  assert.match(rejectedRow, /data-forced="1"/, 'so the live poll knows it was already taken');

  container.Ports = [{ Type: 'tcp', PrivatePort: 6767, PublicPort: 6767 }];
  republished.closeAllConnections();
  await new Promise((resolve) => republished.close(resolve));
  const corrected = formFieldsFrom(rejectedHtml);
  assert.equal(corrected.get(`force_${index}`), 'on', 'the browser would send the override back');
  assert.equal(corrected.get(`include_${index}`), 'on');
  corrected.set(`base_${index}`, 'http://127.0.0.1:6767');
  const accepted = await fetch(`${origin}/pair`, { method: 'POST', headers, body: corrected.toString(), redirect: 'manual' });
  const acceptedHtml = await accepted.text();
  assert.doesNotMatch(acceptedHtml, /is running but Companion cannot reach it/, 'the owner is not asked to decide twice');
  assert.doesNotMatch(acceptedHtml, /Pick at least one service to hand over/);
  assert.equal(accepted.status, 200, stderr);
  assert.match(acceptedHtml, /One-time transfer ready/);
});
