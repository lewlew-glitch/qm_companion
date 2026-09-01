import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';


async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close((e) => (e ? reject(e) : resolve(port))); });
  });
}

async function waitFor(fn, child, what) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    const value = await fn().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function setCookies(response) {
  return response.headers.getSetCookie();
}

function cookieOf(response, name) {
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(setCookies(response).join(', '));
  return match ? `${name}=${match[1]}` : '';
}

function cookieLine(response, name) {
  return setCookies(response).find((line) => line.startsWith(`${name}=`)) || '';
}

const PASSWORD = 'owner-password-123';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function totpForBase32(text, at = Date.now()) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text) {
    const index = BASE32.indexOf(char);
    assert.notEqual(index, -1, `invalid base32 character ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const number = (((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]) % 1_000_000;
  return String(number).padStart(6, '0');
}

async function boot(t, extraEnv, { secureSetup = false } = {}) {
  const port = await freePort();
  const dataDir = extraEnv.DATA_DIR || mkdtempSync(join(tmpdir(), 'qm-mobile-owner-'));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, SECRET_KEY: '33'.repeat(32), DATA_DIR: dataDir, QM_HOST: '127.0.0.1', QM_STACK: join(dataDir, 'stack'), BIND_ADDRESS: '127.0.0.1', PORT: String(port), DOCKER_HOST: 'tcp://127.0.0.1:9', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  t.after(() => { child.kill('SIGTERM'); rmSync(dataDir, { recursive: true, force: true }); });
  await waitFor(async () => (await fetch(`${origin}/healthz`)).status === 200, child, 'healthz');
  const setupToken = await waitFor(async () => (/first-run setup token: ([A-Za-z0-9_-]{43})/.exec(stdout) || [])[1], child, 'setup token');
  const log = () => stdout + stderr;
  if (secureSetup) {
    const advertised = extraEnv.QM_ADVERTISED_ORIGIN;
    await waitFor(async () => /mobile api: https/.test(log()), child, 'the secure surface');
    relaxTls();
    try {
      const setup = await fetch(`${advertised}/setup`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ setupToken, password: PASSWORD }).toString(), redirect: 'manual' });
      assert.equal(setup.status, 303, `${setup.status}: ${stderr}`);
      const cookie = cookieOf(setup, 'qm_mobile_sess');
      assert.ok(cookie);
      const page = await fetch(`${advertised}/devices`, { headers: { cookie, accept: 'text/html' } });
      const html = await page.text();
      const csrf = (html.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
      assert.ok(csrf, 'the secure Devices page binds csrf');
      return { origin, advertised, cookie, csrf, sessionLine: cookieLine(setup, 'qm_mobile_sess'), devicesHtml: html, devicesResponse: page, child, dataDir, log };
    } finally {
      restoreTls();
    }
  }
  const setup = await fetch(`${origin}/setup`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ setupToken, password: PASSWORD }).toString(), redirect: 'manual' });
  assert.equal(setup.status, 303, stderr);
  const cookie = cookieOf(setup, 'qm_sess');
  const page = await (await fetch(`${origin}/devices`, { headers: { cookie } })).text();
  const csrf = (page.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, 'devices page binds csrf');
  return { origin, cookie, csrf, setupCookies: setCookies(setup), child, dataDir, log };
}

async function startExisting(t, dataDir, extraEnv) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, SECRET_KEY: '33'.repeat(32), DATA_DIR: dataDir, QM_HOST: '127.0.0.1', QM_STACK: join(dataDir, 'stack'), BIND_ADDRESS: '127.0.0.1', PORT: String(port), DOCKER_HOST: 'tcp://127.0.0.1:9', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  t.after(() => child.kill('SIGTERM'));
  await waitFor(async () => (await fetch(`${origin}/healthz`)).status === 200, child, 'restarted healthz');
  return { origin, child, log: () => stdout + stderr };
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

async function secureLogin(advertised) {
  const form = await fetch(`${advertised}/login`, { headers: { accept: 'text/html' } });
  assert.equal(form.status, 200);
  const formHtml = await form.text();
  const formToken = (formHtml.match(/name="formToken" value="([A-Za-z0-9_-]{43})"/) || [])[1];
  assert.ok(formToken, 'the secure sign-in page issues a form token');
  const formCookie = cookieOf(form, 'qm_mobile_login_form');
  assert.ok(formCookie, 'the secure sign-in page sets its own form cookie');
  const posted = await fetch(`${advertised}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: formCookie },
    body: new URLSearchParams({ formToken, password: PASSWORD }).toString(),
    redirect: 'manual',
  });
  assert.equal(posted.status, 303, await posted.text().catch(() => ''));
  const sessionLine = cookieLine(posted, 'qm_mobile_sess');
  const cookie = cookieOf(posted, 'qm_mobile_sess');
  assert.ok(cookie, 'the secure sign-in mints its own session cookie');
  const page = await fetch(`${advertised}/devices`, { headers: { cookie, accept: 'text/html' } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const csrf = (html.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf, 'the secure Devices page binds csrf');
  return { cookie, csrf, sessionLine, loginResponse: posted, devicesHtml: html, devicesResponse: page };
}

const relaxTls = () => { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; };
const restoreTls = () => { delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; };

test('rejects setup and credentials over HTTP when HTTPS is configured', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mobile-owner-first-run-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const mobilePort = await freePort();
  const advertised = `https://127.0.0.1:${mobilePort}`;
  const started = await startExisting(t, dataDir, {
    MOBILE_API_ENABLED: 'true',
    MOBILE_ENROLMENT_ENABLED: 'true',
    QM_ADVERTISED_ORIGIN: advertised,
    MOBILE_PORT: String(mobilePort),
    MOBILE_BIND_ADDRESS: '127.0.0.1',
  });
  await waitFor(async () => /mobile api: https/.test(started.log()), started.child, 'first-run HTTPS panel');

  const page = await fetch(`${started.origin}/setup`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 403);
  const body = await page.text();
  assert.match(body, new RegExp(advertised.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(body, /type="password"|name="setupToken"/);
  const post = await fetch(`${started.origin}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'setupToken=attacker&password=attacker-password',
  });
  assert.equal(post.status, 403);

  relaxTls();
  try {
    assert.equal((await fetch(`${advertised}/setup`, { headers: { accept: 'text/html' } })).status, 200);
  } finally {
    restoreTls();
  }
});

test('HTTP owner routes remain closed after HTTPS failure', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mobile-owner-invalid-config-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const started = await startExisting(t, dataDir, {
    MOBILE_API_ENABLED: 'true',
    MOBILE_ENROLMENT_ENABLED: 'true',
    QM_ADVERTISED_ORIGIN: '',
    MOBILE_PORT: '8788',
    MOBILE_BIND_ADDRESS: '127.0.0.1',
  });
  await waitFor(async () => /mobile api: off/.test(started.log()), started.child, 'invalid secure configuration refusal');

  assert.equal((await fetch(`${started.origin}/healthz`)).status, 200, 'health remains available');
  const page = await fetch(`${started.origin}/setup`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 403);
  const body = await page.text();
  assert.match(body, /Secure owner access is on, but no valid address is configured/);
  assert.match(body, /QM_ADVERTISED_ORIGIN/);
  assert.match(body, /MOBILE_API_ENABLED=false/, 'and the escape hatch back to the plaintext panel');
  assert.doesNotMatch(body, /type="password"|name="setupToken"|href="undefined/);
  const posted = await fetch(`${started.origin}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'setupToken=attacker&password=attacker-password',
  });
  assert.equal(posted.status, 403);
});

test('denies HTTP owner authority while HTTPS is active', async (t) => {
  const mobilePort = await freePort();
  const advertised = `https://127.0.0.1:${mobilePort}`;
  const booted = await boot(t, { MOBILE_API_ENABLED: 'true', MOBILE_ENROLMENT_ENABLED: 'true', QM_ADVERTISED_ORIGIN: advertised, MOBILE_PORT: String(mobilePort), MOBILE_BIND_ADDRESS: '127.0.0.1' }, { secureSetup: true });
  const { origin } = booted;

  for (const path of ['/login', '/login/mfa']) {
    const posted = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: PASSWORD, formToken: 'x', code: '000000' }).toString(), redirect: 'manual' });
    assert.equal(posted.status, 403, path);
    assert.equal(cookieOf(posted, 'qm_sess'), '', `${path} mints no session`);
    const body = await posted.text();
    assert.ok(body.includes(advertised) || body.includes('secure owner surface'), `${path} names the secure origin`);
  }
  const setupAgain = await fetch(`${origin}/setup`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'setupToken=x&password=another-password-123', redirect: 'manual' });
  assert.ok([403, 404].includes(setupAgain.status), `setup -> ${setupAgain.status}`);
  assert.equal(cookieOf(setupAgain, 'qm_sess'), '', 'setup mints no session on the plaintext plane');
  const page = await fetch(`${origin}/login`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 403);
  const pageHtml = await page.text();
  assert.match(pageHtml, new RegExp(advertised.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(pageHtml, /type="password"/);

  for (const path of ['/devices/pair', '/devices/pair-qr', '/devices/approve', '/devices/reject', '/devices/revoke', '/devices/rename', '/devices/forget', '/api/mobile/v1/enrolments', '/settings/prefs', '/profile/name', '/logout']) {
    const posted = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=anything' });
    assert.equal(posted.status, 403, path);
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const sent = await fetch(`${origin}/api/mobile/v1/enrolments/AAAAAAAAAAAAAAAAAAAAAA`, { method });
    assert.equal(sent.status, 403, method);
  }

  for (const path of ['/api/mobile/v1/devices', '/api/mobile/v1/enrolments/AAAAAAAAAAAAAAAAAAAAAA', '/devices', '/devices/live']) {
    const read = await fetch(`${origin}${path}`);
    assert.ok([401, 403].includes(read.status), `${path} -> ${read.status}`);
  }
  for (const path of ['/api/mobile/v1/identity?challenge=x', '/api/mobile/v1/summary', '/api/mobile/v1/meta']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 403, path);
  }
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
});

test('native HTTPS remains authoritative when trust proxy is enabled', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mobile-owner-trusted-proxy-'));
  const stackDir = join(dataDir, 'stack', 'radarr');
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, 'config.xml'), '<Config><ApiKey>detected-api-key</ApiKey><Port>7878</Port><InstanceName>Radarr</InstanceName></Config>');

  const mobilePort = await freePort();
  const advertised = `https://127.0.0.1:${mobilePort}`;
  const secure = await boot(t, {
    DATA_DIR: dataDir,
    TRUST_PROXY: 'true',
    MOBILE_API_ENABLED: 'true',
    MOBILE_ENROLMENT_ENABLED: 'true',
    QM_ADVERTISED_ORIGIN: advertised,
    MOBILE_PORT: String(mobilePort),
    MOBILE_BIND_ADDRESS: '127.0.0.1',
  }, { secureSetup: true });

  relaxTls();
  try {
    const pair = await fetch(`${advertised}/pair`, { headers: { cookie: secure.cookie, accept: 'text/html' } });
    assert.equal(pair.status, 200);
    const pairHtml = await pair.text();
    const instanceId = (pairHtml.match(/name="service_0" value="([^"]+)"/u) || [])[1];
    assert.ok(instanceId, 'the mounted Radarr instance is available for transfer');

    const body = new URLSearchParams({
      csrf: secure.csrf,
      service_0: instanceId,
      include_0: 'on',
      base_0: 'http://127.0.0.1:7878',
      remote_0: 'https://radarr.example.com',
      edge_domain: 'example.com',
      edge_client_id: 'client-id.access',
      edge_client_secret: 'client-secret',
    });
    const postPair = async (headers = {}) => {
      const response = await fetch(`${advertised}/pair`, {
        method: 'POST',
        headers: {
          cookie: secure.cookie,
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          ...headers,
        },
        body: body.toString(),
        redirect: 'manual',
      });
      const html = await response.text();
      assert.equal(response.status, 200, html);
      assert.match(html, /One-time transfer ready/);
      assert.doesNotMatch(html, /proxy did not provide|only be transferred from Companion over HTTPS/i);
    };

    await postPair();
    await postPair({ 'x-forwarded-proto': 'http' });
  } finally {
    restoreTls();
  }
});

test('rejects TLS session cookies on plaintext routes', async (t) => {
  const mobilePort = await freePort();
  const advertised = `https://127.0.0.1:${mobilePort}`;
  const booted = await boot(t, { MOBILE_API_ENABLED: 'true', MOBILE_ENROLMENT_ENABLED: 'true', QM_ADVERTISED_ORIGIN: advertised, MOBILE_PORT: String(mobilePort), MOBILE_BIND_ADDRESS: '127.0.0.1' }, { secureSetup: true });
  const { origin, cookie, csrf } = booted;
  const value = cookie.split('=').slice(1).join('=');
  const renamed = `qm_sess=${value}`;
  assert.notEqual(renamed, cookie);

  relaxTls();
  try {
    assert.equal((await fetch(`${advertised}/api/mobile/v1/devices`, { headers: { cookie, 'x-csrf-token': csrf } })).status, 200);
  } finally {
    restoreTls();
  }

  const reads = ['/', '/devices', '/devices/live', '/containers', '/settings', '/api/services', '/api/mobile/v1/devices'];
  for (const path of reads) {
    const read = await fetch(`${origin}${path}`, { headers: { cookie: renamed } });
    assert.ok([401, 403].includes(read.status), `read ${path} -> ${read.status}`);
  }
  const writes = ['/profile/name', '/settings/prefs', '/devices/revoke', '/api/mobile/v1/enrolments'];
  for (const path of writes) {
    const written = await fetch(`${origin}${path}`, { method: 'POST', headers: { cookie: renamed, 'x-csrf-token': csrf, 'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}` });
    assert.ok([401, 403].includes(written.status), `write ${path} -> ${written.status}`);
  }
  const html = await (await fetch(`${origin}/`, { headers: { cookie: renamed, accept: 'text/html' } })).text();
  assert.doesNotMatch(html, /name="csrf" content=/);
});

test('requires secure cookies and CSRF for HTTPS owner writes', { skip: spawnSync('openssl', ['version']).status !== 0 && 'openssl unavailable' }, async (t) => {
  const mobilePort = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mobile-owner-tls-'));
  mkdirSync(join(dataDir, 'tls'), { recursive: true });
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dataDir, 'tls', 'mobile.key'), '-out', join(dataDir, 'tls', 'mobile.crt'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  assert.equal(made.status, 0);
  const advertised = `https://127.0.0.1:${mobilePort}`;
  const { origin, cookie: setupCookie, log } = await boot(t, { DATA_DIR: dataDir, MOBILE_API_ENABLED: 'true', MOBILE_ENROLMENT_ENABLED: 'true', QM_ADVERTISED_ORIGIN: advertised, MOBILE_PORT: String(mobilePort), MOBILE_BIND_ADDRESS: '127.0.0.1' }, { secureSetup: true });
  assert.match(log(), /mobile api: https:\/\/127\.0\.0\.1/);
  relaxTls();
  try {
    const secure = await secureLogin(advertised);
    const h = { cookie: secure.cookie, 'x-csrf-token': secure.csrf, 'content-type': 'application/json' };

    assert.match(secure.sessionLine, /^qm_mobile_sess=/);
    assert.match(secure.sessionLine, /;\s*Secure/i);
    assert.match(secure.sessionLine, /;\s*HttpOnly/i);
    assert.match(secure.sessionLine, /;\s*SameSite=Lax/i);
    assert.notEqual(secure.cookie, setupCookie, 'a later sign-in gets a fresh TLS session');

    assert.equal((await fetch(`${origin}/api/mobile/v1/devices`, { headers: { cookie: secure.cookie } })).status, 403);

    assert.equal((await fetch(`${advertised}/api/mobile/v1/enrolments`, { method: 'POST', headers: { cookie: secure.cookie, 'content-type': 'application/json' } })).status, 403);
    assert.equal((await fetch(`${advertised}/devices/pair`, { method: 'POST', headers: { cookie: secure.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=wrong' })).status, 403);

    const created = await (await fetch(`${advertised}/api/mobile/v1/enrolments`, { method: 'POST', headers: h })).json();
    assert.match(created.pairingKey, /^qmp_/);
    assert.equal(created.origin, advertised);
    assert.equal('qr' in created, false);
    const { parseQrPayload } = await import('../src/mobile/qr.js');
    const qrRow = await (await fetch(`${advertised}/api/mobile/v1/enrolments`, { method: 'POST', headers: h, body: JSON.stringify({ mode: 'qr' }) })).json();
    assert.deepEqual(Object.keys(qrRow).sort(), ['enrolmentId', 'expiresAt', 'origin', 'qr', 'qrPng', 'v']);
    const scanned = parseQrPayload(qrRow.qr);
    assert.equal(scanned.ok, true, scanned.error);
    assert.match(scanned.key, /^qme_/);

    const qrPage = await fetch(`${advertised}/devices/pair-qr`, { method: 'POST', headers: { cookie: secure.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: secure.csrf }).toString() });
    assert.equal(qrPage.status, 200);
    const qrHtml = await qrPage.text();
    assert.match(qrHtml, /Your pairing QR code, shown once/);
    assert.match(qrHtml, /<img src="data:image\/png;base64,/);
    assert.doesNotMatch(qrHtml, /QMC2:/);
    assert.doesNotMatch(qrHtml, /qme_/);
    assert.doesNotMatch(log(), /QMC2:|qme_|qmp_/, 'no capability reaches the server log');

    const { generateKeyPairSync, randomBytes } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
    const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    const claimed = await (await fetch(`${advertised}/api/mobile/v1/enrolments/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, pairingKey: created.pairingKey, claimEncryptionPublicKey: pub, clientNonce: randomBytes(16).toString('base64url'), deviceName: 'Server-test iPhone', requestedScopes: ['summary.read'], candidateOrigin: advertised }) })).json();
    assert.equal(claimed.state, 'awaiting_owner_approval', JSON.stringify(claimed));

    assert.equal((await fetch(`${advertised}/api/mobile/v1/enrolments/${created.enrolmentId}`, { headers: { cookie: secure.cookie } })).status, 403, 'the SAS read needs CSRF too');
    const view = await (await fetch(`${advertised}/api/mobile/v1/enrolments/${created.enrolmentId}`, { headers: h })).json();
    assert.equal(view.sasWords.length, 5);
    assert.equal(view.transcript.deviceName, 'Server-test iPhone');
    const securePage = await (await fetch(`${advertised}/devices`, { headers: { cookie: secure.cookie } })).text();
    assert.match(securePage, new RegExp(view.sasWords.join(' · ')));
    assert.doesNotMatch(securePage, /qmp_/);
    const liveResponse = await fetch(`${advertised}/devices/live`, { headers: { cookie: secure.cookie } });
    assert.equal(liveResponse.status, 200);
    const live = await liveResponse.text();
    assert.match(live, /Pending pairings/);
    assert.match(live, new RegExp(view.sasWords.join(' · ')));
    assert.doesNotMatch(live, /<html/, 'the live answer is a fragment the grid swaps in');
    assert.doesNotMatch(live, /qmp_/);
    const panelResponse = await fetch(`${origin}/devices`, { headers: { cookie: secure.cookie } });
    assert.equal(panelResponse.status, 403);
    const panelPage = await panelResponse.text();
    assert.doesNotMatch(panelPage, new RegExp(view.sasWords.join(' · ')));

    const protocol = await import('../src/mobile/protocol.js');
    const tBytes = Buffer.from(claimed.transcript, 'base64url');
    assert.deepEqual(protocol.deriveSas(protocol.transcriptHash(tBytes)).words, view.sasWords);
    const approved = await (await fetch(`${advertised}/api/mobile/v1/enrolments/${created.enrolmentId}/approve`, { method: 'POST', headers: h })).json();
    assert.equal(approved.state, 'grant_ready', JSON.stringify(approved));
    const grant = await (await fetch(`${advertised}/api/mobile/v1/enrolments/grant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, enrolmentId: created.enrolmentId }) })).json();
    const wrapper = JSON.parse((await protocol.openGrant(priv, grant.envelope, protocol.transcriptHash(tBytes))).toString('utf8'));
    const ack = await (await fetch(`${advertised}/api/mobile/v1/enrolments/acknowledge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, enrolmentId: created.enrolmentId, ackSecret: wrapper.grant.ackSecret }) })).json();
    assert.equal(ack.state, 'acknowledged', JSON.stringify(ack));
    assert.equal((await fetch(`${advertised}/api/mobile/v1/meta`, { headers: { authorization: `Bearer ${wrapper.grant.accessToken}` } })).status, 200);

    const listed = await (await fetch(`${advertised}/api/mobile/v1/devices`, { headers: h })).json();
    assert.equal(listed.devices[0].deviceName, 'Server-test iPhone');
    const renamed = await (await fetch(`${advertised}/api/mobile/v1/devices/${wrapper.grant.deviceId}/rename`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Test iPhone' }) })).json();
    assert.equal(renamed.renamed, true);
    const revoked = await (await fetch(`${advertised}/api/mobile/v1/devices/${wrapper.grant.deviceId}/revoke`, { method: 'POST', headers: h })).json();
    assert.equal(revoked.revoked, true);
    assert.equal((await fetch(`${advertised}/api/mobile/v1/meta`, { headers: { authorization: `Bearer ${wrapper.grant.accessToken}` } })).status, 401);
    const forgotten = await (await fetch(`${advertised}/api/mobile/v1/devices/${wrapper.grant.deviceId}/forget`, { method: 'POST', headers: h })).json();
    assert.equal(forgotten.forgotten, true);

    assert.equal(secure.devicesResponse.headers.get('strict-transport-security'), null);
    assert.equal(secure.loginResponse?.headers.get('strict-transport-security') ?? null, null);
  } finally {
    restoreTls();
  }
});

test('serves a generated certificate without HSTS', async (t) => {
  const mobilePort = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mobile-owner-gen-'));
  const advertised = `https://127.0.0.1:${mobilePort}`;
  const { origin, cookie, log } = await boot(t, { DATA_DIR: dataDir, MOBILE_API_ENABLED: 'true', MOBILE_ENROLMENT_ENABLED: 'true', QM_ADVERTISED_ORIGIN: advertised, MOBILE_PORT: String(mobilePort), MOBILE_BIND_ADDRESS: '127.0.0.1' }, { secureSetup: true });
  assert.match(log(), /mobile api: generated a self-signed certificate for 127\.0\.0\.1/);
  assert.match(log(), /mobile api: https:\/\/127\.0\.0\.1.*tls generated leaf/);
  assert.doesNotMatch(log(), /PRIVATE KEY/);
  const { readFileSync, statSync } = await import('node:fs');
  assert.equal(statSync(join(dataDir, 'tls', 'mobile.key')).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(join(dataDir, 'tls', 'mobile.json'), 'utf8'));
  assert.equal(record.generated, true);
  relaxTls();
  try {
    const secure = await secureLogin(advertised);
    assert.equal(secure.devicesResponse.headers.get('strict-transport-security'), null);
    assert.equal(secure.loginResponse.headers.get('strict-transport-security'), null);
    assert.match(secure.devicesHtml, /Generated for 127\.0\.0\.1/);
    assert.ok(secure.devicesHtml.includes(record.fingerprint), 'the secure Devices page shows the fingerprint');
    assert.match(secure.devicesHtml, /Create pairing key/);
    assert.equal((await fetch(`${advertised}/assets/app.css`)).status, 200);
    for (const face of ['sans.woff2', 'mono.woff2']) {
      const served = await fetch(`${advertised}/assets/fonts/${face}`);
      assert.equal(served.status, 200, `${face} is served`);
      assert.equal(served.headers.get('content-type'), 'font/woff2');
    }
    assert.equal((await fetch(`${advertised}/assets/fonts/plex.woff2`)).status, 404);
    const panelResponse = await fetch(`${origin}/devices`, { headers: { cookie } });
    assert.equal(panelResponse.status, 403);
    const panel = await panelResponse.text();
    assert.doesNotMatch(panel, new RegExp(record.fingerprint));
    assert.doesNotMatch(panel, /Create pairing key/);
    const probe = await fetch(`${advertised}/api/mobile/v1/identity?challenge=bad`);
    assert.equal(probe.status, 400);
  } finally {
    restoreTls();
  }
});

test('owner routes remain on HTTPS after restart', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mobile-owner-restart-'));
  const first = await boot(t, { DATA_DIR: dataDir, MOBILE_API_ENABLED: 'false' });
  const oldHttpCookie = first.cookie;
  await stopChild(first.child);

  const mobilePort = await freePort();
  const advertised = `https://127.0.0.1:${mobilePort}`;
  const restarted = await startExisting(t, dataDir, {
    MOBILE_API_ENABLED: 'true',
    MOBILE_ENROLMENT_ENABLED: 'true',
    QM_ADVERTISED_ORIGIN: advertised,
    MOBILE_PORT: String(mobilePort),
    MOBILE_BIND_ADDRESS: '127.0.0.1',
  });
  await waitFor(async () => /mobile api: https/.test(restarted.log()), restarted.child, 'the restarted HTTPS panel');

  assert.equal((await fetch(`${restarted.origin}/`, { headers: { cookie: oldHttpCookie, accept: 'text/html' } })).status, 403);
  assert.equal((await fetch(`${restarted.origin}/profile/name`, {
    method: 'POST',
    headers: { cookie: oldHttpCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'csrf=anything&name=cleartext',
  })).status, 403);

  relaxTls();
  try {
    const secure = await secureLogin(advertised);
    for (const path of ['/', '/pair', '/containers', '/stacks', '/settings', '/profile']) {
      const response = await fetch(`${advertised}${path}`, { headers: { cookie: secure.cookie, accept: 'text/html' } });
      assert.equal(response.status, 200, `${path} is available on the HTTPS panel`);
      assert.match(response.headers.get('content-type') || '', /^text\/html/);
    }
    const services = await fetch(`${advertised}/api/services`, { headers: { cookie: secure.cookie } });
    assert.equal(services.status, 200, 'the panel read API is available over HTTPS');

    const renamed = await fetch(`${advertised}/profile/name`, {
      method: 'POST',
      headers: { cookie: secure.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: secure.csrf, name: 'Secure owner' }).toString(),
    });
    assert.equal(renamed.status, 200, 'a body-CSRF profile write works over HTTPS');
    assert.match(await renamed.text(), /Secure owner/);

    const adopted = await fetch(`${advertised}/stacks/adopt`, {
      method: 'POST',
      headers: { cookie: secure.cookie, 'x-csrf-token': secure.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'secure-test', yaml: 'services:\n  app:\n    image: example/app:latest\n' }),
    });
    assert.equal(adopted.status, 200, 'a header-CSRF management write works over HTTPS');
    assert.equal((await adopted.json()).ok, true);

    const mfaSetup = await fetch(`${advertised}/settings/mfa`, { headers: { cookie: secure.cookie, accept: 'text/html' } });
    assert.equal(mfaSetup.status, 200, 'two-factor setup renders over HTTPS');
    const mfaSetupHtml = await mfaSetup.text();
    const secret = (mfaSetupHtml.match(/<code>([A-Z2-7]+)<\/code>/u) || [])[1];
    assert.ok(secret);
    const enabled = await fetch(`${advertised}/settings/mfa/enable`, {
      method: 'POST',
      headers: { cookie: secure.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: secure.csrf, code: totpForBase32(secret) }).toString(),
    });
    assert.equal(enabled.status, 200, 'two-factor can be enabled over HTTPS');
    const enabledHtml = await enabled.text();
    assert.match(enabledHtml, /Recovery codes/);
    const enabledCookie = cookieOf(enabled, 'qm_mobile_sess');
    const enabledCsrf = (enabledHtml.match(/name="csrf" content="([a-f0-9]+)"/u) || [])[1];
    assert.ok(enabledCookie && enabledCsrf);

    const loggedOut = await fetch(`${advertised}/logout`, {
      method: 'POST',
      headers: { cookie: enabledCookie, 'x-csrf-token': enabledCsrf },
      redirect: 'manual',
    });
    assert.equal(loggedOut.status, 303, 'logout works over HTTPS');
    assert.match(cookieLine(loggedOut, 'qm_mobile_sess'), /Max-Age=0/i);
    assert.equal((await fetch(`${advertised}/`, { headers: { cookie: enabledCookie } })).status, 401, 'logout destroys the TLS session');

    const loginForm = await fetch(`${advertised}/login`, { headers: { accept: 'text/html' } });
    const loginHtml = await loginForm.text();
    const loginFormToken = (loginHtml.match(/name="formToken" value="([A-Za-z0-9_-]{43})"/u) || [])[1];
    const loginFormCookie = cookieOf(loginForm, 'qm_mobile_login_form');
    const passwordStep = await fetch(`${advertised}/login`, {
      method: 'POST',
      headers: { cookie: loginFormCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ formToken: loginFormToken, password: PASSWORD }).toString(),
      redirect: 'manual',
    });
    assert.equal(passwordStep.status, 200, 'the password step advances to HTTPS two-factor');
    const passwordHtml = await passwordStep.text();
    const ticket = (passwordHtml.match(/name="ticket" value="([A-Za-z0-9_-]+)"/u) || [])[1];
    const mfaFormToken = (passwordHtml.match(/name="formToken" value="([A-Za-z0-9_-]{43})"/u) || [])[1];
    const mfaFormCookie = cookieOf(passwordStep, 'qm_mobile_login_form') || loginFormCookie;
    assert.ok(ticket && mfaFormToken);
    const mfaStep = await fetch(`${advertised}/login/mfa`, {
      method: 'POST',
      headers: { cookie: mfaFormCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket, formToken: mfaFormToken, code: totpForBase32(secret) }).toString(),
      redirect: 'manual',
    });
    assert.equal(mfaStep.status, 303, 'two-factor sign-in completes over HTTPS');
    const mfaCookie = cookieOf(mfaStep, 'qm_mobile_sess');
    assert.ok(mfaCookie);
    assert.equal((await fetch(`${advertised}/`, { headers: { cookie: mfaCookie } })).status, 200);
  } finally {
    restoreTls();
  }
});

test('rejects enrolment when the HTTPS owner surface is unavailable', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mobile-owner-busy-'));
  const first = await boot(t, { DATA_DIR: dataDir, MOBILE_API_ENABLED: 'false' });
  await stopChild(first.child);
  const blocker = createServer();
  const busy = await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));
  t.after(() => blocker.close());
  const restarted = await startExisting(t, dataDir, { MOBILE_API_ENABLED: 'true', MOBILE_ENROLMENT_ENABLED: 'true', QM_ADVERTISED_ORIGIN: `https://127.0.0.1:${busy}`, MOBILE_PORT: String(busy), MOBILE_BIND_ADDRESS: '127.0.0.1' });
  const { origin, log } = restarted;
  await waitFor(async () => /mobile api: off/.test(log()), restarted.child, 'the off line');
  assert.match(log(), new RegExp(`mobile api: off \\(the listener on 127\\.0\\.0\\.1:${busy} failed \\(EADDRINUSE\\)\\)`));
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  for (const path of ['/setup', '/login', '/devices', '/settings', '/api/mobile/v1/devices']) {
    assert.equal((await fetch(`${origin}${path}`, { headers: { cookie: first.cookie, accept: 'text/html' } })).status, 403, path);
  }
  assert.equal((await fetch(`${origin}/api/mobile/v1/enrolments`, { method: 'POST', headers: { cookie: first.cookie } })).status, 403);
  assert.equal((await fetch(`${origin}/devices/pair`, { method: 'POST', headers: { cookie: first.cookie } })).status, 403);
});

test('HTTP remains closed after advertised-origin changes', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-mobile-owner-moved-'));
  const { ensureMobileCertificate } = await import('../src/mobile/cert.js');
  assert.equal(ensureMobileCertificate({ dataDir, host: '192.168.1.10' }).ok, true);
  const first = await boot(t, { DATA_DIR: dataDir, MOBILE_API_ENABLED: 'false' });
  await stopChild(first.child);
  const mobilePort = await freePort();
  const restarted = await startExisting(t, dataDir, { MOBILE_API_ENABLED: 'true', MOBILE_ENROLMENT_ENABLED: 'true', QM_ADVERTISED_ORIGIN: `https://127.0.0.1:${mobilePort}`, MOBILE_PORT: String(mobilePort), MOBILE_BIND_ADDRESS: '127.0.0.1' });
  const { origin, log } = restarted;
  await waitFor(async () => /mobile api: off/.test(log()), restarted.child, 'the off line');
  assert.match(log(), /mobile api: off \(the advertised origin changed: the generated certificate was issued for 192\.168\.1\.10/);
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  const page = await fetch(`${origin}/devices`, { headers: { cookie: first.cookie, accept: 'text/html' } });
  assert.equal(page.status, 403);
  assert.doesNotMatch(await page.text(), /fingerprint|Create pairing key/i);
});
