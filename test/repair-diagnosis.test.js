import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const projectRoot = join(import.meta.dirname, '..');
const roots = [];
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function dataDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-repair-'));
  roots.push(root);
  return root;
}

function snapshot(dir) {
  const out = {};
  for (const name of readdirSync(dir)) {
    try { out[name] = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'); }
    catch { out[name] = 'unreadable'; }
  }
  return out;
}

function runRepair(dir, env = {}) {
  return spawnSync(process.execPath, ['src/mobile/repair.js'], {
    cwd: projectRoot,
    env: { ...process.env, DATA_DIR: dir, QM_HOST: 'nas.local', SECRET_KEY: 'ab'.repeat(32), ...env },
    encoding: 'utf8',
  });
}

function seedLegacyV1(dir) {
  writeFileSync(join(dir, 'qm-companion.json'), JSON.stringify({
    version: 1,
    owner: { hashHex: 'aa'.repeat(64), saltHex: 'bb'.repeat(16) },
    services: {}, prefs: {}, apiTokens: [], cron: [],
  }));
}

test('read-only diagnosis leaves v1 state unchanged', () => {
  const dir = dataDir();
  const seed = spawnSync(process.execPath, ['-e', `
    process.env.DATA_DIR = ${JSON.stringify(dir)};
    process.env.SECRET_KEY = 'ab'.repeat(32);
    process.env.QM_HOST = 'nas.local';
    const s = await import('./src/store.js');
    s.claimOwner({ hashHex: 'aa'.repeat(64), saltHex: 'bb'.repeat(16) });
    const m = await import('./src/mobile/store.js');
    m.loadMobileState();
  `], { cwd: projectRoot, encoding: 'utf8', env: { ...process.env } });
  assert.equal(seed.status, 0, `seeding failed: ${seed.stderr}`);
  seedLegacyV1(dir);

  const before = snapshot(dir);
  const run = runRepair(dir, { MIGRATE_V1_STATE: 'true' });
  const after = snapshot(dir);

  assert.deepEqual(after, before);
  assert.equal(after['qm-companion.v1-migration-used'], undefined, 'the one-boot marker was not spent');
  const text = `${run.stdout}${run.stderr}`;
  assert.match(text, /v1/i);
});

test('wrong-key diagnosis tolerates one damaged file', () => {
  const written = 'ab'.repeat(32);
  const wrong = '9e'.repeat(32);
  const dir = dataDir();

  const seed = spawnSync(process.execPath, ['-e', `
    process.env.DATA_DIR = ${JSON.stringify(dir)};
    process.env.SECRET_KEY = ${JSON.stringify(written)};
    process.env.QM_HOST = 'nas.local';
    const s = await import('./src/store.js');
    s.claimOwner({ hashHex: 'aa'.repeat(64), saltHex: 'bb'.repeat(16) });
    // Write a valid sidecar under the original key so the wrong key reaches MAC verification.
    const m = await import('./src/mobile/store.js');
    m.loadMobileState();
  `], { cwd: projectRoot, encoding: 'utf8', env: { ...process.env } });
  assert.equal(seed.status, 0, `seeding failed: ${seed.stderr}`);

  writeFileSync(join(dir, 'qm-docker-access-v1.json'), '{ not json');

  const run = runRepair(dir, { SECRET_KEY: wrong });
  const text = `${run.stdout}${run.stderr}`;

  assert.match(text, /Diagnosis: SECRET_KEY mismatch and file damage are both possible/, 'both faults are named');
  assert.match(text, /was unreadable before authentication/, 'and the damage is not swallowed');
  assert.doesNotMatch(text, /authenticated files are not corrupt/);
  assert.match(text, /Warning: Keep qm-mobile-v1\.json/, 'the line that saves every paired phone');
  assert.match(text, /Action: Check the original SECRET_KEY first/, 'and the reversible half is checked first');
  assert.match(text, /\[A02\]/);
  assert.doesNotMatch(text, new RegExp(written));
  assert.doesNotMatch(text, new RegExp(wrong), 'nor the wrong one');
});

test('correct keys are not diagnosed as incorrect', () => {
  const written = 'ab'.repeat(32);
  const dir = dataDir();
  const seed = spawnSync(process.execPath, ['-e', `
    process.env.DATA_DIR = ${JSON.stringify(dir)};
    process.env.SECRET_KEY = ${JSON.stringify(written)};
    process.env.QM_HOST = 'nas.local';
    const s = await import('./src/store.js');
    s.claimOwner({ hashHex: 'aa'.repeat(64), saltHex: 'bb'.repeat(16) });
    const m = await import('./src/mobile/store.js');
    m.loadMobileState();
  `], { cwd: projectRoot, encoding: 'utf8', env: { ...process.env } });
  assert.equal(seed.status, 0, `seeding failed: ${seed.stderr}`);

  writeFileSync(join(dir, 'qm-docker-access-v1.json'), '{ truncated');
  writeFileSync(join(dir, 'qm-mobile-v1.json'), '{ truncated');

  const run = runRepair(dir, { SECRET_KEY: written });
  const text = `${run.stdout}${run.stderr}`;

  assert.doesNotMatch(text, /Diagnosis: SECRET_KEY mismatch;/, 'the key is not blamed');
  assert.doesNotMatch(text, /authenticated files are not corrupt/, 'and damage is not denied');
  assert.match(text, /SECRET_KEY is valid for this volume/);
  assert.match(text, /\[A03\]/);
});

test('read-only volumes use non-mutating diagnosis', (t) => {
  const written = 'ab'.repeat(32);
  const dir = dataDir();
  const seed = spawnSync(process.execPath, ['-e', `
    process.env.DATA_DIR = ${JSON.stringify(dir)};
    process.env.SECRET_KEY = ${JSON.stringify(written)};
    process.env.QM_HOST = 'nas.local';
    const s = await import('./src/store.js');
    s.claimOwner({ hashHex: 'aa'.repeat(64), saltHex: 'bb'.repeat(16) });
    const m = await import('./src/mobile/store.js');
    m.loadMobileState();
  `], { cwd: projectRoot, encoding: 'utf8', env: { ...process.env } });
  assert.equal(seed.status, 0, `seeding failed: ${seed.stderr}`);

  const locked = spawnSync('chflags', ['uchg', dir], { encoding: 'utf8' });
  if (locked.status !== 0) {
    t.skip('chflags is unavailable, so an unwritable volume cannot be simulated here');
    return;
  }
  t.after(() => { spawnSync('chflags', ['nouchg', dir]); chmodSync(dir, 0o700); });

  const run = runRepair(dir, { SECRET_KEY: written });
  const text = `${run.stdout}${run.stderr}`;
  assert.doesNotMatch(text, /EPERM/);
  assert.match(text, /Companion state:\s+readable and authenticated/, 'the authentic file reads as authentic');
  assert.doesNotMatch(text, /Diagnosis: SECRET_KEY mismatch/, 'and the key is not blamed for a mount');
});
