
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const RIGHT_KEY = '4b'.repeat(32);
const WRONG_KEY = '9e'.repeat(32);
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-wrong-key-'));
  roots.push(root);
  return root;
}

function run(dataDir, source, { key = RIGHT_KEY, extra = {} } = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectRoot,
    env: { ...process.env, SECRET_KEY: key, QM_HOST: 'nas.local', DATA_DIR: dataDir, ...extra },
    encoding: 'utf8',
  });
}

function assertNonDestructiveKeyMessage(message, { file, lost }) {
  assert.match(message, /authentication failed/);
  assert.ok(message.includes(file), 'the message names the file it is about');
  assert.doesNotMatch(message, /is intact/);
  assert.match(message, /cannot distinguish a changed key from a damaged or replaced/, 'the ambiguity is stated');
  assert.match(message, /changed or regenerated key is the usual cause/, 'the likely cause is stated');
  assert.match(message, /Restore the SECRET_KEY previously used/, 'the non-destructive action is stated');
  assert.equal((message.match(/do not authenticate together/gu) || []).length, 1,
    'the authentication failure is stated once');

  assert.match(message, /prints 64 for a complete key/, 'it offers a way to check the key is present');
  assert.match(message, /SECRET_KEY \|\| ''\)\.length/);
  assert.equal(message.includes(RIGHT_KEY), false, 'no key is ever printed');
  assert.equal(message.includes(WRONG_KEY), false, 'no key is ever printed');

  const remedyAt = message.indexOf('Restore the SECRET_KEY previously used');
  const removeAt = message.indexOf(`removing ${file}`);
  assert.ok(removeAt > remedyAt);
  assert.match(message, new RegExp(lost));
}

const STATE_BOOT = `
  const s = await import('./src/store.js');
  try {
    s.hasOwner();
  } catch (error) {
    process.stdout.write(JSON.stringify({ code: error.code }));
    process.stderr.write(error.message);
    process.exit(3);
  }
`;

test('points to SECRET_KEY for authenticated state failures', () => {
  const dataDir = tempDir();
  const seeded = run(dataDir, `
    const s = await import('./src/store.js');
    s.claimOwner({ saltHex: 'aa'.repeat(16), hashHex: 'bb'.repeat(64), createdAt: 1 });
    s.saveService({ id: 'radarr-1', kind: 'radarr', label: 'Radarr', baseUrl: 'http://nas.local:7878' }, { apiKey: 'k' });
  `);
  assert.equal(seeded.status, 0, seeded.stderr);

  const file = join(dataDir, 'qm-companion.json');
  const before = readFileSync(file, 'utf8');

  const refused = run(dataDir, STATE_BOOT, { key: WRONG_KEY });
  assert.equal(refused.status, 3, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, 'QM_STATE_INVALID', 'the typed code survives for check-state.mjs');

  assertNonDestructiveKeyMessage(refused.stderr, {
    file,
    lost: 'the owner account and password, every configured service and its stored credentials, every API token',
  });
  assert.ok(refused.stderr.includes(join(dataDir, 'qm-mobile-v1.json')));
  assert.match(refused.stderr, /Paired-phone records .* are not deleted/);

  assert.equal(readFileSync(file, 'utf8'), before);
  const recovered = run(dataDir, `
    const s = await import('./src/store.js');
    console.log(JSON.stringify({ owner: s.hasOwner(), services: s.listSavedServices().length }));
  `);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout), { owner: true, services: 1 });
});

test('wrong-key and corruption messages use separate actions', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, `const s = await import('./src/store.js'); s.getInstallationId();`).status, 0);
  writeFileSync(join(dataDir, 'qm-companion.json'), '{broken');

  const corrupt = run(dataDir, STATE_BOOT);
  assert.equal(corrupt.status, 3, corrupt.stderr);
  assert.equal(JSON.parse(corrupt.stdout).code, 'QM_STATE_INVALID');
  assert.match(corrupt.stderr, /file is invalid JSON/);
  assert.doesNotMatch(corrupt.stderr, /is intact/, 'a damaged file is not described as intact');
  assert.doesNotMatch(corrupt.stderr, /SECRET_KEY is by far the likeliest cause/, 'corruption is not blamed on the key');
  assert.match(corrupt.stderr, /restore .* from backup/);
  assert.match(corrupt.stderr, /Warning: Removing/, 'removal is marked as destructive');
});

test('wrong key for access sidecar preserves other state', () => {
  const dataDir = tempDir();
  const seeded = run(dataDir, `
    const a = await import('./src/docker-access.js');
    console.log(JSON.stringify(a.setDockerAccessMode('manage').ok));
  `, { extra: { DOCKER_ACCESS_MAX: 'shell' } });
  assert.equal(seeded.status, 0, seeded.stderr);

  const file = join(dataDir, 'qm-docker-access-v1.json');
  const before = readFileSync(file, 'utf8');
  unlinkSync(join(dataDir, 'qm-companion.json'));

  const refused = run(dataDir, `
    const a = await import('./src/docker-access.js');
    try {
      a.dockerAccessState();
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code }));
      process.stderr.write(error.message);
      process.exit(3);
    }
  `, { key: WRONG_KEY, extra: { DOCKER_ACCESS_MAX: 'shell' } });
  assert.equal(refused.status, 3, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, 'QM_DOCKER_ACCESS_INVALID');

  assertNonDestructiveKeyMessage(refused.stderr, {
    file,
    lost: 'does not remove accounts, services, credentials, API tokens or paired phones',
  });
  assert.match(refused.stderr, /resets only the Docker access mode to Read only/, 'the reset impact is stated');
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('wrong mobile key does not report owner-account loss', () => {
  const dataDir = tempDir();
  const seeded = run(dataDir, `
    const mobile = await import('./src/mobile/store.js');
    console.log(JSON.stringify(mobile.loadMobileState().devices.length));
  `);
  assert.equal(seeded.status, 0, seeded.stderr);

  const file = join(dataDir, 'qm-mobile-v1.json');
  const before = readFileSync(file, 'utf8');
  unlinkSync(join(dataDir, 'qm-companion.json'));

  const refused = run(dataDir, `
    const mobile = await import('./src/mobile/store.js');
    try {
      mobile.loadMobileState();
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code }));
      process.stderr.write(error.message);
      process.exit(3);
    }
  `, { key: WRONG_KEY });
  assert.equal(refused.status, 3, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, 'QM_MOBILE_STATE_INVALID');

  assertNonDestructiveKeyMessage(refused.stderr, {
    file,
    lost: 'deletes only the mobile identity and pairings; every phone must pair again',
  });
  assert.match(refused.stderr, /the owner account, browser and QMC1 are unaffected/);
  assert.match(refused.stderr, /existing pairings remain/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

const V1_STATE = JSON.stringify({
  version: 1,
  installationId: '55555555-5555-4555-8555-555555555555',
  owner: null,
  services: [],
  prefs: {},
  apiTokens: [],
  cron: null,
});

test('invalid v1 marker does not report successful authentication', () => {
  const dataDir = tempDir();
  writeFileSync(join(dataDir, 'qm-companion.json'), V1_STATE);
  writeFileSync(join(dataDir, 'qm-companion.v1-migration-used'), `${'ab'.repeat(32)}\n`);

  const refused = run(dataDir, STATE_BOOT, { extra: { MIGRATE_V1_STATE: 'true' } });
  assert.equal(refused.status, 3, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, 'QM_STATE_INVALID');
  const message = refused.stderr;

  assert.match(message, /authentication failed/);
  assert.ok(message.includes(join(dataDir, 'qm-companion.v1-migration-used')), 'it names the marker');
  assert.doesNotMatch(message, /is intact/u);
  assert.match(message, /marker and configured SECRET_KEY do not authenticate together/u);
  assert.match(message, /Restore the SECRET_KEY previously used/u, 'the reversible action is missing');
  assert.match(message, /prints 64 for a complete key/u, 'the length-only key check is missing');
  assert.equal(message.includes(RIGHT_KEY), false, 'no key is ever printed');

  const remedyAt = message.indexOf('Restore the SECRET_KEY previously used');
  const deleteAt = message.indexOf(`delete ${join(dataDir, 'qm-companion.v1-migration-used')}`);
  assert.ok(remedyAt > 0 && deleteAt > remedyAt);
  assert.match(message, /marker contains no account or credential data/u, 'the delete impact is missing');
});
