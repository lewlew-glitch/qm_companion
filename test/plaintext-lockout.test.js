import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';


function listenOn(port) {
  return new Promise((resolve, reject) => {
    const squatter = createServer();
    squatter.once('error', reject);
    squatter.listen(port, '127.0.0.1', () => resolve(squatter));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHttp(url, child) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    const answer = await fetch(url).catch(() => null);
    if (answer) return answer;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${url}`);
}

test('failed listeners are not advertised', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-lockout-'));
  const httpPort = await freePort();
  const mobilePort = await freePort();
  const squatter = await listenOn(mobilePort);

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      SECRET_KEY: 'cd'.repeat(32),
      DATA_DIR: dataDir,
      QM_HOST: '127.0.0.1',
      PORT: String(httpPort),
      MOBILE_API_ENABLED: 'true',
      MOBILE_ENROLMENT_ENABLED: 'true',
      MOBILE_PORT: String(mobilePort),
      MOBILE_BIND_ADDRESS: '127.0.0.1',
      QM_ADVERTISED_ORIGIN: `https://127.0.0.1:${mobilePort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });

  t.after(() => {
    child.kill('SIGKILL');
    squatter.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${httpPort}`;
  await waitForHttp(`${base}/healthz`, child);
  for (let attempt = 0; attempt < 120 && !/mobile api: off/.test(log); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(log, /mobile api: off/);

  const page = await fetch(`${base}/devices`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 403, 'the plaintext refusal is unchanged');
  const body = await page.text();

  assert.doesNotMatch(body, new RegExp(`<a href="https://127\\.0\\.0\\.1:${mobilePort}`));
  assert.match(body, /did not start/);
  assert.match(body, /QM_ADVERTISED_ORIGIN/, 'and names the value to fix');
  assert.match(body, /MOBILE_API_ENABLED=false/, 'and the way back to the plaintext panel');
  assert.match(body, /Make sure that port is published/);
  assert.match(body, /save the settings and recreate Companion/);
  assert.doesNotMatch(body, /docker-compose\.mobile\.yml|same -f overlay list/);

  const setup = await fetch(`${base}/setup`, { headers: { accept: 'text/html' } });
  assert.equal(setup.status, 403);
  assert.match(await setup.text(), /did not start/);

  const api = await fetch(`${base}/devices`, { headers: { accept: 'application/json' } });
  assert.equal(api.status, 403);
  const payload = await api.json();
  assert.equal(payload.origin, undefined);
  assert.match(payload.reason, /EADDRINUSE|failed/, 'the reason travels to scripts too');
  assert.ok(payload.remedy);

  assert.doesNotMatch(body, /set-cookie/i);
  assert.equal(page.headers.get('set-cookie'), null);
});
