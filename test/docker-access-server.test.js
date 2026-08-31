import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ID = 'a'.repeat(12);
const OWNER_PASSWORD = 'docker-mode-owner-password';

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

async function waitFor(origin, child) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Companion exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${origin}/healthz`)).status === 200) return;
    } catch {  }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Companion did not start');
}

async function setupToken(output, child) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const found = /first-run setup token: ([A-Za-z0-9_-]{43})/.exec(output());
    if (found) return found[1];
    if (child.exitCode != null) throw new Error(`Companion exited with ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('No setup token appeared');
}

function sessionCookie(response) {
  return String(response.headers.get('set-cookie') || '').split(';', 1)[0];
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function expectJson(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}

test('navbar access mode is enforced independently of shell access', async (t) => {
  const dockerRequests = [];
  const fakeDocker = createHttpServer((req, res) => {
    dockerRequests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/containers/json?all=1') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify([{
        Id: ID, Names: ['/ordinary'], Image: 'example/app:latest', ImageID: 'sha256:' + 'b'.repeat(64),
        State: 'running', Status: 'Up 1 minute', Ports: [], Labels: {}, Mounts: [],
        NetworkSettings: { Networks: { bridge: { IPAddress: '172.20.0.2' } } },
      }]));
    }
    if (req.method === 'GET' && req.url === `/containers/${ID}/json`) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        Id: ID, Name: '/ordinary', Config: { Image: 'example/app:latest', Labels: {}, Env: [] },
        HostConfig: {}, Mounts: [], NetworkSettings: { Networks: { bridge: { IPAddress: '172.20.0.2' } } },
      }));
    }
    if (req.method === 'POST' && req.url === `/containers/${ID}/start`) {
      res.statusCode = 204;
      return res.end();
    }
    if (req.method === 'POST' && req.url === `/containers/${ID}/exec`) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ Id: 'exec-one' }));
    }
    if (req.method === 'POST' && req.url === '/exec/exec-one/start') return res.end();
    if (req.method === 'GET' && req.url === '/exec/exec-one/json') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ExitCode: 0 }));
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    return res.end('{}');
  });
  const dockerPort = await listen(fakeDocker);
  t.after(() => fakeDocker.close());

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-access-server-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${port}`;
  const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const cron = await import('./src/cron.js');
    cron.addJob('Dormant manage', { type: 'container', op: 'restart', ref: '${ID}' }, { type: 'daily', hour: 2, minute: 0 });
    cron.addJob('Dormant shell', { type: 'exec', ref: '${ID}', cmd: 'id' }, { type: 'daily', hour: 2, minute: 5 });
  `], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '8b'.repeat(32), DATA_DIR: dataDir, QM_HOST: '127.0.0.1',
      DOCKER_ACCESS_MAX: 'shell',
    },
    encoding: 'utf8',
  });
  assert.equal(seeded.status, 0, seeded.stderr);

  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '8b'.repeat(32), DATA_DIR: dataDir, QM_HOST: '127.0.0.1',
      BIND_ADDRESS: '127.0.0.1', PORT: String(port), DOCKER_HOST: `tcp://127.0.0.1:${dockerPort}`,
      DOCKER_ACCESS_MAX: 'shell',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => {
    child.kill('SIGTERM');
  });

  await waitFor(origin, child);
  const token = await setupToken(() => stdout, child);
  const claimed = await fetch(`${origin}/setup`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken: token, password: OWNER_PASSWORD }).toString(),
  });
  assert.equal(claimed.status, 303, stderr);
  const cookie = sessionCookie(claimed);
  const page = await fetch(`${origin}/containers`, { headers: { cookie, accept: 'text/html' } });
  const html = await page.text();
  const csrf = html.match(/name="csrf" content="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  assert.match(html, /id="docker-mode-open"[^>]*aria-label="Docker access: Read only"/);
  assert.match(html, /Installed maximum: Management \+ shell/);
  assert.doesNotMatch(html, /value="manage"[^>]*disabled/);
  assert.doesNotMatch(html, /value="shell"[^>]*disabled/);

  const headers = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
  const post = (path, body) => fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const postForm = (path, body) => fetch(`${origin}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ csrf, ...body }).toString(),
  });

  const bootCronPage = await fetch(`${origin}/cron`, { headers: { cookie, accept: 'text/html' } }).then((r) => r.text());
  assert.match(bootCronPage, /data-jname="Dormant manage"[^>]*data-enabled="0"/);
  assert.match(bootCronPage, /data-jname="Dormant shell"[^>]*data-enabled="0"/);

  const forgedManageInRead = await postForm('/cron/new', {
    name: 'Deferred restart', atype: 'container', op: 'restart', ref: ID,
    stype: 'daily', hour: '3', minute: '0',
  });
  await expectJson(forgedManageInRead, 403);
  await expectJson(await postForm('/cron/toggle', { id: 'prune-images', enabled: 'true' }), 403);
  const enableUpdateCheck = await postForm('/cron/toggle', { id: 'updates-check', enabled: 'true' });
  assert.equal(enableUpdateCheck.status, 303, await enableUpdateCheck.text());

  assert.equal((await post(`/containers/${ID}/start`, {})).status, 403);
  assert.equal((await post('/api/exec', { id: ID, cmd: 'id' })).status, 403);
  assert.equal(dockerRequests.some((row) => row === `POST /containers/${ID}/start`), false);

  const wrong = await post('/settings/docker-mode', { mode: 'manage', password: 'wrong-owner-password' });
  await expectJson(wrong, 403);
  const raised = await post('/settings/docker-mode', { mode: 'manage', password: OWNER_PASSWORD });
  const raisedBody = await expectJson(raised, 200);
  assert.equal(raisedBody.mode, 'manage');

  const forgedExecInManage = await postForm('/cron/new', {
    name: 'Deferred shell', atype: 'exec', ref: ID, cmd: 'id',
    stype: 'daily', hour: '3', minute: '5',
  });
  await expectJson(forgedExecInManage, 403);
  const manageCron = await postForm('/cron/new', {
    name: 'Restart ordinary', atype: 'container', op: 'restart', ref: ID,
    stype: 'daily', hour: '3', minute: '10',
  });
  assert.equal(manageCron.status, 303, await manageCron.text());
  const manageCronPage = await fetch(`${origin}/cron`, { headers: { cookie, accept: 'text/html' } }).then((r) => r.text());
  const manageJobId = /data-jid="([^"]+)"[^>]*data-jname="Restart ordinary"/.exec(manageCronPage)?.[1];
  assert.ok(manageJobId);
  await expectJson(await postForm('/cron/edit', {
    id: manageJobId, name: 'Restart ordinary', atype: 'exec', ref: ID, cmd: 'id',
    stype: 'daily', hour: '3', minute: '15',
  }), 403);

  assert.equal((await post(`/containers/${ID}/start`, {})).status, 200);
  assert.equal(dockerRequests.some((row) => row === `POST /containers/${ID}/start`), true);
  const execBefore = dockerRequests.filter((row) => row === `POST /containers/${ID}/exec`).length;
  assert.equal((await post('/api/exec', { id: ID, cmd: 'id' })).status, 403, 'Management does not imply shell');
  assert.equal((await post('/pair/keys/read', { instanceId: 'missing' })).status, 403, 'container key reads are exec too');
  assert.equal(dockerRequests.filter((row) => row === `POST /containers/${ID}/exec`).length, execBefore);

  const managePage = await fetch(`${origin}/containers`, { headers: { cookie, accept: 'text/html' } }).then((r) => r.text());
  assert.match(managePage, /data-action="stop"/);
  assert.doesNotMatch(managePage, /\/console\?id=[^" ]+&shell=1/);
  const manageConsole = await fetch(`${origin}/console`, { headers: { cookie, accept: 'text/html' } }).then((r) => r.text());
  assert.doesNotMatch(manageConsole, /id="shelltoggle"|id="shellpane"/);

  const shell = await post('/settings/docker-mode', { mode: 'shell', password: OWNER_PASSWORD });
  const shellBody = await expectJson(shell, 200);
  assert.equal(shellBody.mode, 'shell');
  assert.equal((await post('/api/exec', { id: ID, cmd: 'id' })).status, 200);
  assert.equal(dockerRequests.some((row) => row === `POST /containers/${ID}/exec`), true);

  const cron = await postForm('/cron/new', {
    name: 'Root check', atype: 'exec', ref: ID, cmd: 'id',
    stype: 'daily', hour: '4', minute: '0',
  });
  assert.equal(cron.status, 303, stderr);

  const shellCronPage = await fetch(`${origin}/cron`, { headers: { cookie, accept: 'text/html' } }).then((r) => r.text());
  const shellJobId = /data-jid="([^"]+)"[^>]*data-jname="Root check"/.exec(shellCronPage)?.[1];
  assert.ok(shellJobId);

  const lowered = await post('/settings/docker-mode', { mode: 'read' });
  const loweredBody = await expectJson(lowered, 200);
  assert.equal(loweredBody.suspended, 2);
  assert.equal((await post(`/containers/${ID}/start`, {})).status, 403);

  const cronPage = await fetch(`${origin}/cron`, { headers: { cookie, accept: 'text/html' } }).then((r) => r.text());
  assert.match(cronPage, /data-jname="Root check"[^>]*data-enabled="0"/);
  assert.match(cronPage, /data-jname="Restart ordinary"[^>]*data-enabled="0"/);
  assert.match(cronPage, /data-jid="updates-check"[^>]*data-enabled="1"/);

  await expectJson(await postForm('/cron/toggle', { id: shellJobId, enabled: 'true' }), 403);
  await expectJson(await postForm('/cron/run', { id: shellJobId }), 403);
  await expectJson(await postForm('/cron/run', { id: manageJobId }), 403);
  const scheduleOnly = await postForm('/cron/edit', {
    id: shellJobId, name: 'Root check renamed', atype: 'exec', ref: ID, cmd: 'id',
    stype: 'daily', hour: '5', minute: '0',
  });
  assert.equal(scheduleOnly.status, 303, await scheduleOnly.text());
  await expectJson(await postForm('/cron/edit', {
    id: shellJobId, name: 'Root check renamed', atype: 'exec', ref: ID, cmd: 'whoami',
    stype: 'daily', hour: '5', minute: '0',
  }), 403);

  await expectJson(await post('/settings/docker-mode', { mode: 'shell', password: OWNER_PASSWORD }), 200);
  const enabledAgain = await postForm('/cron/toggle', { id: shellJobId, enabled: 'true' });
  assert.equal(enabledAgain.status, 303, await enabledAgain.text());

  const mainState = join(dataDir, 'qm-companion.json');
  rmSync(mainState);
  mkdirSync(mainState);
  const failedLower = await post('/settings/docker-mode', { mode: 'read' });
  const failedLowerBody = await expectJson(failedLower, 500);
  assert.match(failedLowerBody.error, /was not changed/);
  const afterFailure = await fetch(`${origin}/containers`, { headers: { cookie, accept: 'text/html' } }).then((r) => r.text());
  assert.match(afterFailure, /id="docker-mode-open"[^>]*aria-label="Docker access: Management \+ shell"/);
  const cronAfterFailure = await fetch(`${origin}/cron`, { headers: { cookie, accept: 'text/html' } }).then((r) => r.text());
  assert.match(cronAfterFailure, new RegExp(`data-jid="${shellJobId}"[^>]*data-enabled="1"`));
});
