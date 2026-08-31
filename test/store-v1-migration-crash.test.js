
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET_KEY = '7a'.repeat(32);
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const V1_STATE = JSON.stringify({
  version: 1,
  installationId: '33333333-3333-4333-8333-333333333333',
  owner: { saltHex: 'aa'.repeat(16), hashHex: 'bb'.repeat(64), createdAt: 1 },
  services: [{ id: 'radarr-1', kind: 'radarr', label: 'Radarr', baseUrl: 'http://nas.local:7878' }],
  prefs: { theme: 'light' },
  apiTokens: [],
  cron: null,
});

const INJECTOR = `
const fs = require('node:fs');
const { join } = require('node:path');

const point = process.env.QM_MIGRATION_FAULT;
const dataDir = process.env.QM_MIGRATION_FAULT_DIR;
const stateFile = join(dataDir, 'qm-companion.json');
const markerFile = join(dataDir, 'qm-companion.v1-migration-used');

const openSync = fs.openSync;
const fsyncSync = fs.fsyncSync;
const renameSync = fs.renameSync;

const tempFds = new Set();
let stateCommitted = false;

function crash() {
  process.kill(process.pid, 'SIGKILL');
}

function eio(what) {
  const error = new Error('injected fault: ' + what);
  error.code = 'EIO';
  throw error;
}

fs.openSync = function patchedOpenSync(path, flags, mode) {
  const target = String(path);
  const isTemp = flags === 'wx';
  if (isTemp && !stateCommitted && point === 'before-write') crash();
  if (isTemp && stateCommitted && point === 'after-commit-before-consume') crash();
  if (target === dataDir && flags === 'r' && stateCommitted && point === 'after-rename-before-dirfsync') crash();
  const fd = openSync.call(fs, path, flags, mode);
  if (isTemp) tempFds.add(fd);
  return fd;
};

fs.fsyncSync = function patchedFsyncSync(fd) {
  if (tempFds.has(fd) && !stateCommitted && point === 'after-write-before-fsync') crash();
  return fsyncSync.call(fs, fd);
};

fs.renameSync = function patchedRenameSync(from, to) {
  const target = String(to);
  if (target === stateFile && point === 'before-rename') crash();
  if (target === stateFile && point === 'state-rename-fails') eio('state rename');
  if (target === markerFile && point === 'marker-rename-fails') eio('marker rename');
  const result = renameSync.call(fs, from, to);
  if (target === stateFile) stateCommitted = true;
  return result;
};
`;

const BOOT = `
  const s = await import('./src/store.js');
  console.log(JSON.stringify({ owner: s.hasOwner(), services: s.listSavedServices().length }));
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qm-migration-crash-'));
  roots.push(root);
  writeFileSync(join(root, 'injector.cjs'), INJECTOR);
  const dataDir = join(root, 'data');
  rmSync(dataDir, { recursive: true, force: true });
  writeFileSync(join(root, 'seed.json'), V1_STATE);
  return { root, dataDir };
}

function seedV1(dataDir) {
  const result = spawnSync('mkdir', ['-p', dataDir], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  writeFileSync(join(dataDir, 'qm-companion.json'), V1_STATE);
}

function boot(root, dataDir, { fault = null } = {}) {
  const preArgs = fault ? ['--require', join(root, 'injector.cjs')] : [];
  return spawnSync(process.execPath, [...preArgs, '--input-type=module', '-e', BOOT], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SECRET_KEY,
      QM_HOST: 'nas.local',
      DATA_DIR: dataDir,
      MIGRATE_V1_STATE: 'true',
      ...(fault ? { QM_MIGRATION_FAULT: fault, QM_MIGRATION_FAULT_DIR: dataDir } : {}),
    },
    encoding: 'utf8',
  });
}

function onDisk(dataDir) {
  const stateFile = join(dataDir, 'qm-companion.json');
  const markerFile = join(dataDir, 'qm-companion.v1-migration-used');
  const bytes = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null;
  let version = null;
  try {
    version = JSON.parse(bytes).version;
  } catch {
    version = null;
  }
  return { bytes, version, marker: existsSync(markerFile) };
}

function assertNeverBricked(dataDir, where) {
  const state = onDisk(dataDir);
  assert.equal(
    state.marker && state.version !== 2,
    false,
    `${where}: the migration permission was consumed with no authenticated v2 state on disk`,
  );
}

const CRASH_POINTS = [
  'before-write',
  'after-write-before-fsync',
  'before-rename',
  'after-rename-before-dirfsync',
  'after-commit-before-consume',
];

for (const point of CRASH_POINTS) {
  test(`recovers from a crash at ${point}`, () => {
    const { root, dataDir } = fixture();
    seedV1(dataDir);

    const crashed = boot(root, dataDir, { fault: point });
    assert.equal(crashed.signal, 'SIGKILL', `the ${point} fault must actually fire`);
    assertNeverBricked(dataDir, point);

    const after = onDisk(dataDir);
    if (after.version === 1) {
      assert.equal(after.bytes, V1_STATE, `${point}: an uncommitted migration must not touch the v1 bytes`);
    } else {
      assert.equal(after.version, 2, `${point}: the state file is either the untouched v1 or a committed v2`);
    }

    const retry = boot(root, dataDir);
    assert.equal(retry.status, 0, `${point}: a restart must recover, got ${retry.stderr}`);
    assert.deepEqual(JSON.parse(retry.stdout), { owner: true, services: 1 });
    assert.equal(onDisk(dataDir).version, 2);
  });
}

test('recovers when a post-rename crash loses the rename', () => {
  const { root, dataDir } = fixture();
  seedV1(dataDir);

  const crashed = boot(root, dataDir, { fault: 'after-rename-before-dirfsync' });
  assert.equal(crashed.signal, 'SIGKILL');
  assert.equal(onDisk(dataDir).marker, false);

  writeFileSync(join(dataDir, 'qm-companion.json'), V1_STATE);
  const retry = boot(root, dataDir);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stdout), { owner: true, services: 1 });
  assert.equal(onDisk(dataDir).version, 2);
  assert.equal(onDisk(dataDir).marker, true, 'the completed retry spends the permission');
});

test('preserves v1 state and permission after commit failure', () => {
  const { root, dataDir } = fixture();
  seedV1(dataDir);

  const failed = boot(root, dataDir, { fault: 'state-rename-fails' });
  assert.notEqual(failed.status, 0);
  assertNeverBricked(dataDir, 'state-rename-fails');
  const after = onDisk(dataDir);
  assert.equal(after.bytes, V1_STATE);
  assert.equal(after.marker, false);

  const retry = boot(root, dataDir);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stdout), { owner: true, services: 1 });
});

test('reports marker failure after a durable commit', () => {
  const { root, dataDir } = fixture();
  seedV1(dataDir);

  const booted = boot(root, dataDir, { fault: 'marker-rename-fails' });
  assert.equal(booted.status, 0, booted.stderr);
  assert.deepEqual(JSON.parse(booted.stdout), { owner: true, services: 1 });
  assert.equal(onDisk(dataDir).version, 2, 'the migrated state is committed');
  assert.equal(onDisk(dataDir).marker, false, 'the marker is the part that failed');
  assert.match(booted.stderr, /migration completed/);
  assert.match(booted.stderr, new RegExp(join(dataDir, 'qm-companion.json').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(booted.stderr, new RegExp(join(dataDir, 'qm-companion.v1-migration-used').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(booted.stderr, /unset MIGRATE_V1_STATE/);
});

test('reports recovery paths for v1 state with a spent marker', () => {
  const { root, dataDir } = fixture();
  seedV1(dataDir);
  assert.equal(boot(root, dataDir).status, 0);
  writeFileSync(join(dataDir, 'qm-companion.json'), V1_STATE);

  const refused = boot(root, dataDir);
  assert.notEqual(refused.status, 0);
  const message = refused.stderr;
  assert.match(message, /v1 migration was already consumed/);
  assert.ok(message.includes(join(dataDir, 'qm-companion.json')), 'names the state file');
  assert.ok(message.includes(join(dataDir, 'qm-companion.v1-migration-used')), 'names the marker file');
  assert.match(message, /Restore the authenticated v2/i, 'exit one: restore the migrated file');
  assert.match(message, /unset MIGRATE_V1_STATE/);
  assert.match(message, /delete .*qm-companion\.v1-migration-used/, 'exit two: delete the marker');
  assert.match(message, /start once with\s+MIGRATE_V1_STATE=true/);

  rmSync(join(dataDir, 'qm-companion.v1-migration-used'));
  const rerun = boot(root, dataDir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(JSON.parse(rerun.stdout), { owner: true, services: 1 });
  assert.equal(onDisk(dataDir).marker, true);
});
