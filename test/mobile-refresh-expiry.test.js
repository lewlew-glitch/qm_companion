import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


process.env.SECRET_KEY = 'a7'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-refresh-expiry-'));
process.env.QM_HOST = 'nas.local';

const devices = await import('../src/mobile/devices.js');
const { loadMobileState, updateMobileState } = await import('../src/mobile/store.js');
const { digestToken, mintToken, parseToken } = await import('../src/mobile/token-family.js');

const hex = () => randomBytes(32).toString('hex');
const id = () => randomBytes(16).toString('base64url');
const rid = () => randomBytes(16).toString('base64url');

function seedDevice(name) {
  const refreshGrant = mintToken('qmr');
  const at = Date.now();
  const deviceId = id();
  updateMobileState((s) => {
    s.devices.push({
      accessTokenDigest: hex(),
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
      tlsLeafFingerprint: hex(),
      tokenFamilyGeneration: 1,
      transcriptHash: hex(),
    });
  });
  return { deviceId, refreshGrant };
}

function deviceOf(deviceId) {
  return loadMobileState().devices.find((d) => d.deviceId === deviceId);
}

function poke(deviceId, fields) {
  updateMobileState((s) => {
    Object.assign(s.devices.find((d) => d.deviceId === deviceId), fields);
  });
}

function pokeLookback(deviceId, fields) {
  updateMobileState((s) => {
    Object.assign(s.devices.find((d) => d.deviceId === deviceId).lookback, fields);
  });
}

for (const deadline of ['refreshIdleDeadlineAt', 'refreshAbsoluteDeadlineAt']) {
  test(`family past its ${deadline} is refused the cached successor`, () => {
    const { deviceId, refreshGrant } = seedDevice(`Expiry ${deadline}`);
    const requestId = rid();
    const rotated = devices.refreshTokens(refreshGrant, requestId);
    assert.equal(rotated.ok, true, JSON.stringify(rotated));
    assert.equal(deviceOf(deviceId).lookback.rotationRequestId, requestId);

    poke(deviceId, { [deadline]: Date.now() - 1 });

    const replay = devices.refreshTokens(refreshGrant, requestId);
    assert.notEqual(replay.ok, true);
    assert.equal(replay.code, 'repair_required');
    assert.equal(replay.status, 401);
    assert.match(replay.message, /paired again/);
    assert.equal(replay.body, undefined);
    assert.doesNotMatch(JSON.stringify(replay), /qmd_|qmr_/, 'no grant material leaves this path');

    const after = deviceOf(deviceId);
    assert.notEqual(after.revokedAt, null);
    assert.equal(after.revokedReason, 'expired');
    assert.equal(after.lookback, null);

    assert.equal(devices.refreshTokens(rotated.body.refreshGrant, rid()).code, 'revoked');
    assert.equal(devices.authenticateAccess(`Bearer ${rotated.body.accessToken}`, 'summary.read').code, 'revoked');
  });
}

test("replays a live family's cache after the lookback window", () => {
  const { deviceId, refreshGrant } = seedDevice('Suspended iPhone');
  const requestId = rid();
  const rotated = devices.refreshTokens(refreshGrant, requestId);
  assert.equal(rotated.ok, true, JSON.stringify(rotated));

  pokeLookback(deviceId, { expiresAt: Date.now() - 6 * 60 * 60 * 1000 });
  const replay = devices.refreshTokens(refreshGrant, requestId);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.deepEqual(replay.body, rotated.body, 'retry returns the cached rotation response');
  assert.equal(deviceOf(deviceId).revokedAt, null);
});

test('rotationRequestId reuse revokes the token family', () => {
  const { deviceId, refreshGrant } = seedDevice('Stolen grant');
  const rotated = devices.refreshTokens(refreshGrant, rid());
  assert.equal(rotated.ok, true);
  const thief = devices.refreshTokens(refreshGrant, rid());
  assert.equal(thief.code, 'revoked');
  assert.match(thief.message, /reused/);
  assert.equal(deviceOf(deviceId).revokedReason, 'reuse');
});

test('reports a revoked family instead of replaying its cache', () => {
  const { deviceId, refreshGrant } = seedDevice('Revoked by owner');
  const requestId = rid();
  assert.equal(devices.refreshTokens(refreshGrant, requestId).ok, true);
  poke(deviceId, { revokedAt: Date.now() - 1000, revokedReason: 'owner' });
  const replay = devices.refreshTokens(refreshGrant, requestId);
  assert.equal(replay.code, 'revoked');
  assert.equal(replay.body, undefined);
  assert.equal(deviceOf(deviceId).revokedReason, 'owner', 'an owner revocation is not relabelled as reuse');
});

test('a family inside both deadlines replays its cached successor', () => {
  const { deviceId, refreshGrant } = seedDevice('Just inside');
  const requestId = rid();
  const rotated = devices.refreshTokens(refreshGrant, requestId);
  assert.equal(rotated.ok, true);
  poke(deviceId, { refreshIdleDeadlineAt: Date.now() + 1000, refreshAbsoluteDeadlineAt: Date.now() + 1000 });
  assert.deepEqual(devices.refreshTokens(refreshGrant, requestId).body, rotated.body);
});
