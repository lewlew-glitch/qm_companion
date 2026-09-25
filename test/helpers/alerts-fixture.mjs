// Paired phones and isolated HTTP listeners for alerts tests.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const ALERTS_SERVER = { origin: 'https://nas.local:8788', tlsLeafFingerprint: 'ee'.repeat(32) };

export async function pairAlertPhone(scopes = ['events.read']) {
  const owner = await import('../../src/mobile/enrolment-owner.js');
  const pairing = await import('../../src/mobile/enrolment.js');
  const protocol = await import('../../src/mobile/protocol.js');
  const created = owner.createEnrolment();
  assert.equal(created.ok, true);
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const claim = pairing.claimEnrolment(ALERTS_SERVER, {
    pairingKey: created.pairingKey,
    claimEncryptionPublicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    clientNonce: randomBytes(16).toString('base64url'), deviceName: 'Test iPhone', requestedScopes: scopes,
    candidateOrigin: ALERTS_SERVER.origin,
  });
  assert.equal(claim.ok, true);
  assert.equal((await pairing.approveEnrolment(created.enrolmentId)).ok, true);
  const response = pairing.retrieveGrant(created.enrolmentId);
  const wrapper = JSON.parse((await protocol.openGrant(
    privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), response.body.envelope,
    protocol.transcriptHash(Buffer.from(claim.body.transcript, 'base64url')),
  )).toString('utf8'));
  assert.equal(pairing.acknowledgeEnrolment(created.enrolmentId, wrapper.grant.ackSecret, ALERTS_SERVER.tlsLeafFingerprint).ok, true);
  return wrapper.grant;
}

export async function listenForAlerts(route, t) {
  const server = createServer((req, res) => {
    Promise.resolve(route(req, res)).catch(() => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"test handler failed"}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

export function freshAlerts() {
  return { sources: [], devices: [], history: [], samples: {}, throttle: {}, receipts: [] };
}
