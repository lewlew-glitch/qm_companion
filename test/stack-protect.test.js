
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function row(id, name, project, service, extraLabels = {}, state = 'running') {
  return {
    Id: id,
    Names: [`/${name}`],
    Image: `example/${name}:latest`,
    State: state,
    Status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 3 days ago',
    Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service, ...extraLabels },
    Ports: [],
    NetworkSettings: { Networks: {} },
    Mounts: [],
    Created: 1_700_000_000,
  };
}

const ID = {
  radarr: 'aa'.repeat(12),
  sabnzbd: 'ab'.repeat(12),
  panelCompanion: 'ac'.repeat(12),
  panelProxy: 'ad'.repeat(12),
  labelled: 'ae'.repeat(12),
  buddy: 'af'.repeat(12),
  phantom: 'ba'.repeat(12),
  unknown: 'bb'.repeat(12),
  leftover: 'bc'.repeat(12),
  oldProxy: 'bd'.repeat(12),
  mystery: 'be'.repeat(12),
  protectedRadarr: 'bf'.repeat(12),
};

const CONTAINERS = [
  row(ID.radarr, 'radarr', 'media', 'radarr'),
  row(ID.sabnzbd, 'sabnzbd', 'media', 'sabnzbd'),
  row(ID.panelCompanion, 'qm-companion', 'panel', 'companion'),
  row(ID.panelProxy, 'proxling', 'panel', 'socket-proxy'),
  row(ID.labelled, 'harmless', 'labelled', 'web', { 'qm.protected': 'true' }),
  row(ID.buddy, 'buddy', 'labelled', 'helper'),
  row(ID.phantom, 'phantom', 'ghost', 'phantom'),
  row(ID.leftover, 'leftover', 'scrap', 'junk', {}, 'exited'),
  row(ID.oldProxy, 'old-proxy', 'scrap', 'socket-proxy', {}, 'exited'),
  row(ID.mystery, 'mystery', 'scrap', 'mystery', {}, 'exited'),
  row(ID.protectedRadarr, 'protected-radarr', 'vault', 'radarr', { 'qm.protected': 'true' }),
];

test('rejects protected or unverifiable mutation targets', async (t) => {
  const mutations = [];
  const fakeDocker = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method !== 'GET') {
      mutations.push(`${req.method} ${path}`);
      if (/^\/containers\/[a-f0-9]+\/exec$/.test(path)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(204);
      return res.end();
    }
    if (path === '/containers/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(CONTAINERS));
    }
    const inspect = /^\/containers\/([a-f0-9]+)\/json$/.exec(path);
    if (inspect) {
      const id = inspect[1];
      if (id === ID.phantom || id === ID.unknown || id === ID.mystery) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      const c = CONTAINERS.find((x) => x.Id === id);
      if (!c) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ Id: c.Id, Name: c.Names[0], State: { Status: c.State }, RestartCount: 0, Config: { Labels: c.Labels } }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{}');
  });
  const dockerPort = await freePort();
  await new Promise((resolve) => fakeDocker.listen(dockerPort, '127.0.0.1', resolve));

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-stack-protect-'));
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
      DOCKER_HOST: `tcp://127.0.0.1:${dockerPort}`,
      DOCKER_CONTROL: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => {
    child.kill('SIGTERM');
    fakeDocker.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(origin, child);
  const setupToken = await waitForSetupToken(() => stdout, child);
  const setup = await fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken, password: 'stack-protect-owner-pw' }).toString(),
    redirect: 'manual',
  });
  assert.equal(setup.status, 303, stderr);
  const sessionCookie = responseCookie(setup, 'qm_sess');
  assert.match(sessionCookie, /^qm_sess=/);

  const stacksPage = await fetch(`${origin}/stacks`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
  assert.equal(stacksPage.status, 200, stderr);
  const csrf = ((await stacksPage.text()).match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, 'the stacks page must carry the csrf meta');

  const statePath = join(dataDir, 'qm-companion.json');
  const stateBefore = readFileSync(statePath, 'utf8');

  const post = (path, body) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(body || {}),
    redirect: 'manual',
  });
  const pageText = async (path) => {
    const page = await fetch(`${origin}${path}`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
    assert.equal(page.status, 200, stderr);
    return page.text();
  };

  for (const verb of ['start', 'stop', 'restart', 'redeploy', 'remove']) {
    mutations.length = 0;
    const refused = await post(`/stacks/panel/${verb}`);
    assert.equal(refused.status, 403, `${verb} must be refused: ${stderr}`);
    const body = await refused.json();
    assert.match(body.error || '', /refused/, `${verb} refusal carries a plain reason`);
    assert.deepEqual(mutations, [], `${verb} must not reach Docker`);
  }

  mutations.length = 0;
  const labelled = await post('/stacks/labelled/restart');
  assert.equal(labelled.status, 403);
  assert.match((await labelled.json()).error || '', /refused/);
  assert.deepEqual(mutations, [], 'a label-shielded stack must not reach Docker');

  mutations.length = 0;
  const ghost = await post('/stacks/ghost/stop');
  assert.equal(ghost.status, 403);
  assert.match((await ghost.json()).error || '', /could not be inspected/);
  assert.deepEqual(mutations, [], 'an unverifiable stack must not reach Docker');

  mutations.length = 0;
  const ok = await post('/stacks/media/stop');
  assert.equal(ok.status, 200, stderr);
  const lines = (await ok.text()).split('\n').filter((l) => l.trim());
  const verdict = JSON.parse(lines[lines.length - 1]);
  assert.equal(verdict.ok, true, `the media stack stop must succeed: ${JSON.stringify(verdict)}`);
  assert.deepEqual(mutations, [`POST /containers/${ID.radarr}/stop`, `POST /containers/${ID.sabnzbd}/stop`]);

  mutations.length = 0;
  const single = await post(`/containers/${ID.panelProxy}/stop`);
  assert.equal(single.status, 403);
  assert.deepEqual(mutations, []);
  const unverifiable = await post(`/containers/${ID.unknown}/stop`);
  assert.equal(unverifiable.status, 403);
  assert.match((await unverifiable.json()).error || '', /could not be inspected/);
  assert.deepEqual(mutations, []);
  const plain = await post(`/containers/${ID.radarr}/restart`);
  assert.equal(plain.status, 200);
  assert.deepEqual(mutations, [`POST /containers/${ID.radarr}/restart`]);

  mutations.length = 0;
  const upd = await post(`/containers/${ID.panelCompanion}/update`);
  assert.equal(upd.status, 403, 'update on the companion container is refused');
  const rem = await post(`/containers/${ID.panelProxy}/remove`);
  assert.equal(rem.status, 403, 'remove on the socket proxy is refused');
  assert.deepEqual(mutations, []);

  mutations.length = 0;
  const execShielded = await post('/api/exec', { id: ID.panelCompanion, cmd: 'ls' });
  assert.equal(execShielded.status, 403);
  assert.match((await execShielded.json()).error || '', /refused/);
  assert.deepEqual(mutations, [], 'a shielded exec must not reach Docker');
  const execPlain = await post('/api/exec', { id: ID.radarr, cmd: 'ls' });
  assert.equal(execPlain.status, 200, 'an ordinary exec request is answered');
  assert.deepEqual(mutations, [`POST /containers/${ID.radarr}/exec`], 'the ordinary exec was attempted against Docker');

  const servicesResponse = await fetch(`${origin}/api/services`, { headers: { cookie: sessionCookie } });
  assert.equal(servicesResponse.status, 200);
  const protectedService = (await servicesResponse.json()).services.find((service) => service.name === 'protected-radarr');
  assert.ok(protectedService && protectedService.instanceId);
  mutations.length = 0;
  const keyRead = await post('/pair/keys/read', { instanceId: protectedService.instanceId });
  assert.equal(keyRead.status, 403);
  assert.match((await keyRead.json()).error || '', /protected|refused|Companion|socket proxy/i);
  assert.deepEqual(mutations, []);

  mutations.length = 0;
  const pruned = await post('/containers/prune');
  assert.equal(pruned.status, 200, stderr);
  const pruneNote = (await pruned.json()).note || '';
  assert.match(pruneNote, /1 protected kept/, 'the stopped protected container is reported kept');
  assert.match(pruneNote, /1 unverified kept/);
  assert.deepEqual(mutations, [`DELETE /containers/${ID.leftover}`]);

  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);

  const cronHtml = await pageText('/cron');
  assert.ok(cronHtml.includes(`value="${ID.radarr.slice(0, 12)}"`), 'ordinary containers are offered as cron targets');
  assert.ok(!cronHtml.includes(`value="${ID.panelCompanion.slice(0, 12)}"`));
  assert.ok(!cronHtml.includes(`value="${ID.panelProxy.slice(0, 12)}"`));

  const newJob = async (fields) => {
    const created = await post('/cron/new', { csrf, ...fields });
    assert.equal(created.status, 303, 'job creation answers with a redirect');
    assert.equal(created.headers.get('location'), '/cron', 'job creation succeeded');
    const ids = [...(await pageText('/cron')).matchAll(/custom-[a-f0-9]{8}/g)].map((m) => m[0]);
    return [...new Set(ids)].pop();
  };
  const jobResult = (html, id) => {
    const m = new RegExp(`data-jid="${id}"[^>]*data-lastok="([^"]*)" data-lastnote="([^"]*)"`).exec(html);
    assert.ok(m, `the cron page renders the ${id} row with a last result`);
    return { ok: m[1], note: m[2] };
  };

  const lifecycleJob = await newJob({ name: 'poke companion', atype: 'container', op: 'restart', ref: ID.panelCompanion, stype: 'daily', hour: '3', minute: '0' });
  assert.ok(lifecycleJob, 'the scheduled lifecycle job exists');
  mutations.length = 0;
  const ranLifecycle = await post('/cron/run', { csrf, id: lifecycleJob });
  assert.equal(ranLifecycle.status, 303);
  assert.deepEqual(mutations, []);
  const lifecycleResult = jobResult(await pageText('/cron'), lifecycleJob);
  assert.equal(lifecycleResult.ok, '0', 'the lifecycle job records its run as failed');
  assert.match(lifecycleResult.note, /runs Companion or its socket proxy/);

  const execJob = await newJob({ name: 'poke proxy', atype: 'exec', ref: ID.panelProxy, cmd: 'ls', stype: 'daily', hour: '3', minute: '0' });
  assert.ok(execJob && execJob !== lifecycleJob, 'the scheduled exec job exists');
  mutations.length = 0;
  const ranExec = await post('/cron/run', { csrf, id: execJob });
  assert.equal(ranExec.status, 303);
  assert.deepEqual(mutations, []);
  const execResult = jobResult(await pageText('/cron'), execJob);
  assert.equal(execResult.ok, '0', 'the exec job records its run as failed');
  assert.match(execResult.note, /runs Companion or its socket proxy/);

  mutations.length = 0;
  const ranPrune = await post('/cron/run', { csrf, id: 'prune-containers' });
  assert.equal(ranPrune.status, 303);
  assert.deepEqual(mutations, [`DELETE /containers/${ID.leftover}`]);
});
