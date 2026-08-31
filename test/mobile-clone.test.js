import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET_KEY = '7a'.repeat(32);
const HOST = '192.168.1.11';
const ORIGIN = `https://${HOST}:8788`;
const NONCE_A = 'a1'.repeat(16);
const NONCE_B = 'b2'.repeat(16);
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-mobile-clone-'));
  roots.push(root);
  return root;
}

function baseEnv(dataDir, extra = {}) {
  const env = { ...process.env, SECRET_KEY, DATA_DIR: dataDir, QM_HOST: HOST, QM_ADVERTISED_ORIGIN: ORIGIN, ...extra };
  delete env.QM_CLONE_AS_NEW;
  return { ...env, ...extra };
}

function run(dataDir, source, extra = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectRoot,
    env: baseEnv(dataDir, extra),
    encoding: 'utf8',
  });
}

const BOOT = `
  const { bootMobileClone } = await import('./src/mobile/clone.js');
  const result = bootMobileClone({ log: (line) => process.stderr.write(line) });
  const { loadMobileState } = await import('./src/mobile/store.js');
  const { describeMobileCertificate } = await import('./src/mobile/cert.js');
  const { config } = await import('./src/config.js');
  const main = await import('./src/store.js');
  const state = loadMobileState();
  const tls = describeMobileCertificate(config.dataDir);
  console.log(JSON.stringify({
    result,
    mobileId: state.mobileInstallationId,
    fingerprint: state.identity.fingerprint,
    legacy: state.legacyInstallationId,
    mainInstallationId: main.getInstallationId(),
    owner: main.hasOwner(),
    audit: main.getAuditLog().slice(0, 4).map((entry) => entry.line),
    devices: state.devices.length,
    spent: state.spentCapabilities.length,
    nonce: state.consumedCloneNonce,
    tlsResetPending: state.tlsResetPending,
    certFingerprint: tls.fingerprint,
    certSource: tls.source,
  }));
`;

const SEED = `
  const { ensureMobileCertificate } = await import('./src/mobile/cert.js');
  const { config } = await import('./src/config.js');
  const { updateMobileState } = await import('./src/mobile/store.js');
  const cert = ensureMobileCertificate({ dataDir: config.dataDir, host: ${JSON.stringify(HOST)} });
  if (!cert.ok) throw new Error(cert.reason);
  const hex = (c) => c.repeat(64);
  const at = Date.now();
  const state = updateMobileState((s) => {
    s.devices.push({
      accessTokenDigest: hex('1'), accessTokenExpiresAt: at + 60000, ackRecoveryExpiresAt: null, ackSecretDigest: hex('2'),
      claimEncryptionKeyHandle: hex('3'), createdAt: at, deviceId: 'AAAAAAAAAAAAAAAAAAAAAA', deviceName: 'Test iPhone',
      enrolmentId: 'BBBBBBBBBBBBBBBBBBBBBB', lastSeenAt: at, lookback: null, refreshAbsoluteDeadlineAt: at + 60000,
      refreshDigest: hex('4'), refreshIdleDeadlineAt: at + 60000, revokedAt: null, revokedReason: null,
      scopes: ['summary.read'], tlsLeafFingerprint: cert.fingerprint, tokenFamilyGeneration: 1, transcriptHash: hex('5'),
    });
    s.spentCapabilities.push({ claimEncryptionKeyHandle: hex('3'), digest: hex('6'), enrolmentId: 'BBBBBBBBBBBBBBBBBBBBBB', expiresAt: at + 60000, family: 'qmp', transcriptHash: hex('5') });
  });
  const main = await import('./src/store.js');
  console.log(JSON.stringify({ mobileId: state.mobileInstallationId, fingerprint: state.identity.fingerprint, certFingerprint: cert.fingerprint, devices: state.devices.length, legacy: main.getInstallationId(), audit: main.getAuditLog().length }));
`;

const CRASH_AFTER_STEP_ONE = `
  const { freshMobileState, saveMobileState } = await import('./src/mobile/store.js');
  const state = saveMobileState(freshMobileState({ consumedCloneNonce: ${JSON.stringify(NONCE_A)}, tlsResetPending: true }));
  console.log(JSON.stringify({ mobileId: state.mobileInstallationId, tlsResetPending: state.tlsResetPending }));
`;

function boot(dataDir, extra) {
  const out = run(dataDir, BOOT, extra);
  assert.equal(out.status, 0, out.stderr);
  return { ...JSON.parse(out.stdout), log: out.stderr };
}

function sidecarBytes(dataDir) {
  return readFileSync(join(dataDir, 'qm-mobile-v1.json'), 'utf8');
}

test('resets mobile state and generated TLS with a fresh nonce', () => {
  const dataDir = tempDir();
  const seeded = run(dataDir, SEED);
  assert.equal(seeded.status, 0, seeded.stderr);
  const before = JSON.parse(seeded.stdout);
  assert.equal(before.devices, 1);

  const first = boot(dataDir, { QM_CLONE_AS_NEW: NONCE_A });
  assert.equal(first.result.applied, true, first.log);
  assert.equal(first.result.inert, false);
  assert.equal(first.result.listenerAllowed, true);
  assert.equal(first.result.tls.outcome, 'regenerated');
  assert.notEqual(first.mobileId, before.mobileId, 'fresh mobile installation id');
  assert.notEqual(first.fingerprint, before.fingerprint, 'fresh Ed25519 identity');
  assert.equal(first.devices, 0);
  assert.equal(first.spent, 0);
  assert.equal(first.nonce, NONCE_A, 'the consumed nonce is recorded');
  assert.equal(first.tlsResetPending, false);
  assert.equal(first.certSource, 'generated');
  assert.notEqual(first.certFingerprint, before.certFingerprint, 'the generated certificate was regenerated');
  assert.equal(first.result.tls.previousFingerprint, before.certFingerprint);
  assert.equal(first.result.tls.fingerprint, first.certFingerprint);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'tls', 'mobile.json'), 'utf8')).fingerprint, first.certFingerprint);
  assert.match(first.log, /clone-as-new applied; this Companion is now mobile installation/);
  assert.match(first.log, /1 device forgotten/);
  assert.match(first.log, /regenerated the certificate for 192\.168\.1\.11/);
  assert.doesNotMatch(first.log, /PRIVATE KEY|sealedPrivateKey/);
  assert.equal(first.legacy, before.legacy);
  assert.equal(first.mainInstallationId, before.legacy);
  assert.equal(first.owner, false);
  assert.equal(first.audit.length, before.audit + 2);
  assert.match(first.audit[1], new RegExp(`clone-as-new applied; new mobile installation ${first.mobileId}`));
  assert.equal(first.audit[0], `mobile: clone-as-new regenerated the listener certificate (sha256 ${first.certFingerprint})`);
  assert.doesNotMatch(first.audit.join(' '), /PRIVATE|sealed|[0-9a-f]{24}:[0-9a-f]{32}:/);

  const bytes = sidecarBytes(dataDir);
  const second = boot(dataDir, { QM_CLONE_AS_NEW: NONCE_A });
  assert.equal(second.result.applied, false);
  assert.equal(second.result.inert, true);
  assert.equal(second.result.listenerAllowed, true);
  assert.equal(second.mobileId, first.mobileId);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.certFingerprint, first.certFingerprint);
  assert.equal(sidecarBytes(dataDir), bytes);
  assert.equal(second.log.trim().split('\n').length, 1);
  assert.match(second.log, /nonce already consumed; nothing changed/);

  const third = boot(dataDir, { QM_CLONE_AS_NEW: NONCE_B });
  assert.equal(third.result.applied, true);
  assert.notEqual(third.mobileId, first.mobileId);
  assert.notEqual(third.certFingerprint, first.certFingerprint);
  assert.equal(third.nonce, NONCE_B);
  assert.equal(third.tlsResetPending, false);

  const quietBytes = sidecarBytes(dataDir);
  const quiet = boot(dataDir, {});
  assert.equal(quiet.result.requested, false);
  assert.equal(quiet.result.listenerAllowed, true);
  assert.equal(quiet.mobileId, third.mobileId);
  assert.equal(sidecarBytes(dataDir), quietBytes);
  assert.equal(quiet.log, '');
});

test('completes a reset interrupted before TLS update', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, SEED).status, 0);
  const certBefore = JSON.parse(readFileSync(join(dataDir, 'tls', 'mobile.json'), 'utf8')).fingerprint;
  const crashed = run(dataDir, CRASH_AFTER_STEP_ONE);
  assert.equal(crashed.status, 0, crashed.stderr);
  const committed = JSON.parse(crashed.stdout);
  assert.equal(committed.tlsResetPending, true);

  const recovered = boot(dataDir, {});
  assert.equal(recovered.result.requested, false);
  assert.equal(recovered.result.pending, true);
  assert.equal(recovered.result.listenerAllowed, true);
  assert.equal(recovered.mobileId, committed.mobileId, 'the committed identity stands');
  assert.equal(recovered.nonce, NONCE_A);
  assert.equal(recovered.tlsResetPending, false);
  assert.notEqual(recovered.certFingerprint, certBefore, 'the certificate was regenerated by the retry');
  assert.match(recovered.log, /interrupted before the TLS step; finishing it now/);
  assert.match(recovered.log, /regenerated the certificate/);

  const again = run(dataDir, CRASH_AFTER_STEP_ONE);
  assert.equal(again.status, 0, again.stderr);
  const certMid = JSON.parse(readFileSync(join(dataDir, 'tls', 'mobile.json'), 'utf8')).fingerprint;
  const finished = boot(dataDir, { QM_CLONE_AS_NEW: NONCE_A });
  assert.equal(finished.result.inert, true);
  assert.equal(finished.result.applied, false);
  assert.equal(finished.result.listenerAllowed, true);
  assert.equal(finished.mobileId, JSON.parse(again.stdout).mobileId);
  assert.equal(finished.tlsResetPending, false);
  assert.notEqual(finished.certFingerprint, certMid);
  assert.match(finished.log, /already consumed; finishing the interrupted TLS step/);
});

test('blocks the listener while TLS reset is pending', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, SEED).status, 0);
  assert.equal(run(dataDir, CRASH_AFTER_STEP_ONE).status, 0);
  const probe = run(dataDir, `
    const { startMobileListener } = await import('./src/mobile/listener.js');
    const lines = [];
    const started = await startMobileListener({ log: (l) => lines.push(l) });
    console.log(JSON.stringify({ started: started !== null, log: lines.join('') }));
  `, { MOBILE_API_ENABLED: 'true', MOBILE_PORT: '8788', MOBILE_BIND_ADDRESS: '127.0.0.1' });
  assert.equal(probe.status, 0, probe.stderr);
  const got = JSON.parse(probe.stdout);
  assert.equal(got.started, false);
  assert.match(got.log, /mobile api: off \(tlsResetPending/);
});

test('preserves owner TLS material during clone reset', () => {
  const dataDir = tempDir();
  const made = run(dataDir, `
    const { buildSelfSignedCertificate } = await import('./src/mobile/x509.js');
    const { tlsPaths } = await import('./src/mobile/cert.js');
    const { config } = await import('./src/config.js');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const paths = tlsPaths(config.dataDir);
    mkdirSync(paths.dir, { recursive: true });
    const own = buildSelfSignedCertificate({ host: ${JSON.stringify(HOST)} });
    writeFileSync(paths.certPath, own.certPem);
    writeFileSync(paths.keyPath, own.keyPem);
    const { loadMobileState } = await import('./src/mobile/store.js');
    console.log(JSON.stringify({ mobileId: loadMobileState().mobileInstallationId }));
  `);
  assert.equal(made.status, 0, made.stderr);
  const certPem = readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8');
  const keyPem = readFileSync(join(dataDir, 'tls', 'mobile.key'), 'utf8');
  const cloned = boot(dataDir, { QM_CLONE_AS_NEW: NONCE_A });
  assert.equal(cloned.result.applied, true);
  assert.equal(cloned.result.tls.outcome, 'owner');
  assert.equal(cloned.result.listenerAllowed, true);
  assert.notEqual(cloned.mobileId, JSON.parse(made.stdout).mobileId);
  assert.equal(cloned.tlsResetPending, false);
  assert.equal(cloned.certSource, 'owner');
  assert.equal(readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8'), certPem, 'mobile.crt untouched');
  assert.equal(readFileSync(join(dataDir, 'tls', 'mobile.key'), 'utf8'), keyPem, 'mobile.key untouched');
  assert.equal(existsSync(join(dataDir, 'tls', 'mobile.json')), false, 'no generated record invented');
  assert.match(cloned.log, /owner-supplied and was left in place; replace mobile\.crt and mobile\.key yourself/);

  const bare = tempDir();
  const none = boot(bare, { QM_CLONE_AS_NEW: NONCE_A });
  assert.equal(none.result.applied, true);
  assert.equal(none.result.tls.outcome, 'regenerated');
  assert.equal(none.tlsResetPending, false);
  assert.match(String(none.certFingerprint), /^[0-9a-f]{64}$/);
  assert.equal(none.certSource, 'generated');

  const hostless = tempDir();
  const noHost = boot(hostless, { QM_CLONE_AS_NEW: NONCE_A, QM_ADVERTISED_ORIGIN: '' });
  assert.equal(noHost.result.applied, true);
  assert.equal(noHost.result.tls.outcome, 'absent');
  assert.equal(noHost.tlsResetPending, false);
  assert.equal(noHost.certFingerprint, null);
});

test('rejects invalid nonces and corrupt sidecars', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, SEED).status, 0);
  const bytes = sidecarBytes(dataDir);
  const certBefore = readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8');
  for (const bad of ['zz', 'A1'.repeat(16), 'a1'.repeat(15), 'a1'.repeat(17), ' ' + NONCE_A]) {
    const refused = boot(dataDir, { QM_CLONE_AS_NEW: bad });
    assert.equal(refused.result.applied, false, bad);
    assert.equal(refused.result.listenerAllowed, false, bad);
    assert.match(refused.result.reason, /QM_CLONE_AS_NEW must be exactly 32 hex characters/);
    assert.match(refused.log, /openssl rand -hex 16/);
    assert.equal(refused.devices, 1, 'devices kept');
    assert.equal(sidecarBytes(dataDir), bytes, 'sidecar untouched');
    assert.equal(readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8'), certBefore, 'certificate untouched');
  }
  writeFileSync(join(dataDir, 'qm-mobile-v1.json'), 'not json');
  const corrupt = run(dataDir, `
    const { bootMobileClone } = await import('./src/mobile/clone.js');
    console.log(JSON.stringify(bootMobileClone({ log: (l) => process.stderr.write(l) })));
  `, { QM_CLONE_AS_NEW: NONCE_B });
  assert.equal(corrupt.status, 0, corrupt.stderr);
  const verdict = JSON.parse(corrupt.stdout);
  assert.equal(verdict.listenerAllowed, false);
  assert.match(verdict.reason, /Mobile state is unreadable/);
  assert.equal(readFileSync(join(dataDir, 'qm-mobile-v1.json'), 'utf8'), 'not json');
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close((e) => (e ? reject(e) : resolve(port))); });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
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

async function bootServer(t, dataDir, extra) {
  const port = await freePort();
  const mobilePort = await freePort();
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: projectRoot,
    env: baseEnv(dataDir, { QM_HOST: '127.0.0.1', QM_STACK: join(dataDir, 'stack'), BIND_ADDRESS: '127.0.0.1', PORT: String(port), DOCKER_HOST: 'tcp://127.0.0.1:9', MOBILE_API_ENABLED: 'true', MOBILE_ENROLMENT_ENABLED: 'true', MOBILE_PORT: String(mobilePort), MOBILE_BIND_ADDRESS: '127.0.0.1', QM_ADVERTISED_ORIGIN: `https://127.0.0.1:${mobilePort}`, ...extra }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  t.after(() => { child.kill('SIGTERM'); });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200, child, 'healthz');
  return { port, mobilePort, child, log: () => stdout + stderr };
}

test('invalid QM_CLONE_AS_NEW leaves state unchanged', async (t) => {
  const dataDir = tempDir();
  mkdirSync(join(dataDir, 'stack'), { recursive: true });
  assert.equal(run(dataDir, SEED, { QM_HOST: '127.0.0.1' }).status, 0);
  const bytes = sidecarBytes(dataDir);
  const { port, mobilePort, child, log } = await bootServer(t, dataDir, { QM_CLONE_AS_NEW: 'not-a-nonce' });
  await waitFor(async () => /mobile api: off \(QM_CLONE_AS_NEW must be exactly 32 hex characters/.test(log()), child, 'the refusal line');
  assert.match(log(), /clone-as-new refused/);
  assert.doesNotMatch(log(), /mobile api: https:/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200, '8787 untouched');
  assert.match(log(), /first-run setup token/, 'the panel booted normally');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await portOpen(mobilePort), false, 'the mobile port is closed');
  assert.equal(sidecarBytes(dataDir), bytes, 'no reset happened');
  child.kill('SIGTERM');

  const ok = await bootServer(t, dataDir, { QM_CLONE_AS_NEW: NONCE_A });
  await waitFor(async () => /mobile api: https:\/\/127\.0\.0\.1/.test(ok.log()), ok.child, 'the listener line');
  assert.match(ok.log(), /clone-as-new applied/);
  assert.match(ok.log(), /regenerated the certificate/);
  assert.equal(await portOpen(ok.mobilePort), true, 'the mobile port is open after a valid reset');
  assert.notEqual(sidecarBytes(dataDir), bytes);
});

test('repair output redacts secrets and rejects unreadable state', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, SEED).status, 0);
  const cloned = boot(dataDir, { QM_CLONE_AS_NEW: NONCE_A });
  const cleanBytes = sidecarBytes(dataDir);
  const repairEnv = { MOBILE_API_ENABLED: 'true', MOBILE_ENROLMENT_ENABLED: 'true', MOBILE_PORT: '8788', MOBILE_BIND_ADDRESS: '0.0.0.0' };
  const repair = spawnSync(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: baseEnv(dataDir, repairEnv), encoding: 'utf8' });
  assert.equal(repair.status, 0, repair.stdout + repair.stderr);
  assert.match(repair.stdout, new RegExp(`Mobile installation id:\\s+${cloned.mobileId}`));
  assert.match(repair.stdout, new RegExp(`Identity fingerprint:\\s+${cloned.fingerprint} \\(Ed25519`));
  assert.match(repair.stdout, new RegExp(`TLS leaf fingerprint:\\s+${cloned.certFingerprint}`));
  assert.match(repair.stdout, /TLS source:\s+generated by Companion for 192\.168\.1\.11/);
  assert.match(repair.stdout, /TLS names the origin:\s+yes/);
  assert.match(repair.stdout, new RegExp(`Advertised origin:\\s+${ORIGIN.replace(/\./g, '\\.')}`));
  assert.match(repair.stdout, /Devices:\s+0 \(0 active, 0 revoked\)/);
  assert.match(repair.stdout, /Clone-as-new:\s+a nonce has been consumed on this volume/);
  assert.ok(!repair.stdout.includes(NONCE_A));
  assert.match(repair.stdout, /TLS reset pending:\s+no/);
  assert.doesNotMatch(repair.stdout, /PRIVATE KEY|sealedPrivateKey|[0-9a-f]{24}:[0-9a-f]{32}:/);
  assert.equal(sidecarBytes(dataDir), cleanBytes, 'read-only');

  assert.equal(run(dataDir, CRASH_AFTER_STEP_ONE).status, 0);
  const bytes = sidecarBytes(dataDir);
  const pending = spawnSync(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: { ...baseEnv(dataDir, repairEnv), QM_ADVERTISED_ORIGIN: '' }, encoding: 'utf8' });
  assert.equal(pending.status, 1, pending.stderr);
  assert.match(pending.stdout, /TLS reset pending:\s+yes/);
  assert.match(pending.stdout, /Mobile listener plan:\s+refused/);
  assert.match(pending.stdout, /\[M07\] A clone-as-new TLS reset is unfinished/);
  assert.equal(sidecarBytes(dataDir), bytes);

  const empty = tempDir();
  const none = spawnSync(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: baseEnv(empty, repairEnv), encoding: 'utf8' });
  assert.equal(none.status, 2, none.stderr);
  assert.match(none.stdout, /Mobile state:\s+none yet/);
  assert.match(none.stdout, /TLS certificate:\s+none yet/);
  assert.match(none.stdout, /Status: not provisioned/);
  assert.equal(existsSync(join(empty, 'qm-mobile-v1.json')), false);

  writeFileSync(join(dataDir, 'qm-mobile-v1.json'), '{"version":1,"payload":"{}","mac":"00"}');
  const broken = spawnSync(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: baseEnv(dataDir, repairEnv), encoding: 'utf8' });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /Mobile state error: format is invalid\./);
  assert.match(broken.stdout, /Scope: Owner account, browser and QMC1 are unaffected\./);
  assert.match(broken.stdout, /\[M06\] Mobile state could not be read\./);
});
