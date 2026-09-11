import test from 'node:test';
import assert from 'node:assert/strict';

import { homepageCredential } from '../src/detect.js';
import { buildBundle } from '../src/build.js';
import { pairingCredentialState } from '../src/kinds.js';
import { canSaveManualKey, ladderFor } from '../src/keyladder.js';

const sourceId = '7ee0d8a0-34d6-46f6-8996-ec578f41f6e2';

test('matching Dockhand and Pi-hole widget keys reach the encrypted selected service payload', () => {
  const detected = ['dockhand', 'pihole', 'jellyfin', 'portainer'].map((kind, index) => ({
    instanceId: `${kind}-${index}`, kind, name: kind, port: 18080 + index,
    ...homepageCredential(kind, {
      'homepage.widget.type': kind,
      'homepage.widget.key': `original-${kind}-credential`,
    }),
  }));
  const bundle = buildBundle(detected, { qmTitle: 'Home', qmHost: '192.168.1.2' }, {
    services: detected.map((service) => ({
      instanceId: service.instanceId, included: true, baseUrl: `http://192.168.1.2:${service.port}`,
    })),
  }, sourceId, {
    bundleId: 'selected_credential_fixture_01',
    issuedAt: '2026-09-11T12:00:00.000Z', expiresAt: '2026-09-11T12:03:00.000Z',
  });
  assert.deepEqual(bundle.payload.services.map((service) => service.kind), detected.map((service) => service.kind));
  for (const service of bundle.payload.services) {
    assert.equal(service.secrets.apiKey, `original-${service.kind}-credential`);
    assert.equal(service.disabled, undefined);
    assert.equal(bundle.envelopeJson.includes(service.secrets.apiKey), false);
  }
});

test('new widget key support retains exact-kind, conflict and malformed-value boundaries', () => {
  for (const kind of ['dockhand', 'pihole']) {
    assert.deepEqual(homepageCredential(kind, {
      'homepage.widget.type': 'jellyfin', 'homepage.widget.key': 'other-service-key',
    }), { apiKey: undefined, credentialConflict: false });
    for (const competingKey of ['different-key', ' unsafe-key', 'unsafe\nkey']) {
      assert.deepEqual(homepageCredential(kind, {
        'homepage.widget.type': kind, 'homepage.widget.key': 'matching-key',
        'homepage.widgets[3].type': kind, 'homepage.widgets[3].key': competingKey,
      }), { apiKey: undefined, credentialConflict: true });
    }
  }
  for (const kind of ['crowdsec', 'glances', 'streamystats']) {
    assert.deepEqual(homepageCredential(kind, {
      'homepage.widget.type': kind, 'homepage.widget.key': 'not-a-verified-credential-shape',
      'homepage.widget.username': 'account', 'homepage.widget.password': 'password',
    }), { apiKey: undefined, credentialConflict: false });
  }
});

test('supported optional credentials can be supplied without opening interactive or conflict paths', () => {
  assert.equal(pairingCredentialState('pihole'), 'not-required');
  assert.equal(canSaveManualKey('pihole'), true);
  assert.deepEqual(ladderFor('pihole'), { class: 'manual', settingsPath: '/admin/' });
  assert.equal(canSaveManualKey('streamystats'), true);
  assert.deepEqual(ladderFor('streamystats'), { class: 'manual', settingsPath: '/' });
  for (const kind of ['dockhand', 'jellyfin', 'portainer', 'homeassistant']) {
    assert.equal(canSaveManualKey(kind), true, kind);
  }
  for (const kind of ['crowdsec', 'glances', 'transmission', 'unknown']) {
    assert.equal(canSaveManualKey(kind), false, kind);
  }
  assert.equal(canSaveManualKey('pihole', 'already-present'), false);
  assert.equal(canSaveManualKey('pihole', undefined, true), false);
  assert.equal(canSaveManualKey('streamystats', 'already-present'), false);
  assert.equal(canSaveManualKey('streamystats', undefined, true), false);
  assert.equal(canSaveManualKey('dockhand', undefined, true), false);
});
