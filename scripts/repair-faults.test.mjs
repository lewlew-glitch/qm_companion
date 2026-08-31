
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..');
const KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);
const HOST = '192.168.1.11';
const PORT = 8788;
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-repair-faults-'));
  roots.push(root);
  return root;
}

function env(dataDir, extra = {}) {
  const inherited = { ...process.env };
  for (const name of ['QM_CLONE_AS_NEW', 'DOCKER_CONTROL', 'DOCKER_ACCESS_MAX', 'MIGRATE_V1_STATE']) {
    delete inherited[name];
  }
  return {
    ...inherited,
    SECRET_KEY: KEY,
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

function inState(dataDir, source, extra = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectRoot, env: env(dataDir, extra), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const repair = (dataDir, extra = {}) =>
  spawnSync(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: env(dataDir, extra), encoding: 'utf8' });

function provision(dataDir) {
  inState(dataDir, `
    const { loadMobileState } = await import('${url('src/mobile/store.js')}');
    const { setDockerAccessMode } = await import('${url('src/docker-access.js')}');
    const { ensureMobileCertificate } = await import('${url('src/mobile/cert.js')}');
    loadMobileState();
    const saved = setDockerAccessMode('read');
    if (!saved.ok) throw new Error(saved.error);
    const made = ensureMobileCertificate({ dataDir: ${JSON.stringify(dataDir)}, host: ${JSON.stringify(HOST)} });
    if (!made.ok) throw new Error(made.reason);
  `);
}

function corruptOneByte(file) {
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  const at = envelope.payload.indexOf('"');
  const original = envelope.payload;
  const index = original.indexOf('a', at) >= 0 ? original.indexOf('a', at) : at + 1;
  envelope.payload = `${original.slice(0, index)}${original[index] === 'b' ? 'c' : 'b'}${original.slice(index + 1)}`;
  assert.notEqual(envelope.payload, original);
  assert.equal(envelope.payload.length, original.length);
  writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
}

const stateFile = (dataDir) => join(dataDir, 'qm-companion.json');
const mobileFile = (dataDir) => join(dataDir, 'qm-mobile-v1.json');
const accessFile = (dataDir) => join(dataDir, 'qm-docker-access-v1.json');

const NO_SECRETS = /-----BEGIN[^\n]*PRIVATE KEY|sealedPrivateKey|qmd_|qmr_|qmp_|[0-9a-f]{24}:[0-9a-f]{32}:/;

test('healthy volume: reports authenticated sidecars and a ready gate', () => {
  const dataDir = tempDir();
  provision(dataDir);
  const result = repair(dataDir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Companion state:\s+readable and authenticated with this SECRET_KEY/);
  assert.match(result.stdout, /Docker access sidecar:\s+healthy; it authenticates with this SECRET_KEY/);
  assert.match(result.stdout, /V1 migration marker:\s+none on this volume/);
  assert.match(result.stdout, /Mobile state:\s+readable, authenticated and consistent/);
  assert.match(result.stdout, /Installation binding:\s+healthy; the mobile sidecar is bound to this Companion installation/);
  assert.match(result.stdout, /Authenticated files:\s+Companion state, Docker access sidecar, Mobile state \(3 of the 3 opened here\)/);
  assert.match(result.stdout, /Mobile listener plan:\s+would start/);
  assert.doesNotMatch(result.stdout, /Diagnosis:/);
  assert.doesNotMatch(result.stdout, NO_SECRETS);
});

test('wrong SECRET_KEY reports auth failure and preserves pairings', () => {
  const dataDir = tempDir();
  provision(dataDir);
  const before = readFileSync(mobileFile(dataDir), 'utf8');
  const result = repair(dataDir, { SECRET_KEY: OTHER_KEY });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Companion state:\s+unreadable \(authentication failed\)/);
  assert.match(result.stdout, /Docker access sidecar:\s+present; authentication failed for this SECRET_KEY/);
  assert.match(result.stdout, /Mobile state:\s+unreadable \(authentication failed\)/);
  assert.match(result.stdout, /none: .*failed authentication/);
  assert.doesNotMatch(result.stdout, /could not be read far enough to try/);
  assert.match(result.stdout, /Diagnosis: SECRET_KEY mismatch; authenticated files are not corrupt\./);
  assert.match(result.stdout, /Cause: The current key was rejected by Companion state, Docker access sidecar, Mobile state\./);
  assert.match(result.stdout, /Evidence: Key-independent TLS material loaded successfully\./);
  assert.match(result.stdout, /\[M05\] Mobile state at .*qm-mobile-v1\.json rejected this SECRET_KEY\./);
  assert.doesNotMatch(result.stdout, /\[M06\] Mobile state could not be read/);
  assert.match(result.stdout, /Warning: Keep qm-mobile-v1\.json\. Deleting it destroys every phone pairing and cannot fix a key mismatch\./);
  assert.match(result.stdout, /Action: Restore this installation's original SECRET_KEY and start Companion/);
  assert.match(result.stdout, /\[A01\] All authenticated files rejected the current SECRET_KEY\. Restore the original key\./);
  assert.doesNotMatch(result.stdout, /would start/);
  assert.match(result.stdout, /Mobile listener plan:\s+not assessed/);
  assert.equal(readFileSync(mobileFile(dataDir), 'utf8'), before);
  assert.match(result.stdout, /docker compose (-f \S+ )+run --rm --no-deps --entrypoint node companion src\/mobile\/repair\.js/);
  assert.match(result.stdout, /-f docker-compose\.example\.yml -f docker-compose\.mobile\.yml run/, 'base first, mobile overlay last');
  assert.match(result.stdout, /`docker exec` requires\s+a running container/);
  assert.doesNotMatch(result.stdout, NO_SECRETS);
  assert.ok(!result.stdout.includes(OTHER_KEY) && !result.stdout.includes(KEY), 'no key value is ever printed');
});

test('corrupt main state: healthy files clear the key and mobile sidecar', () => {
  const dataDir = tempDir();
  provision(dataDir);
  corruptOneByte(stateFile(dataDir));
  const result = repair(dataDir);

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Companion state:\s+unreadable \(authentication failed\)/);
  assert.match(result.stdout, /Docker access sidecar:\s+healthy/);
  assert.match(result.stdout, /Mobile state:\s+authenticated; binding check stopped at unreadable Companion state/);
  assert.match(result.stdout, /\[M04\] Mobile state authenticated, but unreadable Companion state blocks its binding check\./);
  assert.match(result.stdout, /Diagnosis: File-specific damage; SECRET_KEY is valid for this volume\./);
  assert.match(result.stdout, /Evidence: Docker access sidecar, Mobile state authenticated; Companion state did not\./);
  assert.match(result.stdout, /Action: Restore Companion state from this volume's backup before removing anything\./);
  assert.doesNotMatch(result.stdout, /would start/);
  assert.doesNotMatch(result.stdout, /Diagnosis: SECRET_KEY mismatch/);
  assert.doesNotMatch(result.stdout, NO_SECRETS);
});

test('corrupt mobile state: names the damaged file and clears the key', () => {
  const dataDir = tempDir();
  provision(dataDir);
  corruptOneByte(mobileFile(dataDir));
  const result = repair(dataDir);

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Companion state:\s+readable and authenticated with this SECRET_KEY/);
  assert.match(result.stdout, /Mobile state:\s+unreadable \(authentication failed\)/);
  assert.match(result.stdout, /Diagnosis: File-specific damage; SECRET_KEY is valid for this volume\./);
  assert.match(result.stdout, /Evidence: Companion state, Docker access sidecar authenticated; Mobile state did not\./);
  assert.match(result.stdout, /Action: Restore Mobile state from this volume's backup before removing anything\./);
  assert.match(result.stdout, /Mobile listener plan:\s+would start/);
  assert.doesNotMatch(result.stdout, /Diagnosis: SECRET_KEY mismatch/);
  assert.doesNotMatch(result.stdout, NO_SECRETS);
});

test('missing Docker access sidecar reports absence', () => {
  const dataDir = tempDir();
  provision(dataDir);
  rmSync(accessFile(dataDir));
  const result = repair(dataDir);

  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Docker access sidecar:\s+none on this volume/);
  assert.match(result.stdout, /Authenticated files:\s+Companion state, Mobile state \(2 of the 2 opened here\)/);
  assert.doesNotMatch(result.stdout, /Diagnosis:/);
});

test('missing main state reports binding failure without writes', () => {
  const dataDir = tempDir();
  provision(dataDir);
  rmSync(stateFile(dataDir));
  const result = repair(dataDir);

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Companion state:\s+none yet/);
  assert.match(result.stdout, /Mobile state:\s+present; not opened because its Companion state file is absent/);
  assert.match(result.stdout, /Installation binding:\s+not available; the bound Companion state is missing/);
  assert.match(result.stdout, /\[M03\].*Restore Companion state; keep the mobile sidecar\./);
  assert.doesNotMatch(result.stdout, /would start/);
  assert.throws(() => readFileSync(stateFile(dataDir)), /ENOENT/);
});

test('reports a foreign-installation sidecar as a binding mismatch', () => {
  const dataDir = tempDir();
  const other = tempDir();
  provision(dataDir);
  provision(other);
  writeFileSync(mobileFile(dataDir), readFileSync(mobileFile(other), 'utf8'));
  const result = repair(dataDir);

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Mobile state:\s+unreadable \(legacyInstallationId does not match this installation\)/);
  assert.match(result.stdout, /Installation binding:\s+mismatch; this sidecar belongs to another Companion installation/);
  assert.match(result.stdout, /requires deliberate clone-as-new replacement/);
  assert.doesNotMatch(result.stdout, /Diagnosis: SECRET_KEY mismatch/);
});

test('classifies a lone failed authenticated file as ambiguous', () => {
  const dataDir = tempDir();
  provision(dataDir);
  rmSync(accessFile(dataDir));
  rmSync(mobileFile(dataDir));
  corruptOneByte(stateFile(dataDir));
  const result = repair(dataDir);

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Diagnosis: SECRET_KEY mismatch or file damage; one file cannot distinguish them\./);
  assert.match(result.stdout, /Cause: Companion state is the only authenticated file present and rejected the key\./);
  assert.match(result.stdout, /Action: Confirm the original SECRET_KEY first\. Restore or remove the file only after the key is ruled out\./);
  assert.match(result.stdout, /\[A04\] Companion state is the only authenticated file and rejected the current key\./);
});

test('plaintext cron diagnosis leaves state unchanged', () => {
  const dataDir = tempDir();
  provision(dataDir);
  const stateKey = Buffer.from(hkdfSync('sha256', Buffer.from(KEY, 'hex'), Buffer.alloc(0), 'qm-companion:state', 32));
  const payload = JSON.stringify({
    installationId: randomUUID(), owner: null, services: [], prefs: {}, apiTokens: [], cron: [],
  });
  const mac = createHmac('sha256', stateKey).update('qm-companion:state:v2\0').update(payload, 'utf8').digest('hex');
  writeFileSync(stateFile(dataDir), `${JSON.stringify({ version: 2, payload, mac }, null, 2)}\n`);
  rmSync(mobileFile(dataDir));
  rmSync(accessFile(dataDir));
  const before = readFileSync(stateFile(dataDir), 'utf8');

  const result = repair(dataDir);
  assert.equal(readFileSync(stateFile(dataDir), 'utf8'), before, 'the stored file is byte-identical');
  assert.doesNotMatch(result.stdout, /was rewritten while this diagnosis ran/);
});

test('v1 migration marker authenticates independently', () => {
  const dataDir = tempDir();
  const legacy = {
    version: 1, installationId: randomUUID(), owner: null, services: [], prefs: {}, apiTokens: [], cron: null,
  };
  writeFileSync(join(dataDir, 'qm-companion.json'), `${JSON.stringify(legacy)}\n`);
  inState(dataDir, `
    const { getInstallationId } = await import('${url('src/store.js')}');
    getInstallationId();
  `, { MIGRATE_V1_STATE: 'true' });

  const healthy = repair(dataDir);
  assert.match(healthy.stdout, /V1 migration marker:\s+healthy; it authenticates with this SECRET_KEY/);

  const wrong = repair(dataDir, { SECRET_KEY: OTHER_KEY });
  assert.equal(wrong.status, 1, wrong.stdout);
  assert.match(wrong.stdout, /V1 migration marker:\s+present; authentication failed for this SECRET_KEY/);
  assert.match(wrong.stdout, /Diagnosis: SECRET_KEY mismatch/);
});
