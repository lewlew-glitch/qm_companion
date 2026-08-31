import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { buildSelfSignedCertificate } from '../src/mobile/x509.js';
import { fingerprintOf, tlsPaths } from '../src/mobile/cert.js';

const projectRoot = join(import.meta.dirname, '..');
const SECRET_KEY = 'ab'.repeat(32);
const HOST = '192.168.1.20';
const PORT = 8788;
const ORIGIN = `https://${HOST}:${PORT}`;
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-repair-'));
  roots.push(root);
  return root;
}

function env(dataDir, extra = {}) {
  const base = {
    ...process.env,
    SECRET_KEY,
    DATA_DIR: dataDir,
    QM_HOST: HOST,
    QM_ADVERTISED_ORIGIN: ORIGIN,
    MOBILE_API_ENABLED: 'true',
    MOBILE_ENROLMENT_ENABLED: 'true',
    MOBILE_PORT: String(PORT),
    MOBILE_BIND_ADDRESS: '0.0.0.0',
    ...extra,
  };
  delete base.QM_CLONE_AS_NEW;
  return base;
}

const repair = (dataDir, extra = {}) =>
  spawnSync(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: env(dataDir, extra), encoding: 'utf8' });

/** Provision the sidecar and generated certificate. */
function provision(dataDir) {
  const seed = `
    process.env.DATA_DIR = ${JSON.stringify(dataDir)};
    const { loadMobileState } = await import('${join(projectRoot, 'src/mobile/store.js').replace(/\\/g, '/')}');
    const { ensureMobileCertificate } = await import('${join(projectRoot, 'src/mobile/cert.js').replace(/\\/g, '/')}');
    loadMobileState();
    const made = ensureMobileCertificate({ dataDir: ${JSON.stringify(dataDir)}, host: ${JSON.stringify(HOST)} });
    if (!made.ok) throw new Error(made.reason);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', seed], { cwd: projectRoot, env: env(dataDir), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return tlsPaths(dataDir);
}

/** Run module source against the test data directory. */
function inState(dataDir, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: projectRoot, env: env(dataDir), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const NO_SECRETS = /-----BEGIN[^\n]*PRIVATE KEY|sealedPrivateKey|qmd_|qmr_|qmp_|[0-9a-f]{24}:[0-9a-f]{32}:/;

test('returns exit 0 for a fully provisioned volume', () => {
  const dataDir = tempDir();
  provision(dataDir);
  const ok = repair(dataDir);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /TLS key matches cert:\s+yes/);
  assert.match(ok.stdout, /TLS context loads:\s+yes/);
  assert.match(ok.stdout, /TLS names the origin:\s+yes/);
  assert.match(ok.stdout, /Mobile listener plan:\s+would start/);
  assert.match(ok.stdout, new RegExp(`Listen address:\\s+0\\.0\\.0\\.0:${PORT}`));
  assert.match(ok.stdout, /Status: ready; the mobile listener would start/);
  assert.doesNotMatch(ok.stdout, NO_SECRETS);
});

test('returns exit 2 for an unprovisioned volume', () => {
  const empty = tempDir();
  const none = repair(empty);
  assert.equal(none.status, 2, none.stdout);
  assert.match(none.stdout, /Status: not provisioned/);
});

const materialCases = [
  {
    name: 'missing private key',
    reason: /the private key mobile\.key is missing/i,
    break: (paths) => rmSync(paths.keyPath),
  },
  {
    name: 'unreadable private key',
    reason: /mobile\.key could not be read/,
    break: (paths) => {
      rmSync(paths.keyPath);
      mkdirSync(paths.keyPath);
    },
  },
  {
    name: 'mismatched private key',
    reason: /mobile\.key does not match mobile\.crt/,
    break: (paths) => writeFileSync(paths.keyPath, buildSelfSignedCertificate({ host: HOST }).keyPem, { mode: 0o600 }),
  },
  {
    name: 'malformed certificate',
    reason: /not a readable X\.509 certificate/,
    break: (paths) => writeFileSync(paths.certPath, 'this is not a certificate\n'),
  },
  {
    name: 'expired certificate',
    reason: /the certificate expired on/i,
    break: (paths) => {
      const built = buildSelfSignedCertificate({ host: HOST, days: 1, now: new Date(Date.now() - 400 * 86_400_000) });
      writeFileSync(paths.certPath, built.certPem);
      writeFileSync(paths.keyPath, built.keyPem, { mode: 0o600 });
    },
  },
  {
    name: 'not-yet-valid certificate',
    reason: /the certificate is not valid until/i,
    break: (paths) => {
      const built = buildSelfSignedCertificate({ host: HOST, days: 10, now: new Date(Date.now() + 400 * 86_400_000) });
      writeFileSync(paths.certPath, built.certPem);
      writeFileSync(paths.keyPath, built.keyPem, { mode: 0o600 });
    },
  },
  {
    name: 'SAN mismatch',
    reason: /does not name the advertised host in its SAN/i,
    break: (paths) => {
      const built = buildSelfSignedCertificate({ host: '192.168.1.21' });
      writeFileSync(paths.certPath, built.certPem);
      writeFileSync(paths.keyPath, built.keyPem, { mode: 0o600 });
    },
  },
  {
    name: 'material createServer would refuse',
    reason: /the HTTPS server would refuse this TLS material/i,
    break: (paths) => {
      const chain = `${readFileSync(paths.certPath, 'utf8')}-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n`;
      writeFileSync(paths.certPath, chain);
    },
  },
];

for (const c of materialCases) {
  test(`exits non-zero for ${c.name}`, () => {
    const dataDir = tempDir();
    const paths = provision(dataDir);
    c.break(paths);
    const result = repair(dataDir);
    assert.equal(result.status, 1, `${c.name}: ${result.stdout}`);
    assert.match(result.stdout, /Status: blocked by/);
    assert.match(result.stdout, /\[T\d{2}\]/);
    assert.match(result.stdout, c.reason);
    assert.doesNotMatch(result.stdout, NO_SECRETS);
  });
}

const planCases = [
  { name: 'the parent flag is off', env: { MOBILE_API_ENABLED: 'false' }, reason: /MOBILE_API_ENABLED is not true/ },
  { name: 'the parent flag is absent', env: { MOBILE_API_ENABLED: '' }, reason: /MOBILE_API_ENABLED is not true/ },
  { name: 'the advertised port disagrees with MOBILE_PORT', env: { MOBILE_PORT: '9999' }, reason: /does not match the listener port 9999/ },
  { name: 'an out-of-range listener port', env: { MOBILE_PORT: '70000' }, reason: /MOBILE_PORT is out of range/ },
  { name: 'a non-numeric listener port', env: { MOBILE_PORT: 'eight' }, reason: /MOBILE_PORT must be an integer/ },
  { name: 'an invalid bind address', env: { MOBILE_BIND_ADDRESS: 'nas.local' }, reason: /MOBILE_BIND_ADDRESS must be an IP address/ },
  { name: 'a junk bind address', env: { MOBILE_BIND_ADDRESS: 'not-an-ip' }, reason: /MOBILE_BIND_ADDRESS must be an IP address/ },
  { name: 'an invalid advertised origin', env: { QM_ADVERTISED_ORIGIN: 'http://nas.local:8788' }, reason: /exact https origin/ },
  { name: 'an unset advertised origin', env: { QM_ADVERTISED_ORIGIN: '' }, reason: /is not set/ },
  { name: 'a wildcard advertised origin (IPv4)', env: { QM_ADVERTISED_ORIGIN: 'https://0.0.0.0:8788' }, reason: /unspecified \(wildcard\) address/ },
  { name: 'a wildcard advertised origin (IPv6)', env: { QM_ADVERTISED_ORIGIN: 'https://[::]:8788' }, reason: /unspecified \(wildcard\) address/ },
  { name: 'a multicast advertised origin', env: { QM_ADVERTISED_ORIGIN: 'https://224.0.0.1:8788' }, reason: /multicast address/ },
];

for (const c of planCases) {
  test(`exits non-zero when ${c.name}`, () => {
    const dataDir = tempDir();
    provision(dataDir);
    const result = repair(dataDir, c.env);
    assert.equal(result.status, 1, `${c.name}: ${result.stdout}`);
    assert.match(result.stdout, /Mobile listener plan:\s+refused/);
    assert.match(result.stdout, c.reason);
    assert.match(result.stdout, /\[C01\] Listener configuration was refused/);
    assert.doesNotMatch(result.stdout, /Status: ready/);
  });
}

test('validates the same listener plan used during boot', () => {
  const dataDir = tempDir();
  provision(dataDir);
  const result = repair(dataDir, { MOBILE_PORT: '9999' });
  const spawned = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "const { mobileListenerPlan } = await import('./src/mobile/config.js'); const p = mobileListenerPlan(); console.log(p.ok ? 'OK' : p.reason);"],
    { cwd: projectRoot, env: env(dataDir, { MOBILE_PORT: '9999' }), encoding: 'utf8' },
  );
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.ok(result.stdout.includes(spawned.stdout.trim()), 'repair prints the plan\u2019s own reason verbatim');
});

test('exits non-zero for a pending TLS reset', () => {
  const dataDir = tempDir();
  provision(dataDir);
  inState(dataDir, `
    const { updateMobileState } = await import('${join(projectRoot, 'src/mobile/store.js').replace(/\\/g, '/')}');
    updateMobileState((state) => { state.tlsResetPending = true; });
  `);
  const result = repair(dataDir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /TLS reset pending:\s+yes/);
  assert.match(result.stdout, /\[M07\] A clone-as-new TLS reset is unfinished/);
});

test('exits non-zero for an interrupted certificate write', () => {
  const dataDir = tempDir();
  const paths = provision(dataDir);
  mkdirSync(paths.pendingDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.pendingKeyPath, 'half a write', { mode: 0o600 });
  const before = readFileSync(paths.certPath, 'utf8');
  const result = repair(dataDir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /TLS write pending:\s+yes; an interrupted certificate write/);
  assert.match(result.stdout, /an interrupted certificate write is staged/);
  assert.equal(readFileSync(paths.certPath, 'utf8'), before);
  assert.equal(readFileSync(paths.pendingKeyPath, 'utf8'), 'half a write');
});

test('exits non-zero for a pending certificate installation', () => {
  const dataDir = tempDir();
  const paths = provision(dataDir);
  const built = buildSelfSignedCertificate({ host: HOST });
  mkdirSync(paths.pendingDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.pendingKeyPath, built.keyPem, { mode: 0o600 });
  writeFileSync(paths.pendingCertPath, built.certPem, { mode: 0o644 });
  writeFileSync(
    paths.pendingRecordPath,
    `${JSON.stringify({ generated: true, host: HOST, sanKind: 'ip', createdAt: new Date().toISOString(), notAfter: built.notAfter.toISOString(), fingerprint: fingerprintOf(built.certPem) })}\n`,
    { mode: 0o600 },
  );
  const result = repair(dataDir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /\[T03\] A committed certificate generation is awaiting installation/);
});

test('redacts unreadable mobile state', () => {
  const dataDir = tempDir();
  provision(dataDir);
  writeFileSync(join(dataDir, 'qm-mobile-v1.json'), '{"version":1,"payload":"{}","mac":"00"}');
  const result = repair(dataDir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Mobile state error: format is invalid\./);
  assert.match(result.stdout, /\[M06\] Mobile state could not be read\./);
  assert.doesNotMatch(result.stdout, NO_SECRETS);
});

test('redacts the consumed clone nonce', () => {
  const dataDir = tempDir();
  provision(dataDir);
  const nonce = 'b4'.repeat(16);
  inState(dataDir, `
    const { updateMobileState } = await import('${join(projectRoot, 'src/mobile/store.js').replace(/\\/g, '/')}');
    updateMobileState((state) => { state.consumedCloneNonce = ${JSON.stringify('__NONCE__')}; });
  `.replace('__NONCE__', nonce));
  const result = repair(dataDir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Clone-as-new:\s+a nonce has been consumed on this volume/);
  assert.ok(!result.stdout.includes(nonce));
});
