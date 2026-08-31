import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


process.env.SECRET_KEY = 'cd'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-routes-'));
process.env.QM_HOST = 'nas.local';

const { createMobileRouter, resetMobileLimitersForTest } = await import('../src/mobile/routes.js');
const owner = await import('../src/mobile/enrolment-owner.js');
const pairing = await import('../src/mobile/enrolment.js');
const protocol = await import('../src/mobile/protocol.js');
const { loadMobileState } = await import('../src/mobile/store.js');

const SERVER = { origin: 'https://nas.local:8788', tlsLeafFingerprint: 'ee'.repeat(32) };

function listen(flags) {
  const route = createMobileRouter(SERVER, flags);
  const server = createServer((req, res) => route(req, res).catch(() => res.end()));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function call(base, method, path, { body, headers } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, text };
}

test('disabled enrolment routes return the fixed 404 envelope', async () => {
  resetMobileLimitersForTest();
  const { server, base } = await listen({ enrolment: false });
  try {
    const r = await call(base, 'POST', '/api/mobile/v1/enrolments/claim', { body: { v: 1 } });
    assert.equal(r.status, 404);
    assert.deepEqual(Object.keys(r.body).sort(), ['error', 'v']);
    assert.equal(r.body.error.code, 'not_found');
    assert.equal(r.headers.get('cache-control'), 'no-store, max-age=0');
    const unknown = await call(base, 'GET', '/api/mobile/v1/devices');
    assert.equal(unknown.status, 404);
    const identity = await call(base, 'GET', `/api/mobile/v1/identity?challenge=${randomBytes(32).toString('base64url')}`);
    assert.equal(identity.status, 200);
  } finally {
    server.close();
  }
});

test('identity response excludes device and Docker data', async () => {
  resetMobileLimitersForTest();
  const { server, base } = await listen({ enrolment: true });
  try {
    for (const bad of ['', 'short', randomBytes(31).toString('base64url'), `${randomBytes(32).toString('base64url').slice(0, -1)}=`]) {
      const r = await call(base, 'GET', `/api/mobile/v1/identity?challenge=${bad}`);
      assert.equal(r.status, 400, bad);
      assert.equal(r.text.includes(bad) && bad.length > 0, false);
    }
    const challenge = randomBytes(32);
    const r = await call(base, 'GET', `/api/mobile/v1/identity?challenge=${challenge.toString('base64url')}`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['apiMajor', 'challenge', 'issuedAt', 'legacyInstallationId', 'mobileInstallationId', 'serverSigningFingerprint', 'serverSigningPublicKey', 'signature', 'v']);
    const state = loadMobileState();
    const bytes = protocol.identitySignedBytes({ mobileInstallationId: state.mobileInstallationId, publicKeyRaw: Buffer.from(r.body.serverSigningPublicKey, 'base64url'), challenge, issuedAt: r.body.issuedAt });
    assert.equal(protocol.verifyIdentity(state.identity.publicKey, bytes, r.body.signature), true);
    assert.equal(r.body.apiMajor, 1);
  } finally {
    server.close();
  }
});

test('HTTP pairing followed by bearer reads enforces token exclusions', async () => {
  resetMobileLimitersForTest();
  const { server, base } = await listen({ enrolment: true });
  try {
    const created = owner.createEnrolment();
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
    const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    const nonce = randomBytes(16).toString('base64url');
    const claimBody = { v: 1, pairingKey: created.pairingKey, claimEncryptionPublicKey: pub, clientNonce: nonce, deviceName: 'HTTP iPhone', requestedScopes: ['summary.read'], candidateOrigin: SERVER.origin };

    const bad = await call(base, 'POST', '/api/mobile/v1/enrolments/claim', { body: { ...claimBody, pairingKey: 'qmp_' + 'B'.repeat(43) } });
    assert.equal(bad.status, 401);
    assert.equal(bad.text.includes('B'.repeat(43)), false);
    const claimed = await call(base, 'POST', '/api/mobile/v1/enrolments/claim', { body: claimBody });
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(claimed.body.state, 'awaiting_owner_approval');
    const retry = await call(base, 'POST', '/api/mobile/v1/enrolments/claim', { body: claimBody });
    assert.deepEqual(retry.body, claimed.body);

    const status = await call(base, 'POST', '/api/mobile/v1/enrolments/status', { body: { v: 1, enrolmentId: claimed.body.enrolmentId } });
    assert.deepEqual(status.body, { v: 1, state: 'awaiting_owner_approval', expiresAt: claimed.body.expiresAt });
    const unknown = await call(base, 'POST', '/api/mobile/v1/enrolments/status', { body: { v: 1, enrolmentId: randomBytes(16).toString('base64url') } });
    assert.deepEqual(unknown.body, { v: 1, state: 'expired', expiresAt: null });
    assert.equal((await call(base, 'POST', '/api/mobile/v1/enrolments/grant', { body: { v: 1, enrolmentId: claimed.body.enrolmentId } })).status, 409);

    assert.equal((await pairing.approveEnrolment(claimed.body.enrolmentId)).ok, true);
    const grant = await call(base, 'POST', '/api/mobile/v1/enrolments/grant', { body: { v: 1, enrolmentId: claimed.body.enrolmentId } });
    assert.equal(grant.status, 200, grant.text);
    const tBytes = Buffer.from(claimed.body.transcript, 'base64url');
    const wrapper = JSON.parse((await protocol.openGrant(priv, grant.body.envelope, protocol.transcriptHash(tBytes))).toString('utf8'));
    const g = wrapper.grant;

    const badAck = await call(base, 'POST', '/api/mobile/v1/enrolments/acknowledge', { body: { v: 1, enrolmentId: claimed.body.enrolmentId, ackSecret: randomBytes(32).toString('base64url') } });
    assert.equal(badAck.status, 401);
    const ack = await call(base, 'POST', '/api/mobile/v1/enrolments/acknowledge', { body: { v: 1, enrolmentId: claimed.body.enrolmentId, ackSecret: g.ackSecret } });
    assert.equal(ack.status, 200, ack.text);
    assert.deepEqual(ack.body, { v: 1, enrolmentId: claimed.body.enrolmentId, state: 'acknowledged', deviceId: g.deviceId });

    const meta = await call(base, 'GET', '/api/mobile/v1/meta', { headers: { authorization: `Bearer ${g.accessToken}` } });
    assert.equal(meta.status, 200, meta.text);
    assert.equal(meta.body.device.deviceId, g.deviceId);
    const summary = await call(base, 'GET', '/api/mobile/v1/summary', { headers: { authorization: `Bearer ${g.accessToken}` } });
    assert.equal(summary.status, 200, summary.text);
    assert.equal(summary.body.v, 1);
    assert.ok(['available', 'unavailable'].includes(summary.body.docker));
    assert.equal((await call(base, 'GET', '/api/mobile/v1/containers', { headers: { authorization: `Bearer ${g.accessToken}` } })).status, 403);
    assert.equal((await call(base, 'GET', '/api/mobile/v1/summary')).status, 401);
    assert.equal((await call(base, 'GET', '/api/mobile/v1/summary', { headers: { authorization: `Bearer ${g.refreshGrant}` } })).status, 401);
    assert.equal((await call(base, 'GET', '/api/mobile/v1/summary', { headers: { authorization: `Bearer qmc_${'a'.repeat(48)}` } })).status, 401);
    assert.equal((await call(base, 'GET', '/api/mobile/v1/summary', { headers: { cookie: 'qm_session=anything' } })).status, 401);
    assert.equal((await call(base, 'POST', '/api/mobile/v1/token/refresh', { body: { v: 1, refreshGrant: g.accessToken, rotationRequestId: randomBytes(16).toString('base64url') } })).status, 401);
    const rotated = await call(base, 'POST', '/api/mobile/v1/token/refresh', { body: { v: 1, refreshGrant: g.refreshGrant, rotationRequestId: randomBytes(16).toString('base64url') } });
    assert.equal(rotated.status, 200, rotated.text);
    assert.equal(rotated.body.tokenFamilyGeneration, 2);
    assert.equal((await call(base, 'GET', '/api/mobile/v1/summary', { headers: { authorization: `Bearer ${g.accessToken}` } })).status, 401);
    assert.equal((await call(base, 'GET', '/api/mobile/v1/summary', { headers: { authorization: `Bearer ${rotated.body.accessToken}` } })).status, 200);
  } finally {
    server.close();
  }
});

test('rate limiting answers a stable 429 with retry-after', async () => {
  resetMobileLimitersForTest();
  const { server, base } = await listen({ enrolment: true });
  try {
    let last;
    for (let i = 0; i < 31; i += 1) last = await call(base, 'GET', `/api/mobile/v1/identity?challenge=${randomBytes(32).toString('base64url')}`);
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'rate_limited');
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
  } finally {
    server.close();
  }
});
