
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tlsPaths } from '../src/mobile/cert.js';

const projectRoot = join(import.meta.dirname, '..');
const SECRET_KEY = 'ab'.repeat(32);
const HOST = '192.168.1.11';
const PORT = 8788;
const roots = [];

test.after(() => {
  for (const root of roots) {
    spawnSync('chflags', ['-R', 'nouchg', root]);
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-repair-write-'));
  roots.push(root);
  return root;
}

function env(dataDir, extra = {}) {
  const inherited = { ...process.env };
  for (const name of ['QM_CLONE_AS_NEW', 'DOCKER_CONTROL', 'DOCKER_ACCESS_MAX', 'MIGRATE_V1_STATE']) delete inherited[name];
  return {
    ...inherited,
    SECRET_KEY,
    DATA_DIR: dataDir,
    QM_HOST: HOST,
    QM_ADVERTISED_ORIGIN: `https://${HOST}:${PORT}`,
    MOBILE_API_ENABLED: 'true',
    MOBILE_ENROLMENT_ENABLED: 'true',
    MOBILE_PORT: String(PORT),
    MOBILE_BIND_ADDRESS: '0.0.0.0',
    ...extra,
  };
}

const url = (relative) => join(projectRoot, relative).replace(/\\/g, '/');

/** Provision a volume through the production writers. */
function provision(dataDir) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { loadMobileState } = await import('${url('src/mobile/store.js')}');
    const { setDockerAccessMode } = await import('${url('src/docker-access.js')}');
    const { ensureMobileCertificate } = await import('${url('src/mobile/cert.js')}');
    loadMobileState();
    const saved = setDockerAccessMode('read');
    if (!saved.ok) throw new Error(saved.error);
    const made = ensureMobileCertificate({ dataDir: ${JSON.stringify(dataDir)}, host: ${JSON.stringify(HOST)} });
    if (!made.ok) throw new Error(made.reason);
  `], { cwd: projectRoot, env: env(dataDir), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function makePlaintextCron(dataDir) {
  const file = join(dataDir, 'qm-companion.json');
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  const payload = JSON.parse(envelope.payload);
  assert.ok('cron' in payload, 'the real writer always emits a cron section');
  payload.cron = [{
    id: 'prune-images',
    name: 'Prune dangling images',
    action: 'images',
    schedule: { type: 'weekly', day: 0, hour: 3, minute: 0 },
    enabled: false,
  }];
  const text = JSON.stringify(payload);
  const stateKey = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET_KEY, 'hex'), Buffer.alloc(0), 'qm-companion:state', 32));
  const mac = createHmac('sha256', stateKey).update('qm-companion:state:v2\0').update(text, 'utf8').digest('hex');
  writeFileSync(file, `${JSON.stringify({ version: 2, payload: text, mac }, null, 2)}\n`);
  return file;
}

function loaderRewritesIt(dataDir) {
  const file = join(dataDir, 'qm-companion.json');
  const before = readFileSync(file, 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { getInstallationId } = await import('${url('src/store.js')}');
    getInstallationId();
  `], { cwd: projectRoot, env: env(dataDir), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(file, 'utf8') !== before;
}

const repairSync = (dataDir, extra = {}) =>
  spawnSync(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: env(dataDir, extra), encoding: 'utf8' });

function snapshot(root) {
  const rows = new Map();
  const walk = (relative) => {
    const absolute = relative === '' ? root : join(root, relative);
    const stat = lstatSync(absolute);
    const kind = stat.isDirectory() ? 'dir'
      : stat.isSymbolicLink() ? 'link'
        : stat.isFIFO() ? 'fifo'
          : stat.isFile() ? 'file' : 'other';
    const hash = kind === 'file' ? createHash('sha256').update(readFileSync(absolute)).digest('hex') : '-';
    rows.set(relative === '' ? '.' : relative, [
      kind,
      (stat.mode & 0o7777).toString(8),
      stat.mtimeMs.toFixed(3),
      kind === 'file' ? String(stat.size) : '-',
      hash,
    ].join(' '));
    if (kind === 'dir') {
      for (const name of readdirSync(absolute).sort()) walk(relative === '' ? name : join(relative, name));
    }
  };
  walk('');
  return rows;
}

function changes(before, after) {
  const lines = [];
  for (const [path, value] of before) {
    if (!after.has(path)) lines.push(`REMOVED ${path}`);
    else if (after.get(path) !== value) lines.push(`CHANGED ${path}: ${value} -> ${after.get(path)}`);
  }
  for (const path of after.keys()) if (!before.has(path)) lines.push(`CREATED ${path}`);
  return lines;
}

const unchanged = (before, after, what) => assert.deepEqual(changes(before, after), [], `${what} changed the volume`);

test('diagnoses a healthy volume without filesystem writes', () => {
  const dataDir = tempDir();
  provision(dataDir);
  const before = snapshot(dataDir);
  const result = repairSync(dataDir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Status: ready; the mobile listener would start/);
  unchanged(before, snapshot(dataDir), 'a green run');
  assert.equal(existsSync(tlsPaths(dataDir).lockPath), false, 'no certificate lock is left behind');
});

test('does not provision a volume without TLS material', () => {
  const dataDir = tempDir();
  const before = snapshot(dataDir);
  const result = repairSync(dataDir);
  assert.equal(result.status, 2, result.stdout);
  unchanged(before, snapshot(dataDir), 'an unprovisioned run');
});

test('reports plaintext cron state without resealing it', () => {
  const dataDir = tempDir();
  provision(dataDir);
  makePlaintextCron(dataDir);
  const before = snapshot(dataDir);
  const result = repairSync(dataDir);

  assert.equal(result.status, 1, result.stdout);
  unchanged(before, snapshot(dataDir), 'a run against a legacy plaintext cron file');
  assert.match(result.stdout, /Companion state:\s+authenticated; not opened because loading would rewrite legacy plaintext cron data/);
  assert.match(result.stdout, /Action: Start Companion once to seal cron data, then rerun this check/);
  assert.match(result.stdout, /No data or phone pairings are removed/);
  assert.doesNotMatch(result.stdout, /was rewritten while this diagnosis ran/);
  assert.doesNotMatch(result.stdout, /Diagnosis: SECRET_KEY mismatch/);
  assert.match(result.stdout, /Mobile state:\s+present; not opened/);
  assert.match(result.stdout, /the mobile sidecar has not been read and is not identified as faulty/);
  assert.doesNotMatch(result.stdout, /Status: ready/);
});

test('confirms normal loading rewrites plaintext cron state', () => {
  const dataDir = tempDir();
  provision(dataDir);
  makePlaintextCron(dataDir);
  assert.equal(loaderRewritesIt(dataDir), true);
});

test('classifies wrong-key state before plaintext cron state', () => {
  const dataDir = tempDir();
  provision(dataDir);
  makePlaintextCron(dataDir);
  const before = snapshot(dataDir);
  const result = repairSync(dataDir, { SECRET_KEY: 'cd'.repeat(32) });
  assert.equal(result.status, 1, result.stdout);
  unchanged(before, snapshot(dataDir), 'a wrong-key run');
  assert.match(result.stdout, /Companion state:\s+present; authentication failed for this SECRET_KEY/);
  assert.match(result.stdout, /Diagnosis: SECRET_KEY mismatch/);
});

function makeImmutable(dataDir) {
  const flagged = spawnSync('chflags', ['uchg', dataDir]);
  if (flagged.error || flagged.status !== 0) return 'chflags is unavailable, so a read-only directory cannot be reproduced in this environment';
  const probe = join(dataDir, '.write-probe');
  try {
    writeFileSync(probe, 'x');
    unlinkSync(probe);
  } catch {
    return null;
  }
  spawnSync('chflags', ['nouchg', dataDir]);
  return 'chflags uchg did not make this directory read-only on this filesystem';
}

test('diagnoses a read-only volume', (t) => {
  const dataDir = tempDir();
  provision(dataDir);
  const skip = makeImmutable(dataDir);
  if (skip) {
    t.skip(skip);
    return;
  }
  try {
    const before = snapshot(dataDir);
    const result = repairSync(dataDir);
    assert.doesNotMatch(result.stdout, /holding the lock|lock file is present/, 'a read-only mount is not lock contention');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Status: ready; the mobile listener would start/);
    assert.match(result.stdout, /TLS context loads:\s+yes/);
    unchanged(before, snapshot(dataDir), 'a run against a read-only volume');
  } finally {
    spawnSync('chflags', ['nouchg', dataDir]);
  }
});

/** Run the command and terminate it with SIGKILL. */
function killedRun(dataDir, killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: env(dataDir), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('leaves the volume unchanged after SIGKILL', async () => {
  const healthy = tempDir();
  provision(healthy);
  const pending = tempDir();
  provision(pending);
  makePlaintextCron(pending);

  for (const dataDir of [healthy, pending]) {
    const before = snapshot(dataDir);
    for (let killAfterMs = 0; killAfterMs <= 240; killAfterMs += 10) {
      await killedRun(dataDir, killAfterMs);
      unchanged(before, snapshot(dataDir), `a SIGKILL ${killAfterMs}ms into the run`);
    }
  }
});

test('leaves no files when killed during certificate reads', async (t) => {
  const dataDir = tempDir();
  provision(dataDir);
  const paths = tlsPaths(dataDir);
  rmSync(paths.certPath);
  const made = spawnSync('mkfifo', [paths.certPath]);
  if (made.error || made.status !== 0) {
    t.skip('mkfifo is unavailable, so the certificate read cannot be held open');
    return;
  }
  const before = snapshot(dataDir);
  await new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: env(dataDir), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    setTimeout(() => {
      assert.equal(child.exitCode, null);
      child.kill('SIGKILL');
    }, 700);
    child.on('close', resolve);
  });
  assert.equal(existsSync(paths.lockPath), false, 'a killed run leaves no certificate lock behind');
  unchanged(before, snapshot(dataDir), 'a SIGKILL during the certificate read');
});
