import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGrant, buildTranscript, deriveSas, grantBytes, identitySignedBytes, openGrant, sealGrant,
  sealedPlaintext, signGrant, signIdentity, signTranscript, transcriptBytes, transcriptHash,
  verifyGrant, verifyIdentity, verifyTranscript, verifyWithRawPublicKey,
} from '../src/mobile/protocol.js';
import { parseSealedEnvelope } from '../src/mobile/envelope.js';


const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mobile-protocol', 'fixtures.json');
const fx = JSON.parse(readFileSync(fixturesPath, 'utf8'));
const priv = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(fx.ed25519Seed, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});
const server = {
  origin: 'https://nas.local:8788',
  mobileInstallationId: '11111111-2222-4333-8444-555555555555',
  legacyInstallationId: '99999999-8888-4777-a666-555555555555',
  serverSigningPublicKey: fx.publicKey,
  serverSigningFingerprint: fx.fingerprint,
  tlsLeafFingerprint: 'aa'.repeat(32),
};
const claim = {
  enrolmentId: 'AAAAAAAAAAAAAAAAAAAAAA',
  claimEncryptionPublicKey: Buffer.alloc(32, 7).toString('base64url'),
  clientNonce: Buffer.alloc(16, 3).toString('base64url'),
  requestedScopes: ['containers.read', 'events.read', 'stacks.read', 'summary.read', 'updates.read'],
  deviceName: 'Fixture iPhone',
  expiresAt: 1787300000000,
};

test('transcript bytes, hash, signature and SAS match the normative fixtures', () => {
  const t = buildTranscript(server, claim);
  const bytes = transcriptBytes(t);
  assert.equal(bytes.toString('hex'), fx.transcriptBytesHex);
  const hash = transcriptHash(bytes);
  assert.equal(hash.toString('hex'), fx.transcriptHashHex);
  assert.equal(Buffer.from(signTranscript(priv, bytes)).toString('base64url'), fx.transcriptSignature);
  assert.equal(verifyTranscript(fx.publicKey, bytes, fx.transcriptSignature), true);
  assert.deepEqual(deriveSas(hash), { digits: fx.sasDigits, words: fx.sasWords });
});

test('server excludes client authority fields from transcripts', () => {
  const t = buildTranscript(server, { ...claim, origin: 'https://evil:1', mobileInstallationId: 'x', serverSigningFingerprint: 'y' });
  assert.equal(t.origin, server.origin);
  assert.equal(t.mobileInstallationId, server.mobileInstallationId);
  assert.equal(t.serverSigningFingerprint, server.serverSigningFingerprint);
  assert.deepEqual(Object.keys(t).sort(), [
    'claimEncryptionPublicKey', 'clientNonce', 'deviceName', 'enrolmentId', 'expiresAt',
    'legacyInstallationId', 'mobileInstallationId', 'origin', 'requestedScopes',
    'serverSigningFingerprint', 'serverSigningPublicKey', 'tlsLeafFingerprint', 'v',
  ]);
});

test('transcript inputs are strictly validated', () => {
  assert.throws(() => buildTranscript({ ...server, origin: 'http://nas.local:8788' }, claim), /canonical https origin/);
  assert.throws(() => buildTranscript({ ...server, origin: 'https://nas.local' }, claim), /canonical https origin/);
  assert.throws(() => buildTranscript(server, { ...claim, enrolmentId: 'AAAAAAAAAAAAAAAAAAAAAB' }), /enrolmentId/);
  assert.throws(() => buildTranscript(server, { ...claim, claimEncryptionPublicKey: 'short' }), /claimEncryptionPublicKey/);
  assert.throws(() => buildTranscript(server, { ...claim, requestedScopes: ['containers.write'] }), /scope/i);
  assert.throws(() => buildTranscript(server, { ...claim, deviceName: '' }), /deviceName/);
  assert.throws(() => buildTranscript(server, { ...claim, deviceName: 'x'.repeat(65) }), /deviceName/);
  assert.throws(() => buildTranscript(server, { ...claim, expiresAt: 1.5 }), /expiresAt/);
  assert.throws(() => buildTranscript({ ...server, serverSigningPublicKey: `${fx.publicKey.slice(0, -1)}=` }, claim), /serverSigningPublicKey/);
});

test('domain labels separate the three signatures', () => {
  const bytes = transcriptBytes(buildTranscript(server, claim));
  const asTranscript = signTranscript(priv, bytes);
  assert.equal(verifyGrant(fx.publicKey, bytes, asTranscript), false);
  assert.equal(verifyIdentity(fx.publicKey, bytes, asTranscript), false);
  assert.equal(verifyTranscript(fx.publicKey, Buffer.concat([bytes, Buffer.from(' ')]), asTranscript), false);
});

test('grant bytes, signature and sealed plaintext match the normative fixtures', () => {
  const grant = buildGrant({
    mobileInstallationId: server.mobileInstallationId,
    legacyInstallationId: server.legacyInstallationId,
    deviceId: Buffer.alloc(16, 9).toString('base64url'),
    accessToken: `qmd_${Buffer.alloc(32, 1).toString('base64url')}`,
    accessTokenExpiresAt: 1787300900000,
    refreshGrant: `qmr_${Buffer.alloc(32, 2).toString('base64url')}`,
    refreshAbsoluteDeadlineAt: 1795076000000,
    refreshIdleDeadlineAt: 1789892000000,
    tokenFamilyGeneration: 1,
    scopes: claim.requestedScopes,
    ackSecret: Buffer.alloc(32, 5).toString('base64url'),
    transcriptHash: fx.transcriptHashHex,
  });
  const bytes = grantBytes(grant);
  assert.equal(bytes.toString('hex'), fx.grantBytesHex);
  const sig = signGrant(priv, bytes);
  assert.equal(Buffer.from(sig).toString('base64url'), fx.grantSignature);
  assert.equal(verifyGrant(fx.publicKey, bytes, sig), true);
  assert.equal(sealedPlaintext(grant, sig).toString('hex'), fx.sealedPlaintextHex);
  assert.throws(() => buildGrant({ ...grant, accessToken: `qmp_${Buffer.alloc(32, 1).toString('base64url')}` }), /qmd/);
  assert.throws(() => buildGrant({ ...grant, refreshGrant: `qmd_${Buffer.alloc(32, 2).toString('base64url')}` }), /qmr/);
  assert.throws(() => buildGrant({ ...grant, scopes: ['summary.read', 'summary.read'] }), /scope/i);
});

test('identity challenge bytes and signature match the normative fixtures', () => {
  const pubRaw = Buffer.from(fx.publicKey, 'base64url');
  const bytes = identitySignedBytes({
    mobileInstallationId: server.mobileInstallationId, publicKeyRaw: pubRaw, challenge: Buffer.alloc(32, 6), issuedAt: 1787300000000,
  });
  assert.equal(bytes.toString('hex'), fx.identityBytesHex);
  assert.equal(Buffer.from(signIdentity(priv, bytes)).toString('base64url'), fx.identitySignature);
  assert.equal(verifyIdentity(fx.publicKey, bytes, fx.identitySignature), true);
  assert.throws(() => identitySignedBytes({ mobileInstallationId: 'nope', publicKeyRaw: pubRaw, challenge: Buffer.alloc(32), issuedAt: 1 }), /mobileInstallationId/);
  assert.throws(() => identitySignedBytes({ mobileInstallationId: server.mobileInstallationId, publicKeyRaw: pubRaw, challenge: Buffer.alloc(31), issuedAt: 1 }), /challenge/);
});

test('raw public key verification rejects malformed inputs', () => {
  const bytes = Buffer.from('x');
  const sig = signIdentity(priv, bytes);
  assert.equal(verifyWithRawPublicKey(fx.publicKey, bytes, sig), true);
  assert.equal(verifyWithRawPublicKey(`${fx.publicKey}=`, bytes, sig), false);
  assert.equal(verifyWithRawPublicKey(fx.publicKey.slice(1), bytes, sig), false);
  assert.equal(verifyWithRawPublicKey(fx.publicKey, bytes, sig.subarray(0, 63)), false);
  const other = generateKeyPairSync('ed25519');
  const otherRaw = other.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
  assert.equal(verifyWithRawPublicKey(otherRaw, bytes, sig), false);
});

test('HPKE round-trip uses the fixed suite and transcript AAD', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pkRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const skRaw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const aad = Buffer.from(fx.transcriptHashHex, 'hex');
  const plaintext = Buffer.from(fx.sealedPlaintextHex, 'hex');
  const envelope = await sealGrant(pkRaw, plaintext, aad);
  const parsed = parseSealedEnvelope(envelope);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(JSON.parse(envelope).aad, undefined);
  assert.deepEqual(await openGrant(skRaw, envelope, aad), plaintext);
  await assert.rejects(openGrant(skRaw, envelope, Buffer.alloc(32, 9)));
  await assert.rejects(openGrant(randomBytes(32), envelope, aad));
  const tampered = JSON.parse(envelope);
  tampered.ct = Buffer.concat([Buffer.from(tampered.ct, 'base64url').subarray(0, -1), Buffer.from([0])]).toString('base64url');
  await assert.rejects(openGrant(skRaw, JSON.stringify(tampered), aad));
  await assert.rejects(openGrant(skRaw, JSON.stringify({ ...JSON.parse(envelope), aad: 'AAAA' }), aad), /envelope refused/);
  await assert.rejects(openGrant(skRaw, JSON.stringify({ ...JSON.parse(envelope), aead: 1 }), aad), /envelope refused/);
});

test('envelope keys and identifiers match the fixed suite', async () => {
  const { publicKey } = generateKeyPairSync('x25519');
  const pkRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const envelope = JSON.parse(await sealGrant(pkRaw, Buffer.from('hello'), Buffer.alloc(32)));
  assert.deepEqual(Object.keys(envelope).sort(), ['aead', 'ct', 'enc', 'kdf', 'kem', 'v']);
  assert.deepEqual([envelope.v, envelope.kem, envelope.kdf, envelope.aead], [1, 32, 1, 2]);
  assert.equal(Buffer.from(envelope.enc, 'base64url').length, 32);
});
