import test from 'node:test';
import { spawn } from 'node:child_process';

let holderPid;
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import {
  __setCertificateFault,
  checkMaterial,
  describeMobileCertificate,
  ensureMobileCertificate,
  fingerprintOf,
  LOCK_TIMEOUT_MS,
  recoverPendingMaterial,
  rotateMobileCertificate,
  tlsPaths,
} from '../src/mobile/cert.js';

const HOST = '192.168.1.20';
const roots = [];
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-cert-txn-'));
  roots.push(root);
  return root;
};
test.after(() => {
  __setCertificateFault(null);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PREPARE_CUTS = ['prepare-key', 'prepare-cert', 'prepare-record'];
const COMMITTED_CUTS = ['prepare-fsync', 'install-key', 'install-cert', 'install-record', 'install-fsync', 'install-cleanup'];

function generate(dataDir, host = HOST) {
  return ensureMobileCertificate({ dataDir, host });
}

function live(dataDir) {
  const paths = tlsPaths(dataDir);
  return {
    paths,
    hasKey: existsSync(paths.keyPath),
    hasCert: existsSync(paths.certPath),
    hasRecord: existsSync(paths.recordPath),
    fingerprint: existsSync(paths.certPath) ? fingerprintOf(readFileSync(paths.certPath)) : null,
    record: existsSync(paths.recordPath) ? JSON.parse(readFileSync(paths.recordPath, 'utf8')) : null,
  };
}

function assertPermissions(dataDir) {
  const paths = tlsPaths(dataDir);
  assert.equal(statSync(paths.dir).mode & 0o777, 0o700, 'tls dir stays 0700');
  assert.equal(statSync(paths.keyPath).mode & 0o777, 0o600, 'key stays 0600');
  assert.equal(statSync(paths.recordPath).mode & 0o777, 0o600, 'record stays 0600');
  if (existsSync(paths.pendingDir)) assert.equal(statSync(paths.pendingDir).mode & 0o777, 0o700, 'pending dir is 0700');
}

test('pre-commit generation failure leaves no partial files', () => {
  for (const point of PREPARE_CUTS) {
    const dataDir = fresh();
    __setCertificateFault(point);
    const crashed = generate(dataDir);
    assert.equal(crashed.ok, false, point);
    const after = live(dataDir);
    assert.equal(after.hasCert, false, `${point}: no live certificate`);
    assert.equal(after.hasKey, false, `${point}: no live key`);
    const retry = generate(dataDir);
    assert.equal(retry.ok, true, `${point}: ${retry.reason || ''}`);
    assert.equal(retry.source, 'generated');
    assert.equal(existsSync(tlsPaths(dataDir).pendingDir), false, `${point}: staging cleared`);
    assertPermissions(dataDir);
  }
});

test('restart completes interrupted initial generation', () => {
  for (const point of COMMITTED_CUTS) {
    const dataDir = fresh();
    __setCertificateFault(point);
    const crashed = generate(dataDir);
    assert.equal(crashed.ok, false, point);
    const paths = tlsPaths(dataDir);
    assert.equal(existsSync(paths.pendingDir), true, `${point}: the committed generation is still staged`);
    const staged = fingerprintOf(readFileSync(paths.pendingCertPath));
    const retry = generate(dataDir);
    assert.equal(retry.ok, true, `${point}: ${retry.reason || ''}`);
    assert.equal(retry.source, 'generated', `${point}: remains classified as generated`);
    assert.equal(retry.fingerprint, staged, `${point}: the committed generation is installed`);
    const after = live(dataDir);
    assert.equal(after.fingerprint, staged);
    assert.equal(after.record.fingerprint, staged, `${point}: the record describes the pair`);
    assert.equal(existsSync(paths.pendingDir), false, `${point}: staging removed`);
    assertPermissions(dataDir);
    const again = generate(dataDir);
    assert.equal(again.ok, true);
    assert.equal(again.fingerprint, staged);
    assert.equal(again.created, false);
  }
});

test('rotation serves the old certificate until commit', () => {
  for (const point of PREPARE_CUTS) {
    const dataDir = fresh();
    const first = generate(dataDir);
    assert.equal(first.ok, true);
    const original = first.fingerprint;
    __setCertificateFault(point);
    const rotated = rotateMobileCertificate({ dataDir, host: HOST });
    assert.equal(rotated.ok, false, point);
    const after = live(dataDir);
    assert.equal(after.fingerprint, original, `${point}: old leaf intact`);
    assert.equal(after.record.fingerprint, original, `${point}: old record intact`);
    const usable = generate(dataDir);
    assert.equal(usable.ok, true, `${point}: ${usable.reason || ''}`);
    assert.equal(usable.fingerprint, original, `${point}: the listener still presents the old leaf`);
    assert.equal(usable.source, 'generated');
    assertPermissions(dataDir);
  }
});

test('post-commit rotation failure installs the new generation on restart', () => {
  for (const point of COMMITTED_CUTS) {
    const dataDir = fresh();
    const first = generate(dataDir);
    const original = first.fingerprint;
    __setCertificateFault(point);
    const rotated = rotateMobileCertificate({ dataDir, host: HOST });
    assert.equal(rotated.ok, false, point);
    const paths = tlsPaths(dataDir);
    const staged = fingerprintOf(readFileSync(paths.pendingCertPath));
    assert.notEqual(staged, original, `${point}: rotation staged a different certificate`);
    const settled = generate(dataDir);
    assert.equal(settled.ok, true, `${point}: ${settled.reason || ''}`);
    assert.equal(settled.fingerprint, staged, `${point}: restart installs the committed rotation`);
    assert.equal(settled.source, 'generated');
    const restart = generate(dataDir);
    assert.equal(restart.fingerprint, staged);
    const again = rotateMobileCertificate({ dataDir, host: HOST });
    assert.equal(again.ok, true, `${point}: rotation is not permanently refused`);
    assertPermissions(dataDir);
  }
});

test('staged-set recovery fails closed', () => {
  const dataDir = fresh();
  generate(dataDir);
  const paths = tlsPaths(dataDir);
  mkdirSync(paths.pendingDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.pendingKeyPath, readFileSync(paths.keyPath), { mode: 0o600 });
  writeFileSync(paths.pendingCertPath, readFileSync(paths.certPath), { mode: 0o644 });
  writeFileSync(paths.pendingRecordPath, JSON.stringify({ generated: true, fingerprint: 'ff'.repeat(32) }), { mode: 0o600 });
  const first = recoverPendingMaterial(dataDir);
  assert.equal(first.ok, true);
  assert.equal(first.outcome, 'discarded');
  assert.equal(existsSync(paths.pendingDir), false);

  mkdirSync(paths.pendingDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.pendingKeyPath, readFileSync(paths.keyPath), { mode: 0o600 });
  writeFileSync(paths.pendingCertPath, 'not a certificate', { mode: 0o644 });
  writeFileSync(paths.pendingRecordPath, '{}', { mode: 0o600 });
  assert.equal(recoverPendingMaterial(dataDir).outcome, 'discarded');
  assert.equal(existsSync(paths.pendingDir), false);

  const idle = recoverPendingMaterial(dataDir);
  assert.equal(idle.ok, true);
  assert.equal(idle.outcome, 'none');
  assert.equal(new X509Certificate(readFileSync(paths.certPath)).subject.length > 0, true);
});

test('wildcard hosts cannot receive certificates', () => {
  for (const host of ['0.0.0.0', '[::]', '224.0.0.1', '255.255.255.255']) {
    const dataDir = fresh();
    const made = ensureMobileCertificate({ dataDir, host });
    assert.equal(made.ok, false, host);
    assert.equal(made.code, 'host_unusable', host);
    assert.equal(existsSync(tlsPaths(dataDir).certPath), false, `${host}: nothing was written`);
    const rotated = rotateMobileCertificate({ dataDir, host });
    assert.equal(rotated.ok, false, host);
    assert.equal(rotated.code, 'host_unusable', host);
  }
});


import { spawnSync } from 'node:child_process';

const projectRoot = join(import.meta.dirname, '..');
const SECRET_KEY = 'cd'.repeat(32);
const CLONE_HOST = '192.168.1.11';
const CLONE_ORIGIN = `https://${CLONE_HOST}:8788`;

function cloneEnv(dataDir, extra = {}) {
  const env = { ...process.env, SECRET_KEY, DATA_DIR: dataDir, QM_HOST: CLONE_HOST, QM_ADVERTISED_ORIGIN: CLONE_ORIGIN, ...extra };
  delete env.QM_CLONE_AS_NEW;
  return { ...env, ...extra };
}

function inProcess(dataDir, source, extra = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectRoot,
    env: cloneEnv(dataDir, extra),
    encoding: 'utf8',
  });
}

const CLONE_SOURCE = `
  const { bootMobileClone } = await import('./src/mobile/clone.js');
  const { describeMobileCertificate } = await import('./src/mobile/cert.js');
  const { loadMobileState } = await import('./src/mobile/store.js');
  const result = bootMobileClone({ log: () => {} });
  const found = describeMobileCertificate(process.env.DATA_DIR);
  const state = loadMobileState();
  console.log(JSON.stringify({
    ok: result.ok,
    applied: result.applied,
    outcome: result.tls?.outcome ?? null,
    listenerAllowed: result.listenerAllowed,
    reason: result.reason ?? null,
    fingerprint: found.fingerprint,
    source: found.source,
    pending: found.pending,
    tlsResetPending: state.tlsResetPending,
    identity: state.identity.fingerprint,
    installation: state.mobileInstallationId,
  }));
`;

const SEED_SOURCE = `
  const { ensureMobileCertificate } = await import('./src/mobile/cert.js');
  const { loadMobileState } = await import('./src/mobile/store.js');
  const made = ensureMobileCertificate({ dataDir: process.env.DATA_DIR, host: ${JSON.stringify(CLONE_HOST)} });
  if (!made.ok) throw new Error(made.reason);
  const state = loadMobileState();
  console.log(JSON.stringify({ fingerprint: made.fingerprint, identity: state.identity.fingerprint, installation: state.mobileInstallationId }));
`;

function clone(dataDir, nonce) {
  const out = inProcess(dataDir, CLONE_SOURCE, { QM_CLONE_AS_NEW: nonce });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

function seed(dataDir) {
  const out = inProcess(dataDir, SEED_SOURCE);
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

const NONCE = 'a7'.repeat(16);

test('clone resets certificate, identity, and installation id', () => {
  const dataDir = fresh();
  const before = seed(dataDir);
  const after = clone(dataDir, NONCE);
  assert.equal(after.applied, true);
  assert.equal(after.ok, true);
  assert.equal(after.listenerAllowed, true);
  assert.equal(after.tlsResetPending, false);
  assert.equal(after.outcome, 'regenerated');
  assert.equal(after.source, 'generated');
  assert.equal(after.pending, 'none');
  assert.notEqual(after.fingerprint, before.fingerprint, 'certificate changed');
  assert.notEqual(after.identity, before.identity, 'signing identity changed');
  assert.notEqual(after.installation, before.installation, 'installation id changed');
  assert.match(after.fingerprint, /^[0-9a-f]{64}$/);
});

test('clone after install-record interruption creates a new leaf', () => {
  const dataDir = fresh();
  const before = seed(dataDir);
  __setCertificateFault('install-record');
  const interrupted = rotateMobileCertificate({ dataDir, host: CLONE_HOST });
  assert.equal(interrupted.ok, false);
  const staged = fingerprintOf(readFileSync(tlsPaths(dataDir).pendingCertPath));
  assert.notEqual(staged, before.fingerprint);

  const after = clone(dataDir, NONCE);
  assert.equal(after.applied, true);
  assert.equal(after.outcome, 'regenerated');
  assert.equal(after.source, 'generated');
  assert.equal(after.pending, 'none');
  assert.equal(after.tlsResetPending, false);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.notEqual(after.fingerprint, staged, 'the new leaf is not the settled pending leaf');
  assert.notEqual(after.identity, before.identity);
});

test('serialises concurrent certificate rotations', () => {
  const dataDir = fresh();
  seed(dataDir);
  const ROTATE = `
    const { rotateMobileCertificate, describeMobileCertificate } = await import('./src/mobile/cert.js');
    const result = rotateMobileCertificate({ dataDir: process.env.DATA_DIR, host: ${JSON.stringify(CLONE_HOST)} });
    const found = describeMobileCertificate(process.env.DATA_DIR);
    console.log(JSON.stringify({ ok: result.ok, code: result.code ?? null, reported: result.fingerprint ?? null, onDisk: found.fingerprint, source: found.source, pending: found.pending }));
  `;
  const runs = [];
  for (let i = 0; i < 6; i += 1) {
    const out = inProcess(dataDir, ROTATE);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, '', 'no process crashed on ENOENT or ENOTEMPTY');
    runs.push(JSON.parse(out.stdout));
  }
  const paths = tlsPaths(dataDir);
  const finalPrint = fingerprintOf(readFileSync(paths.certPath));
  const record = JSON.parse(readFileSync(paths.recordPath, 'utf8'));
  assert.equal(record.fingerprint, finalPrint, 'no split generation');
  assert.equal(existsSync(paths.pendingDir), false, 'no staging left behind');
  checkMaterial(readFileSync(paths.certPath), readFileSync(paths.keyPath));
  for (const run of runs) {
    assert.equal(run.source, 'generated');
    assert.equal(run.pending, 'none');
    if (run.ok) {
      assert.match(run.reported, /^[0-9a-f]{64}$/);
      assert.equal(run.reported, run.onDisk, 'reported fingerprint matches the installed certificate');
    } else {
      assert.ok(['locked', 'generate'].includes(run.code), `expected refusal code, got ${run.code}`);
    }
  }
  assert.ok(runs.some((r) => r.ok), 'at least one rotation succeeded');
});

test('certificate lock handles live and abandoned holders', () => {
  const dataDir = fresh();
  seed(dataDir);
  const paths = tlsPaths(dataDir);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });

  writeFileSync(paths.lockPath, JSON.stringify({ pid: 0x7fffffff, at: Date.now() }), { mode: 0o600 });
  const broke = rotateMobileCertificate({ dataDir, host: CLONE_HOST });
  assert.equal(broke.ok, true, broke.reason);
  assert.equal(existsSync(paths.lockPath), false, 'the lock is released on the way out');

  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  holderPid = holder.pid;
  writeFileSync(paths.lockPath, JSON.stringify({ pid: holder.pid, at: Date.now() }), { mode: 0o600 });
  const before = fingerprintOf(readFileSync(paths.certPath));
  const started = Date.now();
  const refused = rotateMobileCertificate({ dataDir, host: CLONE_HOST });
  const waited = Date.now() - started;
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'locked');
  assert.match(refused.reason, /holding the TLS lock/);
  assert.ok(waited >= 1000, `acquisition is bounded but real, waited ${waited}ms`);
  assert.ok(waited <= LOCK_TIMEOUT_MS * 6, `and it does not wait for ever, waited ${waited}ms`);
  assert.equal(fingerprintOf(readFileSync(paths.certPath)), before);
  const described = describeMobileCertificate(dataDir);
  assert.equal(described.pending, 'unknown');
  assert.equal(described.locked, 'QM_CERT_LOCK_TIMEOUT');
  holder.kill('SIGKILL');
  holderPid = undefined;
  rmSync(paths.lockPath, { force: true });
});

test.after(() => {
  if (holderPid) {
    try { process.kill(holderPid, 'SIGKILL'); } catch {  }
  }
});
