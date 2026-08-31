import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


process.env.SECRET_KEY = 'ab'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-pairing-flow-'));
process.env.QM_HOST = 'nas.local';

const owner = await import('../src/mobile/enrolment-owner.js');
const pairing = await import('../src/mobile/enrolment.js');
const devices = await import('../src/mobile/devices.js');
const registry = await import('../src/mobile/enrolment-registry.js');
const protocol = await import('../src/mobile/protocol.js');
const { loadMobileState, updateMobileState } = await import('../src/mobile/store.js');
const { parseSealedEnvelope } = await import('../src/mobile/envelope.js');

const SERVER = { origin: 'https://nas.local:8788', tlsLeafFingerprint: 'cc'.repeat(32) };
const SCOPES = ['containers.read', 'summary.read'];

function phone() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    nonce: randomBytes(16).toString('base64url'),
  };
}

function claimBody(pairingKey, p, extra = {}) {
  return { pairingKey, claimEncryptionPublicKey: p.pub, clientNonce: p.nonce, deviceName: 'Test iPhone', requestedScopes: SCOPES, ...extra };
}

async function pairDevice() {
  const created = owner.createEnrolment();
  assert.equal(created.ok, true);
  const p = phone();
  const claimed = pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p));
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const approved = await pairing.approveEnrolment(created.enrolmentId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const grant = pairing.retrieveGrant(created.enrolmentId);
  const tBytes = Buffer.from(claimed.body.transcript, 'base64url');
  const plain = await protocol.openGrant(p.priv, grant.body.envelope, protocol.transcriptHash(tBytes));
  const wrapper = JSON.parse(plain.toString('utf8'));
  const ack = pairing.acknowledgeEnrolment(created.enrolmentId, wrapper.grant.ackSecret, SERVER.tlsLeafFingerprint);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  return { created, p, claimed, wrapper, ack };
}

test('completes claim, approval, retrieval and acknowledgement', async () => {
  registry.resetEnrolmentsForTest();
  const created = owner.createEnrolment();
  assert.match(created.pairingKey, /^qmp_[A-Za-z0-9_-]{43}$/);
  assert.equal(pairing.enrolmentStatus(created.enrolmentId).state, 'created');
  const p = phone();

  const claimed = pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p));
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(claimed.body.state, 'awaiting_owner_approval');
  const tBytes = Buffer.from(claimed.body.transcript, 'base64url');
  const transcript = JSON.parse(tBytes.toString('utf8'));
  const state = loadMobileState();
  assert.equal(transcript.origin, SERVER.origin);
  assert.equal(transcript.mobileInstallationId, state.mobileInstallationId);
  assert.equal(transcript.claimEncryptionPublicKey, p.pub);
  assert.equal(transcript.deviceName, 'Test iPhone');
  assert.equal(protocol.verifyTranscript(state.identity.publicKey, tBytes, claimed.body.transcriptSignature), true);
  assert.equal(state.spentCapabilities.length, 1);
  assert.equal(state.spentCapabilities[0].enrolmentId, created.enrolmentId);
  assert.equal(state.spentCapabilities[0].transcriptHash, protocol.transcriptHash(tBytes).toString('hex'));
  assert.equal(state.spentCapabilities[0].claimEncryptionKeyHandle, createHash('sha256').update(Buffer.from(p.pub, 'base64url')).digest('hex'));
  assert.deepEqual(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p)).body, claimed.body);
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, phone())).code, 'already_claimed');
  const view = owner.enrolmentForOwner(created.enrolmentId);
  assert.deepEqual(view.sasWords, protocol.deriveSas(protocol.transcriptHash(tBytes)).words);
  assert.equal(view.transcript.deviceName, 'Test iPhone');
  assert.deepEqual(Object.keys(pairing.enrolmentStatus(created.enrolmentId)).sort(), ['expiresAt', 'state', 'v']);
  assert.equal(pairing.retrieveGrant(created.enrolmentId).code, 'not_ready');

  const approved = await pairing.approveEnrolment(created.enrolmentId);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(pairing.enrolmentStatus(created.enrolmentId).state, 'grant_ready');
  assert.equal((await pairing.approveEnrolment(created.enrolmentId)).code, 'not_pending');

  const grant1 = pairing.retrieveGrant(created.enrolmentId);
  const grant2 = pairing.retrieveGrant(created.enrolmentId);
  assert.equal(grant1.ok, true);
  assert.equal(grant1.body.envelope, grant2.body.envelope);
  assert.equal(parseSealedEnvelope(grant1.body.envelope).ok, true);
  assert.equal(pairing.enrolmentStatus(created.enrolmentId).state, 'delivered');
  assert.equal(loadMobileState().devices.length, 0);

  const plain = await protocol.openGrant(p.priv, grant1.body.envelope, protocol.transcriptHash(tBytes));
  const wrapper = JSON.parse(plain.toString('utf8'));
  assert.equal(protocol.verifyGrant(state.identity.publicKey, protocol.grantBytes(wrapper.grant), wrapper.signature), true);
  assert.equal(wrapper.grant.transcriptHash, protocol.transcriptHash(tBytes).toString('hex'));
  assert.deepEqual(wrapper.grant.scopes, SCOPES);
  await assert.rejects(protocol.openGrant(p.priv, grant1.body.envelope, Buffer.alloc(32, 1)));

  assert.equal(pairing.acknowledgeEnrolment(created.enrolmentId, randomBytes(32).toString('base64url'), SERVER.tlsLeafFingerprint).code, 'invalid_acknowledgement');
  const ack = pairing.acknowledgeEnrolment(created.enrolmentId, wrapper.grant.ackSecret, SERVER.tlsLeafFingerprint);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.body.deviceId, wrapper.grant.deviceId);
  const after = loadMobileState();
  assert.equal(after.devices.length, 1);
  assert.equal(after.devices[0].deviceId, wrapper.grant.deviceId);
  assert.equal(after.devices[0].revokedAt, null);
  const dump = JSON.stringify(after);
  for (const secret of [wrapper.grant.accessToken, wrapper.grant.refreshGrant, wrapper.grant.ackSecret, created.pairingKey]) {
    assert.equal(dump.includes(secret), false);
    assert.equal(dump.includes(secret.slice(4)), false);
  }
  registry.resetEnrolmentsForTest();
  assert.deepEqual(pairing.acknowledgeEnrolment(created.enrolmentId, wrapper.grant.ackSecret, SERVER.tlsLeafFingerprint).body, ack.body);
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, phone())).code, 'already_claimed');
  assert.equal(owner.createEnrolment().ok, true);
});

test('rejects activation and expires pending enrolments after restart', async () => {
  registry.resetEnrolmentsForTest();
  const created = owner.createEnrolment();
  const p = phone();
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p)).ok, true);
  assert.equal(owner.rejectEnrolment(created.enrolmentId).state, 'rejected');
  assert.equal((await pairing.approveEnrolment(created.enrolmentId)).code, 'not_pending');
  assert.equal(pairing.enrolmentStatus(created.enrolmentId).expiresAt, null);
  const second = owner.createEnrolment();
  registry.resetEnrolmentsForTest();
  assert.equal(pairing.enrolmentStatus(second.enrolmentId).state, 'expired');
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(second.pairingKey, phone())).code, 'invalid_pairing_key');
});

test('preserves pairing capability after invalid claims', () => {
  registry.resetEnrolmentsForTest();
  const created = owner.createEnrolment();
  const p = phone();
  const spentBefore = loadMobileState().spentCapabilities.length;
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p, { candidateOrigin: 'https://other:8788' })).code, 'origin_mismatch');
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p, { candidateFingerprint: 'dd'.repeat(32) })).code, 'identity_mismatch');
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p, { requestedScopes: ['containers.write'] })).code, 'invalid_claim');
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p, { claimEncryptionPublicKey: 'nope' })).code, 'invalid_claim');
  assert.equal(pairing.claimEnrolment(SERVER, claimBody('qmd_' + 'A'.repeat(43), p)).code, 'invalid_pairing_key');
  assert.equal(loadMobileState().spentCapabilities.length, spentBefore);
  assert.equal(pairing.enrolmentStatus(created.enrolmentId).state, 'created');
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p)).ok, true);
});

test('enforces access scope, rotation reuse and device revocation', async () => {
  registry.resetEnrolmentsForTest();
  const { wrapper } = await pairDevice();
  const g = wrapper.grant;
  assert.equal(devices.authenticateAccess(`Bearer ${g.accessToken}`, 'summary.read').ok, true);
  assert.equal(devices.authenticateAccess(`Bearer ${g.accessToken}`, 'events.read').code, 'forbidden');
  assert.equal(devices.authenticateAccess(`Bearer ${g.refreshGrant}`, 'summary.read').code, 'unauthorized');
  assert.equal(devices.authenticateAccess('Bearer qmc_' + 'a'.repeat(48), 'summary.read').code, 'unauthorized');
  assert.equal(devices.refreshTokens(g.accessToken, randomBytes(16).toString('base64url')).code, 'unauthorized');

  const rid = randomBytes(16).toString('base64url');
  const r1 = devices.refreshTokens(g.refreshGrant, rid);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.body.tokenFamilyGeneration, 2);
  assert.equal(devices.authenticateAccess(`Bearer ${g.accessToken}`, 'summary.read').code, 'unauthorized');
  assert.equal(devices.authenticateAccess(`Bearer ${r1.body.accessToken}`, 'summary.read').ok, true);
  assert.deepEqual(devices.refreshTokens(g.refreshGrant, rid).body, r1.body);
  updateMobileState((st) => {
    const d = st.devices.find((x) => x.deviceId === g.deviceId);
    d.lookback.expiresAt = Date.now() - 36 * 60 * 60 * 1000;
  });
  assert.deepEqual(
    devices.refreshTokens(g.refreshGrant, rid).body,
    r1.body,
  );
  assert.equal(
    devices.listDevices().find((d) => d.deviceId === g.deviceId).status,
    'active',
    'and the family is untouched',
  );
  const thief = await pairDevice();
  const tRid = randomBytes(16).toString('base64url');
  const tR1 = devices.refreshTokens(thief.wrapper.grant.refreshGrant, tRid);
  assert.equal(tR1.ok, true);
  updateMobileState((st) => {
    const d = st.devices.find((x) => x.deviceId === thief.wrapper.grant.deviceId);
    d.lookback.expiresAt = Date.now() - 36 * 60 * 60 * 1000;
  });
  assert.equal(
    devices.refreshTokens(thief.wrapper.grant.refreshGrant, randomBytes(16).toString('base64url')).code,
    'revoked',
  );
  const r2 = devices.refreshTokens(r1.body.refreshGrant, randomBytes(16).toString('base64url'));
  assert.equal(r2.ok, true);
  assert.equal(devices.refreshTokens(g.refreshGrant, rid).code, 'unauthorized');
  assert.equal(devices.refreshTokens(r1.body.refreshGrant, randomBytes(16).toString('base64url')).code, 'revoked');
  assert.equal(devices.authenticateAccess(`Bearer ${r2.body.accessToken}`, 'summary.read').code, 'revoked');
  assert.equal(devices.refreshTokens(r2.body.refreshGrant, randomBytes(16).toString('base64url')).code, 'revoked');
  assert.match(devices.listDevices().find((d) => d.deviceId === g.deviceId).status, /revoked \(reuse\)/);

  const second = await pairDevice();
  const token = second.wrapper.grant.accessToken;
  assert.equal(devices.authenticateAccess(`Bearer ${token}`, 'containers.read').ok, true);
  assert.equal(devices.renameDevice(second.wrapper.grant.deviceId, '  Kitchen iPad ').ok, true);
  assert.equal(devices.listDevices().find((d) => d.deviceId === second.wrapper.grant.deviceId).deviceName, 'Kitchen iPad');
  assert.equal(devices.forgetDevice(second.wrapper.grant.deviceId).code, 'still_active');
  assert.equal(devices.revokeDevice(second.wrapper.grant.deviceId).ok, true);
  assert.equal(devices.authenticateAccess(`Bearer ${token}`, 'containers.read').code, 'revoked');
  assert.equal(devices.refreshTokens(second.wrapper.grant.refreshGrant, randomBytes(16).toString('base64url')).code, 'revoked');
  assert.equal(devices.forgetDevice(second.wrapper.grant.deviceId).ok, true);
  assert.equal(devices.revokeDevice('AAAAAAAAAAAAAAAAAAAAAA').code, 'not_found');
});

test('processes and durably consumes scanned qme capabilities', async () => {
  registry.resetEnrolmentsForTest();
  assert.throws(() => owner.createEnrolment({ family: 'qmd' }), /family/);
  const created = owner.createEnrolment({ family: 'qme' });
  assert.equal(created.ok, true);
  assert.equal(created.family, 'qme');
  assert.match(created.pairingKey, /^qme_[A-Za-z0-9_-]{43}$/);
  assert.equal(pairing.enrolmentStatus(created.enrolmentId).state, 'created');
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(`qmp_${created.pairingKey.slice(4)}`, phone())).code, 'invalid_pairing_key');
  const p = phone();
  const claimed = pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, p));
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(claimed.body.state, 'awaiting_owner_approval');
  const tBytes = Buffer.from(claimed.body.transcript, 'base64url');
  const spent = loadMobileState().spentCapabilities.find((e) => e.enrolmentId === created.enrolmentId);
  assert.equal(spent.family, 'qme');
  assert.equal(spent.transcriptHash, protocol.transcriptHash(tBytes).toString('hex'));
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, phone())).code, 'already_claimed');
  assert.equal((await pairing.approveEnrolment(created.enrolmentId)).ok, true);
  const grant = pairing.retrieveGrant(created.enrolmentId);
  assert.equal(grant.ok, true);
  const wrapper = JSON.parse((await protocol.openGrant(p.priv, grant.body.envelope, protocol.transcriptHash(tBytes))).toString('utf8'));
  const ack = pairing.acknowledgeEnrolment(created.enrolmentId, wrapper.grant.ackSecret, SERVER.tlsLeafFingerprint);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const after = loadMobileState();
  assert.ok(after.devices.some((d) => d.deviceId === wrapper.grant.deviceId && d.revokedAt === null));
  assert.equal(JSON.stringify(after).includes(created.pairingKey.slice(4)), false, 'the qme is stored as a digest only');
  registry.resetEnrolmentsForTest();
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(created.pairingKey, phone())).code, 'already_claimed');
  assert.equal(pairing.claimEnrolment(SERVER, claimBody(`qmp_${created.pairingKey.slice(4)}`, phone())).code, 'invalid_pairing_key');
});
