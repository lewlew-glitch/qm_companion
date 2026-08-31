import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET_KEY = '5c'.repeat(32);
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-mobile-state-'));
  roots.push(root);
  return root;
}

function run(dataDir, source, extra = {}, preArgs = []) {
  return spawnSync(process.execPath, [...preArgs, '--input-type=module', '-e', source], {
    cwd: projectRoot,
    env: { ...process.env, SECRET_KEY, DATA_DIR: dataDir, QM_HOST: 'nas.local', ...extra },
    encoding: 'utf8',
  });
}

const BOOT = `
  const main = await import('./src/store.js');
  const mobile = await import('./src/mobile/store.js');
  const state = mobile.loadMobileState();
  console.log(JSON.stringify({
    legacy: main.getInstallationId(),
    mobileId: state.mobileInstallationId,
    fingerprint: state.identity.fingerprint,
    devices: state.devices.length,
    tlsResetPending: state.tlsResetPending,
  }));
`;

const SIGN_ROUNDTRIP = `
  const mobile = await import('./src/mobile/store.js');
  const identity = await import('./src/mobile/identity.js');
  const state = mobile.loadMobileState();
  const key = identity.openPrivateKey(state.identity.sealedPrivateKey, state.mobileInstallationId);
  if (!key) throw new Error('identity failed to unseal');
  const bytes = Buffer.from('qm-identity-v1\\u0000probe');
  const signature = identity.signWithIdentity(key, bytes);
  console.log(JSON.stringify({
    verified: identity.verifyWithPublicKey(state.identity.publicKey, bytes, signature),
    tampered: identity.verifyWithPublicKey(state.identity.publicKey, Buffer.from('other'), signature),
  }));
`;

const KEYS_DISTINCT = `
  const { allPurposeKeys } = await import('./src/mobile/keys.js');
  const keys = Object.values(allPurposeKeys()).map((k) => k.toString('hex'));
  console.log(JSON.stringify({ total: keys.length, distinct: new Set(keys).size }));
`;

const FEATURES = `
  const { mobileFeatures } = await import('./src/mobile/features.js');
  console.log(JSON.stringify(mobileFeatures()));
`;

test('creates an authenticated sidecar with restricted modes', () => {
  const dataDir = tempDir();
  const first = run(dataDir, BOOT);
  assert.equal(first.status, 0, first.stderr);
  const created = JSON.parse(first.stdout);
  assert.match(created.mobileId, /^[0-9a-f-]{36}$/);
  assert.match(created.fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(created.mobileId, created.legacy);
  assert.equal(created.devices, 0);
  assert.equal(created.tlsResetPending, false);

  const file = join(dataDir, 'qm-mobile-v1.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(envelope).sort(), ['mac', 'payload', 'version']);

  const before = readFileSync(file, 'utf8');
  const second = run(dataDir, BOOT);
  assert.equal(second.status, 0, second.stderr);
  const reread = JSON.parse(second.stdout);
  assert.equal(reread.mobileId, created.mobileId);
  assert.equal(reread.fingerprint, created.fingerprint);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('unseals the identity and verifies signatures', () => {
  const dataDir = tempDir();
  const out = run(dataDir, SIGN_ROUNDTRIP);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { verified: true, tampered: false });
});

test('rejects tampered or malformed sidecars', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, BOOT).status, 0);
  const file = join(dataDir, 'qm-mobile-v1.json');
  const pristine = readFileSync(file, 'utf8');

  const flippedMac = JSON.parse(pristine);
  flippedMac.mac = `${flippedMac.mac.slice(0, -1)}${flippedMac.mac.endsWith('0') ? '1' : '0'}`;
  writeFileSync(file, JSON.stringify(flippedMac));
  let out = run(dataDir, BOOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /authentication failed/);

  const editedPayload = JSON.parse(pristine);
  editedPayload.payload = editedPayload.payload.replace('"tlsResetPending":false', '"tlsResetPending":true');
  writeFileSync(file, JSON.stringify(editedPayload));
  out = run(dataDir, BOOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /authentication failed/);

  writeFileSync(file, 'not json at all');
  out = run(dataDir, BOOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /invalid JSON/);
  assert.match(out.stderr, /QM1|owner|unaffected/i);
  writeFileSync(file, pristine);
});

test('rejects authenticated payloads with unknown fields', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, BOOT).status, 0);
  const file = join(dataDir, 'qm-mobile-v1.json');
  const forge = `
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { createHmac, hkdfSync } = await import('node:crypto');
    const { canonicalMobilePayload } = await import('./src/mobile/schema.js');
    const file = ${JSON.stringify(file)};
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    const parsed = JSON.parse(envelope.payload);
    parsed.extraAuthority = true;
    const payload = canonicalMobilePayload(parsed);
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(process.env.SECRET_KEY, 'hex'), Buffer.alloc(0), 'qm-companion:mobile-state', 32));
    const mac = createHmac('sha256', key).update('qm-companion:mobile-state:v1\\u0000').update(payload, 'utf8').digest('hex');
    writeFileSync(file, JSON.stringify({ version: 1, payload, mac }));
  `;
  assert.equal(run(dataDir, forge).status, 0);
  const out = run(dataDir, BOOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /unexpected fields/);
});

function resign(file, snippet) {
  return `
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { createHmac, hkdfSync } = await import('node:crypto');
    const { canonicalMobilePayload } = await import('./src/mobile/schema.js');
    const file = ${JSON.stringify(file)};
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    const parsed = JSON.parse(envelope.payload);
    let payload;
    ${snippet}
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(process.env.SECRET_KEY, 'hex'), Buffer.alloc(0), 'qm-companion:mobile-state', 32));
    const mac = createHmac('sha256', key).update('qm-companion:mobile-state:v1\\u0000').update(payload, 'utf8').digest('hex');
    writeFileSync(file, JSON.stringify({ version: 1, payload, mac }));
  `;
}

test('rejects authenticated payloads with reordered fields', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, BOOT).status, 0);
  const file = join(dataDir, 'qm-mobile-v1.json');
  const pristine = readFileSync(file, 'utf8');

  const topLevel = resign(
    file,
    `
    const keys = Object.keys(parsed).sort().reverse();
    payload = '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalMobilePayload(parsed[k])).join(',') + '}';
  `,
  );
  assert.equal(run(dataDir, topLevel).status, 0);
  let out = run(dataDir, BOOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /not canonical/);

  writeFileSync(file, pristine);
  const nested = resign(
    file,
    `
    const idKeys = Object.keys(parsed.identity).sort().reverse();
    const identity = '{' + idKeys.map((k) => JSON.stringify(k) + ':' + canonicalMobilePayload(parsed.identity[k])).join(',') + '}';
    const keys = Object.keys(parsed).sort();
    payload = '{' + keys.map((k) => JSON.stringify(k) + ':' + (k === 'identity' ? identity : canonicalMobilePayload(parsed[k]))).join(',') + '}';
  `,
  );
  assert.equal(run(dataDir, nested).status, 0);
  out = run(dataDir, BOOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /not canonical/);
});

test('returns detached state values', () => {
  const dataDir = tempDir();
  const out = run(
    dataDir,
    `
      const mobile = await import('./src/mobile/store.js');
      const first = mobile.loadMobileState();
      first.tlsResetPending = true; // mutate the returned value without saving
      first.devices.push({ smuggled: true });
      const second = mobile.loadMobileState();
      console.log(JSON.stringify({ pending: second.tlsResetPending, devices: second.devices.length }));
    `,
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { pending: false, devices: 0 });
});

test('commits updates and preserves state before commit failure', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, BOOT).status, 0);
  const file = join(dataDir, 'qm-mobile-v1.json');
  const before = readFileSync(file, 'utf8');

  const out = run(
    dataDir,
    `
      const { renameSync, rmSync, writeFileSync } = await import('node:fs');
      const mobile = await import('./src/mobile/store.js');
      mobile.loadMobileState();
      const dir = ${JSON.stringify(dataDir)};
      renameSync(dir, dir + '.moved');
      writeFileSync(dir, 'not a directory');
      let threw = null;
      try {
        mobile.updateMobileState((s) => { s.tlsResetPending = true; });
      } catch (error) {
        threw = error.code;
      }
      rmSync(dir);
      renameSync(dir + '.moved', dir);
      const after = mobile.loadMobileState();
      const ok = mobile.updateMobileState((s) => { s.tlsResetPending = true; });
      console.log(JSON.stringify({ threw, preserved: after.tlsResetPending, committed: ok.tlsResetPending }));
    `,
  );
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.equal(result.threw, 'QM_MOBILE_STATE_INVALID');
  assert.equal(result.preserved, false);
  assert.equal(result.committed, true);

  const reread = run(dataDir, BOOT);
  assert.equal(reread.status, 0, reread.stderr);
  assert.equal(JSON.parse(reread.stdout).tlsResetPending, true);
  assert.notEqual(readFileSync(file, 'utf8'), before);
});

test('preserves disk and memory after a pre-rename failure', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, BOOT).status, 0);
  const file = join(dataDir, 'qm-mobile-v1.json');
  const before = readFileSync(file, 'utf8');
  const out = run(
    dataDir,
    `
      const mobile = await import('./src/mobile/store.js');
      mobile.loadMobileState();
      let threw = null;
      try { mobile.updateMobileState((s) => { s.tlsResetPending = true; }); } catch (error) { threw = error.code; }
      const after = mobile.loadMobileState();
      console.log(JSON.stringify({ threw, preserved: after.tlsResetPending }));
    `,
    { QM_FAIL_RENAME_SUFFIX: 'qm-mobile-v1.json' },
    ['--require', './test/helpers/fail-rename.cjs'],
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { threw: 'QM_MOBILE_STATE_INVALID', preserved: false });
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('commits state and reports a post-rename durability error', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, BOOT).status, 0);
  const out = run(
    dataDir,
    `
      const mobile = await import('./src/mobile/store.js');
      mobile.loadMobileState();
      let threw = null;
      try { mobile.updateMobileState((s) => { s.tlsResetPending = true; }); } catch (error) { threw = error.code; }
      let readAfter = null;
      try { mobile.loadMobileState(); } catch (error) { readAfter = error.code; }
      let writeAfter = null;
      let ran = 0;
      try {
        mobile.updateMobileState((s) => { ran += 1; return s; });
      } catch (error) {
        writeAfter = error.code;
      }
      console.log(JSON.stringify({ threw, readAfter, writeAfter, ran }));
    `,
    { QM_FAIL_DIRFSYNC_DIR: dataDir },
    ['--require', './test/helpers/fail-dirfsync.cjs'],
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {
    threw: 'QM_MOBILE_STATE_DURABILITY_UNCERTAIN',
    readAfter: 'QM_MOBILE_STATE_INVALID',
    writeAfter: 'QM_MOBILE_STATE_INVALID',
    ran: 0,
  });
  const reread = run(dataDir, BOOT);
  assert.equal(reread.status, 0, reread.stderr);
  assert.equal(JSON.parse(reread.stdout).tlsResetPending, true);
});

test('an unreadable sealed identity fails mobile closed', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, BOOT).status, 0);
  const file = join(dataDir, 'qm-mobile-v1.json');
  const tamper = resign(
    file,
    `
    const body = parsed.identity.sealedPrivateKey.split(':');
    body[2] = body[2].slice(0, -1) + (body[2].endsWith('0') ? '1' : '0');
    parsed.identity.sealedPrivateKey = body.join(':');
    payload = canonicalMobilePayload(parsed);
  `,
  );
  assert.equal(run(dataDir, tamper).status, 0);
  const out = run(dataDir, BOOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /identity is unreadable/);
});

test('rejects a spliced public key or fingerprint', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, BOOT).status, 0);
  const file = join(dataDir, 'qm-mobile-v1.json');
  const pristine = readFileSync(file, 'utf8');

  const splicedKey = resign(
    file,
    `
    const { generateKeyPairSync } = await import('node:crypto');
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    parsed.identity.publicKey = Buffer.from(other.subarray(12)).toString('base64url');
    payload = canonicalMobilePayload(parsed);
  `,
  );
  assert.equal(run(dataDir, splicedKey).status, 0);
  let out = run(dataDir, BOOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /identity is inconsistent/);

  writeFileSync(file, pristine);
  const splicedFingerprint = resign(
    file,
    `
    parsed.identity.fingerprint = 'ab'.repeat(32);
    payload = canonicalMobilePayload(parsed);
  `,
  );
  assert.equal(run(dataDir, splicedFingerprint).status, 0);
  out = run(dataDir, BOOT);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /identity is inconsistent/);
});

test('isolates corrupt mobile state from main state', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, BOOT).status, 0);
  writeFileSync(join(dataDir, 'qm-mobile-v1.json'), '{"version":1,"payload":"x","mac":"y"}');
  const mainOnly = run(
    dataDir,
    `
      const main = await import('./src/store.js');
      console.log(JSON.stringify({ legacy: main.getInstallationId() }));
    `,
  );
  assert.equal(mainOnly.status, 0, mainOnly.stderr);
  assert.match(JSON.parse(mainOnly.stdout).legacy, /^[0-9a-f-]{36}$/);
});

test('creating the sidecar leaves the main state byte-identical', () => {
  const dataDir = tempDir();
  const warm = run(
    dataDir,
    `
      const main = await import('./src/store.js');
      main.getInstallationId();
      console.log('ok');
    `,
  );
  assert.equal(warm.status, 0, warm.stderr);
  const mainFile = join(dataDir, 'qm-companion.json');
  const before = readFileSync(mainFile, 'utf8');
  assert.equal(run(dataDir, BOOT).status, 0);
  assert.equal(readFileSync(mainFile, 'utf8'), before);
});

test('every purpose-derived key is pairwise distinct', () => {
  const dataDir = tempDir();
  const out = run(dataDir, KEYS_DISTINCT);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { total: 6, distinct: 6 });
});

test('mobile features default off', () => {
  const dataDir = tempDir();
  let out = run(dataDir, FEATURES);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { api: false, enrolment: false });

  out = run(dataDir, FEATURES, { MOBILE_ENROLMENT_ENABLED: 'true' });
  assert.deepEqual(JSON.parse(out.stdout), { api: false, enrolment: false });

  out = run(dataDir, FEATURES, {
    MOBILE_API_ENABLED: 'true',
    MOBILE_ENROLMENT_ENABLED: 'true',
  });
  assert.deepEqual(JSON.parse(out.stdout), { api: true, enrolment: true });
});

test('browser server imports owner routes and listener startup only', () => {
  const server = readFileSync(join(projectRoot, 'src', 'server.js'), 'utf8');
  const mobileImports = [...server.matchAll(/from '\.\/mobile\/([a-z-]+)\.js'/g)].map((m) => m[1]).sort();
  assert.deepEqual(mobileImports, ['listener', 'owner-routes']);
  for (const forbidden of ['createMobileRouter', 'authenticateAccess', 'claimEnrolment', 'refreshTokens', 'retrieveGrant', 'acknowledgeEnrolment']) {
    assert.ok(!server.includes(forbidden), `${forbidden} must not be reachable from the browser plane`);
  }
  const bearerBlock = /const BEARER_READ_PATHS = new Set\(\[([^\]]*)\]\)/.exec(server);
  assert.ok(bearerBlock && !bearerBlock[1].includes('/api/mobile'), 'no mobile path may ever join BEARER_READ_PATHS');
});
