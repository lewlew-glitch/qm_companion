import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
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

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-docker-access-'));
  roots.push(root);
  return root;
}

function run(dataDir, source, extra = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SECRET_KEY,
      DATA_DIR: dataDir,
      QM_HOST: 'nas.local',
      ...extra,
    },
    encoding: 'utf8',
  });
}

const READ = `
  const a = await import('./src/docker-access.js');
  console.log(JSON.stringify(a.dockerAccessState()));
`;

const SET = (mode) => `
  const a = await import('./src/docker-access.js');
  console.log(JSON.stringify(a.setDockerAccessMode('${mode}')));
`;

test('new installs persist an authenticated access choice', () => {
  const dataDir = tempDir();
  const first = run(dataDir, READ, { DOCKER_ACCESS_MAX: 'shell' });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), {
    mode: 'read', label: 'Read only', shortLabel: 'Read only',
    ceiling: 'shell', ceilingLabel: 'Management + shell', explicitCeiling: true,
    canManage: false, canShell: false,
  });

  const set = run(dataDir, SET('manage'), { DOCKER_ACCESS_MAX: 'shell' });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).state.mode, 'manage');

  const sidecar = join(dataDir, 'qm-docker-access-v1.json');
  assert.equal(statSync(sidecar).mode & 0o777, 0o600);
  const envelope = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.match(envelope.mac, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(envelope.payload).mode, 'manage');

  const restarted = run(dataDir, READ, { DOCKER_ACCESS_MAX: 'shell' });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(JSON.parse(restarted.stdout).mode, 'manage');
});

test('rejects modes above the installed ceiling', () => {
  const dataDir = tempDir();
  const denied = run(dataDir, SET('shell'), { DOCKER_ACCESS_MAX: 'manage' });
  assert.equal(denied.status, 0, denied.stderr);
  const result = JSON.parse(denied.stdout);
  assert.equal(result.ok, false);
  assert.match(result.error, /above this installation/);

  const current = run(dataDir, READ, { DOCKER_ACCESS_MAX: 'manage' });
  assert.equal(JSON.parse(current.stdout).mode, 'read');
});

test('lowering the ceiling clamps and persists the selected mode', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, SET('shell'), { DOCKER_ACCESS_MAX: 'shell' }).status, 0);

  const lowered = run(dataDir, READ, { DOCKER_ACCESS_MAX: 'manage' });
  assert.equal(lowered.status, 0, lowered.stderr);
  assert.equal(JSON.parse(lowered.stdout).mode, 'manage');

  const raisedAgain = run(dataDir, READ, { DOCKER_ACCESS_MAX: 'shell' });
  assert.equal(raisedAgain.status, 0, raisedAgain.stderr);
  assert.equal(JSON.parse(raisedAgain.stdout).mode, 'manage', 'the old shell choice must not wake up again');
});

test('rejects a tampered access sidecar', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, SET('manage'), { DOCKER_ACCESS_MAX: 'shell' }).status, 0);
  const sidecar = join(dataDir, 'qm-docker-access-v1.json');
  const envelope = JSON.parse(readFileSync(sidecar, 'utf8'));
  envelope.payload = envelope.payload.replace('manage', 'shell');
  writeFileSync(sidecar, JSON.stringify(envelope));

  const refused = run(dataDir, READ, { DOCKER_ACCESS_MAX: 'shell' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Docker access state is unreadable \(authentication failed\)/);
  assert.doesNotMatch(refused.stderr, /Management \+ shell|host-root/);
});

test('preserves the live mode after a failed write', () => {
  const dataDir = tempDir();
  const result = run(dataDir, `
    const { mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const access = await import('./src/docker-access.js');
    const before = access.dockerAccessState();
    mkdirSync(join(process.env.DATA_DIR, 'qm-docker-access-v1.json'));
    const changed = access.setDockerAccessMode('manage');
    const after = access.dockerAccessState();
    console.log(JSON.stringify({ before: before.mode, changed, after: after.mode }));
  `, { DOCKER_ACCESS_MAX: 'shell' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    before: 'read',
    changed: { ok: false, status: 500, error: 'Docker access mode could not be saved.' },
    after: 'read',
  });
});

test('maps cron actions to required capabilities', () => {
  const dataDir = tempDir();
  const result = run(dataDir, `
    const cron = await import('./src/cron.js');
    console.log(JSON.stringify({
      updates: cron.requiredDockerModeForJob('updates-check'),
      prune: cron.requiredDockerModeForJob('prune-images'),
      lifecycle: cron.requiredDockerModeForAction({ type: 'container', op: 'restart', ref: '${'a'.repeat(12)}' }),
      exec: cron.requiredDockerModeForAction({ type: 'exec', ref: '${'b'.repeat(12)}', cmd: 'id' }),
      invalid: cron.requiredDockerModeForAction({ type: 'exec', ref: 'not-an-id', cmd: 'id' }),
    }));
  `, { DOCKER_ACCESS_MAX: 'shell' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    updates: 'read', prune: 'manage', lifecycle: 'manage', exec: 'shell', invalid: null,
  });
});

test('maps legacy and named access ceilings', () => {
  const legacyOn = run(tempDir(), READ, { DOCKER_CONTROL: 'true' });
  assert.equal(legacyOn.status, 0, legacyOn.stderr);
  assert.equal(JSON.parse(legacyOn.stdout).mode, 'shell');
  assert.equal(JSON.parse(legacyOn.stdout).explicitCeiling, false);

  const legacyOff = run(tempDir(), READ, { DOCKER_CONTROL: 'false' });
  assert.equal(legacyOff.status, 0, legacyOff.stderr);
  assert.equal(JSON.parse(legacyOff.stdout).mode, 'read');

  for (const bad of ['management', 'SHELL', ' shell', '']) {
    const invalid = run(tempDir(), READ, { DOCKER_ACCESS_MAX: bad });
    assert.notEqual(invalid.status, 0, `invalid maximum ${JSON.stringify(bad)} was accepted`);
    assert.match(invalid.stderr, /DOCKER_ACCESS_MAX must be exactly read, manage or shell/);
  }
});
