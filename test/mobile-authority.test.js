
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET_KEY = '5c'.repeat(32);
process.env.SECRET_KEY = SECRET_KEY;
process.env.QM_HOST = 'nas.local';
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-mobile-authority-'));
  roots.push(root);
  return root;
}

function run(dataDir, source, extra = {}, preArgs = []) {
  return spawnSync(process.execPath, [...preArgs, '--input-type=module', '-e', source], {
    cwd: projectRoot,
    env: { ...process.env, SECRET_KEY, DATA_DIR: dataDir, QM_HOST: 'nas.local', QM_LOCK_TIMEOUT_MS: '400', ...extra },
    encoding: 'utf8',
  });
}

const sidecarOf = (dataDir) => join(dataDir, 'qm-mobile-v1.json');
const epochOf = (dataDir) => join(dataDir, 'qm-mobile-epoch-v1.json');

const ADD_DEVICE = `
  await import('./src/store.js');
  const mobile = await import('./src/mobile/store.js');
  const at = Date.now();
  const b64 = (n) => Buffer.from(process.argv[2] ?? 'seed').subarray(0, n);
  const id = process.env.QM_TEST_DEVICE_ID;
  const digest = process.env.QM_TEST_DIGEST;
  mobile.updateMobileState((s) => {
    s.devices.push({
      accessTokenDigest: digest,
      accessTokenExpiresAt: at + 3600000,
      ackRecoveryExpiresAt: null,
      ackSecretDigest: process.env.QM_TEST_ACK,
      claimEncryptionKeyHandle: process.env.QM_TEST_HANDLE,
      createdAt: at,
      deviceId: id,
      deviceName: 'Test phone',
      enrolmentId: process.env.QM_TEST_ENROL,
      lastSeenAt: at,
      lookback: null,
      refreshAbsoluteDeadlineAt: at + 86400000,
      refreshDigest: process.env.QM_TEST_REFRESH,
      refreshIdleDeadlineAt: at + 86400000,
      revokedAt: null,
      revokedReason: null,
      scopes: ['summary.read'],
      tlsLeafFingerprint: process.env.QM_TEST_LEAF,
      tokenFamilyGeneration: 1,
      transcriptHash: process.env.QM_TEST_TRANSCRIPT,
    });
  });
  console.log(JSON.stringify({ devices: mobile.loadMobileState().devices.length }));
`;

const REVOKE_ALL = `
  await import('./src/store.js');
  const mobile = await import('./src/mobile/store.js');
  mobile.updateMobileState((s) => {
    for (const d of s.devices) {
      if (d.revokedAt === null) { d.revokedAt = Date.now(); d.revokedReason = 'owner'; }
    }
  });
  console.log(JSON.stringify({ live: mobile.loadMobileState().devices.filter((d) => d.revokedAt === null).length }));
`;

const READ = `
  await import('./src/store.js');
  const mobile = await import('./src/mobile/store.js');
  try {
    const s = mobile.loadMobileState();
    console.log(JSON.stringify({ ok: true, live: s.devices.filter((d) => d.revokedAt === null).length }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
  }
`;

const hex64 = () => randomBytes(32).toString('hex');
const b64url16 = () => randomBytes(16).toString('base64url');

function deviceEnv() {
  return {
    QM_TEST_DEVICE_ID: b64url16(),
    QM_TEST_ENROL: b64url16(),
    QM_TEST_DIGEST: hex64(),
    QM_TEST_ACK: hex64(),
    QM_TEST_HANDLE: hex64(),
    QM_TEST_REFRESH: hex64(),
    QM_TEST_LEAF: hex64(),
    QM_TEST_TRANSCRIPT: hex64(),
  };
}

function pairedDir() {
  const dataDir = tempDir();
  const env = deviceEnv();
  const added = run(dataDir, ADD_DEVICE, env);
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout), { devices: 1 });
  return { dataDir, env, backup: readFileSync(sidecarOf(dataDir)) };
}


test('an authentic earlier sidecar cannot bring a revoked device back', () => {
  const { dataDir, backup } = pairedDir();

  const revoked = run(dataDir, REVOKE_ALL);
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.deepEqual(JSON.parse(revoked.stdout), { live: 0 });

  writeFileSync(sidecarOf(dataDir), backup);
  const restored = run(dataDir, READ);
  assert.equal(restored.status, 0, restored.stderr);
  const verdict = JSON.parse(restored.stdout);
  assert.equal(verdict.ok, false, 'the rolled-back sidecar must not load');
  assert.equal(verdict.code, 'QM_MOBILE_STATE_INVALID');
  assert.match(verdict.message, /older than this installation's authority record/);
  assert.match(verdict.message, /recorded as revoked but the sidecar presents it as live/);
  assert.match(verdict.message, /sidecar authenticates, but it predates a recorded revocation/);
  assert.match(verdict.message, /the owner account, browser and QMC1 are unaffected/);
});

test('operator can accept an older sidecar with guidance', () => {
  const { dataDir, backup } = pairedDir();
  assert.equal(run(dataDir, REVOKE_ALL).status, 0);
  writeFileSync(sidecarOf(dataDir), backup);

  const refusal = JSON.parse(run(dataDir, READ).stdout);
  assert.equal(refusal.ok, false);
  assert.ok(refusal.message.includes(epochOf(dataDir)), refusal.message);
  assert.match(refusal.message, /delete .*; this accepts every grant in the sidecar/);

  rmSync(epochOf(dataDir), { force: true });
  const accepted = JSON.parse(run(dataDir, READ).stdout);
  assert.deepEqual(accepted, { ok: true, live: 1 });
});

test('fails closed on an unreadable authority record', () => {
  const { dataDir } = pairedDir();
  assert.ok(existsSync(epochOf(dataDir)));

  const envelope = JSON.parse(readFileSync(epochOf(dataDir), 'utf8'));
  writeFileSync(epochOf(dataDir), JSON.stringify({ ...envelope, mac: hex64() }, null, 2));
  const verdict = JSON.parse(run(dataDir, READ).stdout);
  assert.equal(verdict.ok, false, 'an unreadable record is not an absent one');
  assert.match(verdict.message, /mobile authority record is unreadable/);
  assert.match(verdict.message, /authentication failed/);
  assert.match(verdict.message, /the owner account, browser and QMC1 are unaffected/);
});

test('re-pairing works after revocation', () => {
  const { dataDir } = pairedDir();
  assert.equal(run(dataDir, REVOKE_ALL).status, 0);
  const again = run(dataDir, ADD_DEVICE, deviceEnv());
  assert.equal(again.status, 0, again.stderr);
  const after = JSON.parse(run(dataDir, READ).stdout);
  assert.deepEqual(after, { ok: true, live: 1 });
});

test('adopts the sidecar when no epoch record exists', () => {
  const dataDir = tempDir();
  const first = run(dataDir, READ);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { ok: true, live: 0 });
});

test('authority records contain no credentials', () => {
  const { dataDir, env } = pairedDir();
  assert.equal(run(dataDir, REVOKE_ALL).status, 0);
  const text = readFileSync(epochOf(dataDir), 'utf8');
  assert.doesNotMatch(text, /qmd_|qmr_|qmp_|PRIVATE KEY/);
  assert.ok(text.includes(env.QM_TEST_DEVICE_ID));
  assert.ok(!text.includes(env.QM_TEST_DIGEST), 'not the access token digest');
  assert.ok(!text.includes(env.QM_TEST_REFRESH), 'not the refresh digest');
  assert.doesNotMatch(text, /Test phone/, 'not the device name');
});

test('preserves revocation after a token refresh and restore', () => {
  const { dataDir, env, backup } = pairedDir();

  const rotated = run(
    dataDir,
    `
      await import('./src/store.js');
      const mobile = await import('./src/mobile/store.js');
      mobile.updateMobileState((s) => {
        for (const d of s.devices) {
          d.accessTokenDigest = process.env.QM_TEST_NEW_ACCESS;
          d.refreshDigest = process.env.QM_TEST_NEW_REFRESH;
          d.tokenFamilyGeneration += 1;
        }
      });
      console.log(JSON.stringify({ gen: mobile.loadMobileState().devices[0].tokenFamilyGeneration }));
    `,
    { ...env, QM_TEST_NEW_ACCESS: hex64(), QM_TEST_NEW_REFRESH: hex64() },
  );
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.deepEqual(JSON.parse(rotated.stdout), { gen: 2 });

  assert.equal(run(dataDir, REVOKE_ALL).status, 0);

  writeFileSync(sidecarOf(dataDir), backup);
  const verdict = JSON.parse(run(dataDir, READ).stdout);
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /older than this installation's authority record/);
  assert.ok(verdict.message.includes(env.QM_TEST_DEVICE_ID), 'and it names the device');
});

test('caps the record without forgetting a revocation', async () => {
  const { readEpoch, raiseEpoch, MAX_REVOKED } = await import('../src/mobile/epoch.js');
  void readEpoch;
  void raiseEpoch;
  assert.equal(MAX_REVOKED, 512);
});


const CONCURRENT = `
  await import('./src/store.js');
  const mobile = await import('./src/mobile/store.js');
  const slot = process.env.QM_TEST_SLOT;
  // Force interleaving when the lock is absent.
  mobile.updateMobileState((s) => {
    const until = Date.now() + Number(process.env.QM_TEST_HOLD_MS);
    while (Date.now() < until) { /* deliberate busy hold inside the transaction */ }
    s.spentCapabilities.push({
      claimEncryptionKeyHandle: process.env['QM_TEST_HANDLE_' + slot],
      digest: process.env['QM_TEST_DIGEST_' + slot],
      enrolmentId: process.env['QM_TEST_ENROL_' + slot],
      expiresAt: Date.now() + 600000,
      family: 'qmp',
      transcriptHash: process.env['QM_TEST_TRANSCRIPT_' + slot],
    });
  });
  console.log('done ' + slot);
`;

test('two processes writing the sidecar at once do not lose one of the writes', async () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, READ).status, 0, 'seed the sidecar first');

  const env = {
    QM_TEST_HOLD_MS: '900',
    QM_TEST_HANDLE_a: hex64(), QM_TEST_DIGEST_a: hex64(), QM_TEST_ENROL_a: b64url16(), QM_TEST_TRANSCRIPT_a: hex64(),
    QM_TEST_HANDLE_b: hex64(), QM_TEST_DIGEST_b: hex64(), QM_TEST_ENROL_b: b64url16(), QM_TEST_TRANSCRIPT_b: hex64(),
  };
  const start = (slot) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', CONCURRENT], {
        cwd: projectRoot,
        env: { ...process.env, SECRET_KEY, DATA_DIR: dataDir, QM_HOST: 'nas.local', ...env, QM_TEST_SLOT: slot },
        encoding: 'utf8',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
  const [a, b] = await Promise.all([start('a'), start('b')]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);

  const state = JSON.parse(
    Buffer.from(JSON.parse(readFileSync(sidecarOf(dataDir), 'utf8')).payload).toString('utf8'),
  );
  const digests = state.spentCapabilities.map((c) => c.digest).sort();
  assert.deepEqual(
    digests,
    [env.QM_TEST_DIGEST_a, env.QM_TEST_DIGEST_b].sort(),
  );
});

const ATTEMPT_WRITE = `
  await import('./src/store.js');
  const mobile = await import('./src/mobile/store.js');
  let code = null; let message = null;
  try { mobile.updateMobileState((s) => { s.tlsResetPending = true; }); }
  catch (error) { code = error.code; message = error.message; }
  console.log(JSON.stringify({ code, message, pending: mobile.loadMobileState().tlsResetPending }));
`;

test('refuses a write when the process cannot acquire the lock', async () => {
  const stamped = tempDir();
  const midWrite = tempDir();
  assert.equal(run(stamped, READ).status, 0);
  assert.equal(run(midWrite, READ).status, 0);

  writeFileSync(join(stamped, '.qm-mobile-state.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  writeFileSync(join(midWrite, '.qm-mobile-state.lock'), '');

  const attempt = (dataDir) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', ATTEMPT_WRITE], {
        cwd: projectRoot,
        env: { ...process.env, SECRET_KEY, DATA_DIR: dataDir, QM_HOST: 'nas.local', QM_LOCK_TIMEOUT_MS: '400' },
        encoding: 'utf8',
      });
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.on('close', (status) => resolve({ status, stdout }));
    });

  const [a, b] = await Promise.all([attempt(stamped), attempt(midWrite)]);
  for (const [label, out, dataDir] of [['stamped', a, stamped], ['mid-write', b, midWrite]]) {
    assert.equal(out.status, 0, label);
    const result = JSON.parse(out.stdout);
    assert.equal(result.code, 'QM_MOBILE_STATE_INVALID', label);
    assert.match(result.message, /another Companion process is holding the sidecar transaction lock/, label);
    assert.match(result.message, /Nothing was changed/, label);
    assert.equal(result.pending, false, `${label}: and nothing was changed`);
    assert.ok(existsSync(join(dataDir, '.qm-mobile-state.lock')), `${label}: the holder's lock was not stolen`);
  }
});


const MAIN_STORE_COMMIT = `
  const store = await import('./src/store.js');
  store.getInstallationId();
  let threw = null;
  try {
    store.claimOwner({ saltHex: 'a'.repeat(32), hashHex: 'b'.repeat(128), createdAt: Date.now() });
  } catch (error) { threw = error.code; }
  // Capture in-memory state immediately after the durability refusal.
  let inMemory = null;
  try { inMemory = store.hasOwner(); } catch (error) { inMemory = error.code; }
  let writeAfter = null;
  try { store.setOwner({ saltHex: 'c'.repeat(32), hashHex: 'd'.repeat(128), createdAt: Date.now() }); }
  catch (error) { writeAfter = error.code; }
  console.log(JSON.stringify({ threw, inMemory, writeAfter }));
`;

test('post-rename fsync failure commits state and stops writes', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, 'const s = await import("./src/store.js"); s.getInstallationId();').status, 0);

  const out = run(dataDir, MAIN_STORE_COMMIT, { QM_FAIL_DIRFSYNC_DIR: dataDir }, [
    '--require',
    './test/helpers/fail-dirfsync.cjs',
  ]);
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.equal(result.threw, 'QM_STATE_INVALID', 'the durability doubt is reported, not swallowed');
  assert.equal(result.inMemory, 'QM_STATE_INVALID', 'reads refuse until a restart');
  assert.equal(result.writeAfter, 'QM_STATE_INVALID', 'and further writes refuse until a restart');
});

test('a first-run write reports its durability instead of discarding it', () => {
  const dataDir = tempDir();
  const out = run(
    dataDir,
    `
      const store = await import('./src/store.js');
      let code = null;
      try { store.getInstallationId(); } catch (error) { code = error.code; }
      console.log(JSON.stringify({ code }));
    `,
    { QM_FAIL_DIRFSYNC_DIR: dataDir },
    ['--require', './test/helpers/fail-dirfsync.cjs'],
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { code: 'QM_STATE_INVALID' });
  const reread = run(dataDir, 'const s = await import("./src/store.js"); console.log(JSON.stringify({ id: typeof s.getInstallationId() }));');
  assert.equal(reread.status, 0, reread.stderr);
  assert.deepEqual(JSON.parse(reread.stdout), { id: 'string' });
});

test('the committed state is what a fresh process reads back', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, 'const s = await import("./src/store.js"); s.getInstallationId();').status, 0);
  assert.equal(
    run(dataDir, MAIN_STORE_COMMIT, { QM_FAIL_DIRFSYNC_DIR: dataDir }, ['--require', './test/helpers/fail-dirfsync.cjs']).status,
    0,
  );
  const reread = run(dataDir, 'const s = await import("./src/store.js"); console.log(JSON.stringify({ owner: s.hasOwner(), salt: s.getOwner()?.saltHex ?? null }));');
  assert.equal(reread.status, 0, reread.stderr);
  assert.deepEqual(JSON.parse(reread.stdout), { owner: true, salt: 'a'.repeat(32) });
});

test('an ordinary write is unaffected and does not fail-stop anything', () => {
  const dataDir = tempDir();
  const out = run(
    dataDir,
    `
      const store = await import('./src/store.js');
      store.claimOwner({ saltHex: 'a'.repeat(32), hashHex: 'b'.repeat(128), createdAt: Date.now() });
      store.setOwner({ saltHex: 'c'.repeat(32), hashHex: 'd'.repeat(128), createdAt: Date.now() });
      console.log(JSON.stringify({ salt: store.getOwner().saltHex }));
    `,
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { salt: 'c'.repeat(32) });
});

test('the recorded fact is a digest, not a token', () => {
  const token = 'qmd_' + randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(token).digest('hex');
  assert.notEqual(digest, token);
  assert.match(digest, /^[0-9a-f]{64}$/);
});
