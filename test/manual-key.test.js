import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function listenAs(port, signature) {
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><title>${signature}</title></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function waitForServer(origin, child) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.status === 200) return;
    } catch {  }
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
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(values.join(', '));
  return match ? `${name}=${match[1]}` : '';
}

function jsonReply(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

test('manual pairing keys remain sealed and are not echoed', async (t) => {
  const docker = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/containers/json?all=1') {
      return jsonReply(res, 200, [{
        Id: 'a'.repeat(64),
        Names: ['/qm-ha'],
        Image: 'ghcr.io/home-assistant/home-assistant:stable',
        Ports: [{ PrivatePort: 8123, PublicPort: 8123, Type: 'tcp' }],
        Labels: { 'com.docker.compose.service': 'qm-ha' },
        State: 'running',
        Status: 'Up',
      }]);
    }
    return jsonReply(res, 404, { message: 'not available in this test' });
  });
  const dockerPort = await listen(docker);
  const homeAssistant = await listenAs(8123, 'Home Assistant');

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-manual-key-'));
  const stackDir = join(dataDir, 'stack');
  mkdirSync(stackDir, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '66'.repeat(32),
      DATA_DIR: dataDir,
      QM_HOST: '127.0.0.1',
      QM_STACK: stackDir,
      BIND_ADDRESS: '127.0.0.1',
      PORT: String(port),
      DOCKER_HOST: `tcp://127.0.0.1:${dockerPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await new Promise((resolve) => docker.close(resolve));
    await new Promise((resolve) => homeAssistant.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(origin, child);
  const setupToken = await waitForSetupToken(() => stdout, child);
  const claim = await fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken, password: 'manual-key-test-password' }).toString(),
    redirect: 'manual',
  });
  assert.equal(claim.status, 303, stderr);
  const sessionCookie = responseCookie(claim, 'qm_sess');
  assert.match(sessionCookie, /^qm_sess=/);

  const pair = await fetch(`${origin}/pair`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
  assert.equal(pair.status, 200, stderr);
  const pairHtml = await pair.text();
  const csrf = (pairHtml.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  const instanceId = (pairHtml.match(/data-instance="([^"]+)" data-kind="homeassistant"/) || [])[1];
  assert.ok(csrf && instanceId);
  assert.match(pairHtml, /data-manual-key type="password" maxlength="16384"/);

  const postManual = (body, headers = {}) => fetch(`${origin}/pair/keys/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const parseError = async (response, fragment) => {
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(fragment), 'manual key material is not echoed in an error');
    const value = JSON.parse(text);
    assert.deepEqual(Object.keys(value), ['error'], 'an error response exposes only an error');
    return value;
  };

  const anonymous = await postManual({ instanceId, apiKey: 'BADSECRETFRAGMENT-anonymous' });
  assert.equal(anonymous.status, 401);
  await parseError(anonymous, 'BADSECRETFRAGMENT');

  const noCsrf = await postManual(
    { instanceId, apiKey: 'BADSECRETFRAGMENT-no-csrf' },
    { cookie: sessionCookie },
  );
  assert.equal(noCsrf.status, 403);
  await parseError(noCsrf, 'BADSECRETFRAGMENT');

  const secured = { cookie: sessionCookie, 'x-csrf-token': csrf };
  for (const [apiKey, label] of [
    ['', 'empty'],
    ['   ', 'whitespace'],
    [`BADSECRETFRAGMENT\u0007`, 'control'],
    ['x'.repeat(16_385), 'oversize'],
  ]) {
    const response = await postManual({ instanceId, apiKey }, secured);
    assert.equal(response.status, 422, `${label} key is refused`);
    await parseError(response, 'BADSECRETFRAGMENT');
  }

  const unknown = await postManual({
    instanceId: `homeassistant-${'0'.repeat(16)}`,
    apiKey: 'BADSECRETFRAGMENT-unknown',
  }, secured);
  assert.equal(unknown.status, 404);
  await parseError(unknown, 'BADSECRETFRAGMENT');

  const expectedKey = 'qm-TOPSECRETFRAGMENT-12345';
  const saved = await postManual({ instanceId, apiKey: `  ${expectedKey}  ` }, secured);
  assert.equal(saved.status, 200);
  const savedText = await saved.text();
  assert.doesNotMatch(savedText, /TOPSECRETFRAGMENT/);
  assert.deepEqual(JSON.parse(savedText), { ok: true });

  const servicesResponse = await fetch(`${origin}/api/services`, { headers: { cookie: sessionCookie } });
  assert.equal(servicesResponse.status, 200);
  const servicesText = await servicesResponse.text();
  assert.doesNotMatch(servicesText, /TOPSECRETFRAGMENT/);
  const service = JSON.parse(servicesText).services.find((row) => row.instanceId === instanceId);
  assert.equal(service.credentialState, 'included', 'polling data flips the row to Included');
  assert.equal(service.hasKey, true);

  const overwrite = await postManual({ instanceId, apiKey: 'BADSECRETFRAGMENT-overwrite' }, secured);
  assert.equal(overwrite.status, 409);
  await parseError(overwrite, 'BADSECRETFRAGMENT');

  const refreshedPair = await fetch(`${origin}/pair`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
  const refreshedHtml = await refreshedPair.text();
  assert.equal(refreshedPair.status, 200);
  assert.doesNotMatch(refreshedHtml, /TOPSECRETFRAGMENT/);
  const ready = await fetch(`${origin}/pair`, {
    method: 'POST',
    headers: {
      cookie: sessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({
      csrf,
      service_0: instanceId,
      include_0: 'on',
      base_0: 'http://127.0.0.1:8123',
      remote_0: '',
      edge_domain: '',
      edge_client_id: '',
      edge_client_secret: '',
    }).toString(),
  });
  assert.equal(ready.status, 200);
  const readyHtml = await ready.text();
  assert.match(readyHtml, /One-time transfer ready/);
  assert.doesNotMatch(readyHtml, /TOPSECRETFRAGMENT/);
  const filePath = (readyHtml.match(/href="(\/pair\/file\/[A-Za-z0-9_-]{24})"/) || [])[1];
  assert.ok(filePath, 'the encrypted file fallback is available');
  const transfer = await fetch(origin + filePath, { headers: { cookie: sessionCookie } });
  assert.equal(transfer.status, 200);
  const envelope = await transfer.text();
  assert.doesNotMatch(envelope, /TOPSECRETFRAGMENT/, 'the transfer contains only ciphertext');

  const rawState = readFileSync(join(dataDir, 'qm-companion.json'), 'utf8');
  assert.doesNotMatch(rawState, /TOPSECRETFRAGMENT/);
  const stateCheck = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { getMintedKeys, getAuditLog } from './src/store.js';
    const row = getMintedKeys()[process.env.EXPECTED_INSTANCE];
    const audit = getAuditLog();
    process.stdout.write(JSON.stringify({
      createdBy: row && row.createdBy,
      matches: !!row && row.apiKey === process.env.EXPECTED_TEST_KEY,
      auditContainsKey: audit.some((item) => item.line.includes('TOPSECRETFRAGMENT')),
    }));
  `], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '66'.repeat(32),
      DATA_DIR: dataDir,
      QM_HOST: '127.0.0.1',
      EXPECTED_INSTANCE: instanceId,
      EXPECTED_TEST_KEY: expectedKey,
    },
    encoding: 'utf8',
  });
  assert.equal(stateCheck.status, 0, stateCheck.stderr);
  assert.deepEqual(JSON.parse(stateCheck.stdout), {
    createdBy: 'manual',
    matches: true,
    auditContainsKey: false,
  });
  assert.doesNotMatch(stdout + stderr, /TOPSECRETFRAGMENT/);
});
