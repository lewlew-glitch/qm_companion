import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';


process.env.SECRET_KEY = 'b3'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-cert-approval-'));
process.env.QM_HOST = 'nas.local';

const DATA_DIR = process.env.DATA_DIR;
const ROOT = join(import.meta.dirname, '..');
const SIDECAR = join(DATA_DIR, 'qm-mobile-v1.json');

const { ROTATE_COMMAND, ensureMobileCertificate, fingerprintOf, rotateMobileCertificate, tlsPaths } = await import('../src/mobile/cert.js');
const { buildSelfSignedCertificate } = await import('../src/mobile/x509.js');
const devices = await import('../src/mobile/devices.js');
const { updateMobileState } = await import('../src/mobile/store.js');
const { digestToken, mintToken, parseToken } = await import('../src/mobile/token-family.js');

const paths = tlsPaths(DATA_DIR);
const hex = () => randomBytes(32).toString('hex');
const id = () => randomBytes(16).toString('base64url');

function seedDevice(name, leaf) {
  const accessToken = mintToken('qmd');
  const refreshGrant = mintToken('qmr');
  const at = Date.now();
  const deviceId = id();
  updateMobileState((s) => {
    s.devices.push({
      accessTokenDigest: digestToken('qmd', parseToken(accessToken).bytes),
      accessTokenExpiresAt: at + 15 * 60 * 1000,
      ackRecoveryExpiresAt: null,
      ackSecretDigest: hex(),
      claimEncryptionKeyHandle: hex(),
      createdAt: at,
      deviceId,
      deviceName: name,
      enrolmentId: id(),
      lastSeenAt: at,
      lookback: null,
      refreshAbsoluteDeadlineAt: at + 90 * 24 * 60 * 60 * 1000,
      refreshDigest: digestToken('qmr', parseToken(refreshGrant).bytes),
      refreshIdleDeadlineAt: at + 30 * 24 * 60 * 60 * 1000,
      revokedAt: null,
      revokedReason: null,
      scopes: ['summary.read'],
      tlsLeafFingerprint: leaf,
      tokenFamilyGeneration: 1,
      transcriptHash: hex(),
    });
  });
  return { deviceId, accessToken, refreshGrant };
}

function storedDevices() {
  return JSON.parse(JSON.parse(readFileSync(SIDECAR, 'utf8')).payload).devices;
}

function rotate(origin, args = ['--confirm']) {
  return spawnSync(process.execPath, ['src/mobile/rotate-cert.js', ...args], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR, QM_ADVERTISED_ORIGIN: origin },
    encoding: 'utf8',
  });
}

test('rejects an unapproved origin change without file writes', () => {
  const first = ensureMobileCertificate({ dataDir: DATA_DIR, host: 'nas.local' });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.source, 'generated');
  const before = readFileSync(paths.certPath, 'utf8');
  const { deviceId } = seedDevice('Test iPhone', first.fingerprint);

  const moved = ensureMobileCertificate({ dataDir: DATA_DIR, host: 'moved.local' });
  assert.equal(moved.ok, false);
  assert.equal(moved.code, 'host_changed');
  assert.ok(moved.reason.includes(ROTATE_COMMAND), moved.reason);
  assert.match(moved.reason, /revokes every paired device/);
  assert.match(moved.reason, /re-pair every phone/);

  assert.equal(readFileSync(paths.certPath, 'utf8'), before, 'no silent rotation: the leaf is untouched');
  assert.equal(JSON.parse(readFileSync(paths.recordPath, 'utf8')).host, 'nas.local');
  assert.equal(existsSync(paths.pendingDir), false);
  assert.equal(storedDevices().find((d) => d.deviceId === deviceId).revokedAt, null, 'and no phone is punished for a refusal');

  const dry = rotate('https://moved.local:8788', []);
  assert.equal(dry.status, 2);
  assert.match(dry.stdout, /revokes every paired device/);
  assert.match(dry.stdout, /--confirm/);
  assert.equal(readFileSync(paths.certPath, 'utf8'), before);
  assert.equal(storedDevices().find((d) => d.deviceId === deviceId).revokedAt, null);
});

test('rotates generated certificates and revokes device families', () => {
  const before = ensureMobileCertificate({ dataDir: DATA_DIR, host: 'nas.local' });
  assert.equal(before.ok, true, before.reason);
  const paired = storedDevices().filter((d) => d.revokedAt === null);
  assert.ok(paired.length >= 1);

  const run = rotate('https://moved.local:8788');
  assert.equal(run.status, 0, run.stdout + run.stderr);

  const after = ensureMobileCertificate({ dataDir: DATA_DIR, host: 'moved.local' });
  assert.equal(after.ok, true, after.reason);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.source, 'generated');
  assert.match(run.stdout, new RegExp(`New fingerprint:\\s+${after.fingerprint}`));
  assert.match(run.stdout, new RegExp(`Revoked ${paired.length} of ${storedDevices().length} paired device families`));
  assert.match(run.stdout, /re-pair every phone/);
  assert.doesNotMatch(run.stdout, /PRIVATE KEY|qmd_|qmr_/, 'no secret material is ever printed');

  for (const device of storedDevices()) {
    assert.notEqual(device.revokedAt, null, `${device.deviceName} must not outlive the certificate it paired against`);
    assert.equal(device.revokedReason, 'owner');
    assert.equal(device.lookback, null);
  }
});

test('does not regenerate owner-supplied TLS material', () => {
  const ownerDir = mkdtempSync(join(tmpdir(), 'qm-cert-owner-'));
  const ownerPaths = tlsPaths(ownerDir);
  mkdirSync(ownerPaths.dir, { recursive: true });
  const own = buildSelfSignedCertificate({ host: 'owner.local' });
  writeFileSync(ownerPaths.certPath, own.certPem);
  writeFileSync(ownerPaths.keyPath, own.keyPem);
  assert.equal(ensureMobileCertificate({ dataDir: ownerDir, host: 'owner.local' }).source, 'owner');

  const moved = ensureMobileCertificate({ dataDir: ownerDir, host: 'moved.local' });
  assert.equal(moved.code, 'host_mismatch');
  assert.doesNotMatch(moved.reason, /rotate-cert/);

  const refused = rotateMobileCertificate({ dataDir: ownerDir, host: 'moved.local' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'owner');
  assert.match(refused.reason, /owner-supplied/);
  assert.match(refused.reason, /never regenerates owner material/);
  assert.match(refused.reason, /names moved\.local/);

  const viaCommand = spawnSync(process.execPath, ['src/mobile/rotate-cert.js', '--confirm'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: ownerDir, QM_ADVERTISED_ORIGIN: 'https://moved.local:8788' },
    encoding: 'utf8',
  });
  assert.equal(viaCommand.status, 1);
  assert.match(viaCommand.stdout, /Cannot rotate: mobile\.crt under .* is owner-supplied/);

  assert.equal(readFileSync(ownerPaths.certPath, 'utf8'), own.certPem);
  assert.equal(readFileSync(ownerPaths.keyPath, 'utf8'), own.keyPem);
  assert.equal(existsSync(ownerPaths.recordPath), false);
  assert.equal(existsSync(join(ownerDir, 'qm-mobile-v1.json')), false);
  rmSync(ownerDir, { recursive: true, force: true });
});

test('rejects pre-rotation grants on access and refresh', () => {
  const oldLeaf = hex();
  devices.bindDeviceTlsLeaf(oldLeaf);
  const stale = seedDevice('Paired before the rotation', oldLeaf);
  assert.equal(devices.authenticateAccess(`Bearer ${stale.accessToken}`, 'summary.read').ok, true, 'baseline: it works against the leaf it paired to');

  const newLeaf = hex();
  devices.bindDeviceTlsLeaf(newLeaf);

  const access = devices.authenticateAccess(`Bearer ${stale.accessToken}`, 'summary.read');
  assert.notEqual(access.ok, true);
  assert.equal(access.code, 'repair_required');
  assert.equal(access.status, 401);
  assert.match(access.message, /server certificate that has since been replaced/);
  assert.match(access.message, /Pair the device again from the Devices page/);
  assert.equal(access.device, undefined);

  const refresh = devices.refreshTokens(stale.refreshGrant, randomBytes(16).toString('base64url'));
  assert.notEqual(refresh.ok, true);
  assert.equal(refresh.code, 'repair_required');
  assert.equal(refresh.body, undefined);
  assert.doesNotMatch(JSON.stringify(refresh), /qmd_|qmr_/);

  const record = storedDevices().find((d) => d.deviceId === stale.deviceId);
  assert.equal(record.revokedAt, null);
  const repaired = seedDevice('Paired again after the rotation', newLeaf);
  assert.equal(devices.authenticateAccess(`Bearer ${repaired.accessToken}`, 'summary.read').ok, true);
  devices.resetDeviceTlsLeafForTest();
});

test('reports a failed revocation without changing the certificate', () => {
  const brokenDir = mkdtempSync(join(tmpdir(), 'qm-cert-broken-'));
  const before = ensureMobileCertificate({ dataDir: brokenDir, host: 'nas.local' });
  assert.equal(before.ok, true, before.reason);

  const envelope = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  const flipped = envelope.mac[0] === '0' ? '1' : '0';
  writeFileSync(join(brokenDir, 'qm-mobile-v1.json'), JSON.stringify({ ...envelope, mac: `${flipped}${envelope.mac.slice(1)}` }));

  const run = spawnSync(process.execPath, ['src/mobile/rotate-cert.js', '--confirm'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: brokenDir, QM_ADVERTISED_ORIGIN: 'https://moved.local:8788' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 1, 'a half done approval is not a success');
  assert.match(run.stdout, /The certificate was replaced/);
  assert.match(run.stdout, /paired-device revocation failed/);
  assert.match(run.stdout, /Devices page/, 'and where to finish the job by hand');
  assert.doesNotMatch(run.stdout, /PRIVATE KEY|qmd_|qmr_/);
  assert.doesNotMatch(run.stdout, new RegExp(envelope.mac), 'no state content reaches the output');

  const after = ensureMobileCertificate({ dataDir: brokenDir, host: 'moved.local' });
  assert.equal(after.ok, true, after.reason);
  assert.notEqual(after.fingerprint, before.fingerprint, 'the replacement remains committed');
  rmSync(brokenDir, { recursive: true, force: true });
});

test('declares the leaf served by the running listener', async () => {
  devices.resetDeviceTlsLeafForTest();
  rmSync(paths.dir, { recursive: true, force: true });
  const port = await new Promise((resolve) => {
    const probe = createTcpServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  process.env.MOBILE_API_ENABLED = 'true';
  process.env.MOBILE_ENROLMENT_ENABLED = 'true';
  process.env.MOBILE_PORT = String(port);
  process.env.MOBILE_BIND_ADDRESS = '127.0.0.1';
  process.env.QM_ADVERTISED_ORIGIN = `https://127.0.0.1:${port}`;

  const { startMobileListener, resetMobileListenerStatus } = await import('../src/mobile/listener.js');
  resetMobileListenerStatus();
  const orphan = seedDevice('Paired to a certificate that is gone', hex());
  const lines = [];
  const started = await startMobileListener({ log: (l) => lines.push(l) });
  assert.ok(started, lines.join(''));
  try {
    const refused = devices.authenticateAccess(`Bearer ${orphan.accessToken}`, 'summary.read');
    assert.equal(refused.code, 'repair_required', 'the running listener enforces its own leaf');
    const current = seedDevice('Paired to the leaf on the wire', started.tlsLeafFingerprint);
    assert.equal(devices.authenticateAccess(`Bearer ${current.accessToken}`, 'summary.read').ok, true);
  } finally {
    started.server.closeAllConnections();
    await new Promise((resolve) => started.server.close(resolve));
    devices.resetDeviceTlsLeafForTest();
  }
});
