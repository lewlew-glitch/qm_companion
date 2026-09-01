import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBundle,
  canonicalizeServiceUrl,
  PairingValidationError,
} from '../src/build.js';
import { OneTimeTransfers, qmc1Payload } from '../src/qmbackup.js';

const detected = [
  { instanceId: 'radarr-111aaa', kind: 'radarr', name: 'radarr-hd', port: 17878, apiKey: 'radarr-key' },
  { instanceId: 'radarr-222bbb', kind: 'radarr', name: 'radarr-4k', port: 27878, apiKey: 'radarr-4k-key' },
];
const cfg = { qmTitle: 'Cinema', qmHost: '192.168.1.20' };
const installationId = '7ee0d8a0-34d6-46f6-8996-ec578f41f6e2';

function metadata(bundleId = 'b1234567890abcdefghijklm') {
  return {
    bundleId,
    issuedAt: '2026-08-18T18:00:00.000Z',
    expiresAt: '2026-08-18T18:03:00.000Z',
  };
}

function draft(edgeAccess = {}) {
  return {
    services: [
      { instanceId: 'radarr-111aaa', included: true, baseUrl: 'http://192.168.1.20:17878/', remoteBaseUrl: 'https://radarr.example.com/media/' },
      { instanceId: 'radarr-222bbb', included: true, baseUrl: 'http://192.168.1.20:27878', remoteBaseUrl: 'https://radarr-4k.example.com/' },
    ],
    edgeAccess,
  };
}

test('service URLs are strict, canonical and retain a non-root path', () => {
  assert.equal(canonicalizeServiceUrl(' HTTPS://Example.COM:443/media/// '), 'https://example.com/media');
  for (const bad of [
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com/path?token=x',
    'https://example.com/#part',
    'https://example.com/%0aheader',
    'https://example.com/%85next-line',
    'https://example.com/%zz',
    'https:\\example.com',
    'not-an-address',
  ]) {
    assert.throws(() => canonicalizeServiceUrl(bad), PairingValidationError, bad);
  }
});

test('bundles preserve duplicate kinds and reviewed routes', () => {
  const bundle = buildBundle(detected, cfg, draft(), installationId, metadata());
  assert.equal(bundle.payload.services.length, 2);
  assert.equal(new Set(bundle.payload.services.map((s) => s.id)).size, 2);
  assert.equal(bundle.payload.services[0].baseUrl, 'http://192.168.1.20:17878');
  assert.equal(bundle.payload.services[0].remoteBaseUrl, 'https://radarr.example.com/media');
  assert.equal(bundle.payload.companion.version, 1);
  assert.equal(bundle.payload.companion.bundleId, metadata().bundleId);
  assert.match(bundle.setupCode, /^[0-7][0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(bundle.envelopeJson.includes('radarr-key'), false);
});

test('stable IDs produce stable non-colliding app IDs', () => {
  const one = buildBundle(detected, cfg, draft(), installationId, metadata('first_bundle_1234567890'));
  const two = buildBundle(detected, cfg, draft(), installationId, metadata('second_bundle_123456789'));
  assert.equal(one.payload.activeProfileId, two.payload.activeProfileId);
  assert.deepEqual(one.payload.services.map((s) => s.id), two.payload.services.map((s) => s.id));
  assert.equal(one.payload.services.some((s) => s.id === one.payload.activeProfileId), false);
});

test('Cloudflare Access is bound to each exact reviewed away host', () => {
  const bundle = buildBundle(detected, cfg, draft({
    domain: 'example.com',
    clientId: 'client-id.access',
    clientSecret: 'client-secret',
  }), installationId, metadata());
  const profileId = bundle.payload.activeProfileId;
  assert.deepEqual(bundle.payload.profiles, [{
    id: profileId,
    name: 'Cinema',
    serviceIds: bundle.payload.services.map((service) => service.id),
  }]);
  assert.equal(bundle.payload.profileSecrets, undefined);
  assert.equal(bundle.payload.services.every((service) => service.edgeDomain === new URL(service.remoteBaseUrl).hostname), true);
  assert.equal(bundle.payload.services.every((service) => (
    service.secrets.headers['CF-Access-Client-Id'] === 'client-id.access' &&
    service.secrets.headers['CF-Access-Client-Secret'] === 'client-secret'
  )), true);
  assert.deepEqual(bundle.payload.services[0].secrets.headers, {
      'CF-Access-Client-Id': 'client-id.access',
      'CF-Access-Client-Secret': 'client-secret',
  });

  assert.throws(() => buildBundle(detected, cfg, draft({ domain: 'example.com', clientId: 'only-id' }), installationId, metadata()), /enter the domain, client ID and client secret together/i);
  const mismatched = draft({ domain: 'other.example', clientId: 'id', clientSecret: 'secret' });
  assert.throws(() => buildBundle(detected, cfg, mismatched, installationId, metadata()), /would never be used/i);

  const insecure = draft({ domain: 'example.com', clientId: 'id', clientSecret: 'secret' });
  insecure.services[0].remoteBaseUrl = 'http://radarr.example.com';
  assert.throws(() => buildBundle(detected, cfg, insecure, installationId, metadata()), /must use HTTPS/i);
  assert.throws(() => buildBundle(detected, cfg, draft({ domain: 'not_dns.example.com', clientId: 'id', clientSecret: 'secret' }), installationId, metadata()), /DNS host name/i);
  assert.throws(() => buildBundle(detected, cfg, draft({ domain: 'com', clientId: 'id', clientSecret: 'secret' }), installationId, metadata()), /DNS host name/i);
});

test('detected labels and API keys fail closed at the app import limits', () => {
  const badLabel = [{ ...detected[0], name: `Radarr\nAdmin` }];
  const one = { services: [draft().services[0]], edgeAccess: {} };
  assert.throws(() => buildBundle(badLabel, cfg, one, installationId, metadata()), /invalid name/i);
  const badKey = [{ ...detected[0], apiKey: 'x'.repeat(16_385) }];
  assert.throws(() => buildBundle(badKey, cfg, one, installationId, metadata()), /invalid API key/i);
  const controlKey = [{ ...detected[0], apiKey: 'secret\u0000tail' }];
  assert.throws(() => buildBundle(controlKey, cfg, one, installationId, metadata()), /invalid API key/i);
});

test('conflicting credential sources block transfer', () => {
  const conflicted = [{ ...detected[0], apiKey: undefined, credentialConflict: true }];
  const one = { services: [draft().services[0]], edgeAccess: {} };
  assert.throws(
    () => buildBundle(conflicted, cfg, one, installationId, metadata()),
    PairingValidationError,
  );
});

test('phone-login services are disabled', () => {
  const loginOnly = [{
    instanceId: 'qbittorrent-111aaa',
    kind: 'qbittorrent',
    name: 'Downloads',
    port: 8080,
    apiKey: 'not-a-qbittorrent-api-key',
  }];
  const loginDraft = {
    services: [{
      instanceId: 'qbittorrent-111aaa',
      included: true,
      baseUrl: 'http://192.168.1.20:8080',
    }],
    edgeAccess: {},
  };

  const bundle = buildBundle(loginOnly, cfg, loginDraft, installationId, metadata());
  assert.deepEqual(bundle.payload.services[0], {
    id: bundle.payload.services[0].id,
    kind: 'qbittorrent',
    label: 'Downloads',
    credentialMode: 'password',
    disabled: true,
    baseUrl: 'http://192.168.1.20:8080',
    secrets: {},
  });
  assert.equal(bundle.summary[0].needsLogin, true);
  assert.equal(bundle.summary[0].hasKey, false);
  assert.equal(bundle.summary[0].credentialState, 'sign-in');
});

test('CrowdSec is handed over for phone sign-in', () => {
  const crowdsec = [{
    instanceId: 'crowdsec-111aaa',
    kind: 'crowdsec',
    name: 'CrowdSec',
    port: 8080,
  }];
  const transferDraft = {
    services: [{
      instanceId: 'crowdsec-111aaa',
      included: true,
      baseUrl: 'http://192.168.1.20:8080',
    }],
    edgeAccess: {},
  };

  const bundle = buildBundle(crowdsec, cfg, transferDraft, installationId, metadata());
  assert.equal(bundle.payload.services[0].credentialMode, 'password');
  assert.equal(bundle.payload.services[0].disabled, true);
  assert.deepEqual(bundle.payload.services[0].secrets, {});
  assert.equal(bundle.summary[0].credentialState, 'sign-in');
});

test('Komodo requires both discovered credentials', () => {
  const komodo = [{
    instanceId: 'komodo-111aaa',
    kind: 'komodo',
    name: 'Komodo',
    port: 9120,
    apiKey: 'ambiguous-discovered-key',
  }];
  const transferDraft = {
    services: [{
      instanceId: 'komodo-111aaa',
      included: true,
      baseUrl: 'http://192.168.1.20:9120',
    }],
    edgeAccess: {},
  };

  const bundle = buildBundle(komodo, cfg, transferDraft, installationId, metadata());
  assert.equal(bundle.payload.services[0].disabled, true);
  assert.deepEqual(bundle.payload.services[0].secrets, {});
  assert.equal(bundle.summary[0].credentialState, 'key-and-secret');
});

test('pairing summary classifies credential states', () => {
  const services = [
    { instanceId: 'radarr-111aaa', kind: 'radarr', name: 'Radarr', port: 7878, apiKey: 'ready' },
    { instanceId: 'dozzle-111aaa', kind: 'dozzle', name: 'Dozzle', port: 8080 },
    { instanceId: 'plex-111aaa', kind: 'plex', name: 'Plex', port: 32400 },
    { instanceId: 'bazarr-111aaa', kind: 'bazarr', name: 'Bazarr', port: 6767 },
  ];
  const transferDraft = {
    services: services.map((service) => ({
      instanceId: service.instanceId,
      included: true,
      baseUrl: `http://192.168.1.20:${service.port}`,
    })),
    edgeAccess: {},
  };

  const bundle = buildBundle(services, cfg, transferDraft, installationId, metadata());
  assert.deepEqual(bundle.summary.map((service) => service.credentialState), [
    'included',
    'not-required',
    'sign-in',
    'missing-key',
  ]);
});

test('disables services with missing required credentials', () => {
  const services = [
    { instanceId: 'kavita-111aaa', kind: 'kavita', name: 'Books', port: 5000 },
    { instanceId: 'truenas-111aaa', kind: 'truenas', name: 'NAS', port: 443 },
    { instanceId: 'transmission-111aaa', kind: 'transmission', name: 'Open downloads', port: 9091 },
    { instanceId: 'gluetun-111aaa', kind: 'gluetun', name: 'VPN', port: 8000 },
    { instanceId: 'pihole-111aaa', kind: 'pihole', name: 'DNS', port: 80 },
  ];
  const transferDraft = {
    services: services.map((service) => ({
      instanceId: service.instanceId,
      included: true,
      baseUrl: `${service.kind === 'truenas' ? 'https' : 'http'}://192.168.1.20:${service.port}`,
    })),
    edgeAccess: {},
  };

  const bundle = buildBundle(services, cfg, transferDraft, installationId, metadata());
  assert.equal(bundle.payload.services.find((service) => service.kind === 'kavita').disabled, true);
  assert.equal(bundle.payload.services.find((service) => service.kind === 'truenas').disabled, true);
  assert.equal(bundle.payload.services.find((service) => service.kind === 'transmission').disabled, undefined);
  assert.equal(bundle.payload.services.find((service) => service.kind === 'gluetun').disabled, undefined);
  assert.equal(bundle.payload.services.find((service) => service.kind === 'pihole').disabled, undefined);
});

test('the built bundle tells the phone how each needy service signs in', () => {
  const services = [
    { instanceId: 'plex-111aaa', kind: 'plex', name: 'Plex', port: 32400 },
    { instanceId: 'komodo-111aaa', kind: 'komodo', name: 'Komodo', port: 9120 },
    { instanceId: 'qbittorrent-111aaa', kind: 'qbittorrent', name: 'Downloads', port: 8080 },
    { instanceId: 'jellyfin-111aaa', kind: 'jellyfin', name: 'Media', port: 8096 },
    { instanceId: 'radarr-111aaa', kind: 'radarr', name: 'Radarr', port: 7878, apiKey: 'ready' },
    { instanceId: 'dozzle-111aaa', kind: 'dozzle', name: 'Logs', port: 8080 },
  ];
  const transferDraft = {
    services: services.map((service) => ({
      instanceId: service.instanceId,
      included: true,
      baseUrl: `http://192.168.1.20:${service.port}`,
    })),
    edgeAccess: {},
  };
  const bundle = buildBundle(services, cfg, transferDraft, installationId, metadata());
  const mode = (kind) => bundle.payload.services.find((service) => service.kind === kind).credentialMode;
  assert.equal(mode('plex'), 'plex');
  assert.equal(mode('komodo'), 'key-and-secret');
  assert.equal(mode('qbittorrent'), 'password');
  assert.equal(mode('jellyfin'), 'api-key');
  assert.equal(mode('radarr'), undefined);
  assert.equal(mode('dozzle'), undefined);
});

test('QMC1 redemption disables the file fallback', () => {
  let now = 1000;
  const transfers = new OneTimeTransfers({ now: () => now });
  const first = transfers.create({ envelopeJson: '{"one":1}', sessionToken: 'session-a', bundleId: 'bundle_1234567890abcd', expiresAt: 4000 });
  assert.match(first.redeemToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(qmc1Payload('https://companion.example.com', first.redeemToken), `QMC1:https://companion.example.com/pair/redeem/${first.redeemToken}`);
  assert.equal(transfers.consumeFile(first.pairId, 'wrong-session'), null);
  assert.equal(transfers.consumeRedeem(first.redeemToken), '{"one":1}');
  assert.equal(transfers.consumeFile(first.pairId, 'session-a'), null);

  const second = transfers.create({ envelopeJson: '{"two":2}', sessionToken: 'session-a', bundleId: 'bundle_abcdefghijklmno', expiresAt: 4000 });
  assert.equal(transfers.consumeFile(second.pairId, 'session-a'), '{"two":2}');
  assert.equal(transfers.consumeRedeem(second.redeemToken), null);
  assert.equal(transfers.consumeFile(second.pairId, 'session-a'), null);

  const expired = transfers.create({ envelopeJson: '{}', sessionToken: 'session-a', bundleId: 'bundle_expiring_123456', expiresAt: 2000 });
  now = 2000;
  assert.equal(transfers.consumeRedeem(expired.redeemToken), null);
  now = 22_000;
  assert.equal(transfers.size, 0);
});

test('redeemed transfers briefly replay the same token', () => {
  let now = 1000;
  const transfers = new OneTimeTransfers({ now: () => now });
  const ttl = 181_000;
  const t = transfers.create({ envelopeJson: '{"g":1}', sessionToken: 's', bundleId: 'bundle_grace_12345678', expiresAt: ttl });

  now = ttl - 1;
  assert.equal(transfers.consumeRedeem(t.redeemToken), '{"g":1}');
  now = ttl + 19_000;
  assert.equal(transfers.consumeRedeem(t.redeemToken), '{"g":1}');
  assert.equal(transfers.consumeRedeem(t.redeemToken), '{"g":1}');
  assert.equal(transfers.consumeRedeem(t.redeemToken), '{"g":1}');
  assert.equal(transfers.consumeRedeem(t.redeemToken), null);

  const late = transfers.create({ envelopeJson: '{"h":2}', sessionToken: 's', bundleId: 'bundle_grace_abcdefgh', expiresAt: now + 60_000 });
  assert.equal(transfers.consumeRedeem(late.redeemToken), '{"h":2}');
  now += 20_001;
  assert.equal(transfers.consumeRedeem(late.redeemToken), null);
  assert.equal(transfers.size, 0);
});

test('QMC1 refuses weak tokens and non-http origins', () => {
  assert.throws(() => qmc1Payload('https://companion.example.com', 'short'), /token/i);
  assert.throws(() => qmc1Payload('file:///tmp', 'a'.repeat(43)), /origin/i);
  assert.throws(() => qmc1Payload('https://companion.example.com/admin', 'a'.repeat(43)), /origin/i);
});

test('buildBundle uses current availability and ignores force for stopped rows', () => {
  const rows = [
    { ...detected[0], dockerState: 'running', up: true, availability: 'reachable' },
    { ...detected[1], dockerState: 'exited', up: false, availability: 'not-running' },
  ];
  const forcedBoth = { ...draft(), services: draft().services.map((row) => ({ ...row, forced: true })) };
  assert.throws(
    () => buildBundle(rows, cfg, forcedBoth, installationId, metadata()),
    (error) => error instanceof PairingValidationError && error.name === 'PairingValidationError' && error.issues[0] === 'radarr-4k is stopped in Docker. Start it, then create the transfer again.',
  );
  const forcedReachable = { ...draft(), services: [{ ...draft().services[0], forced: true }] };
  const bundle = buildBundle(rows, cfg, forcedReachable, installationId, metadata());
  assert.deepEqual(bundle.summary.map((s) => s.label), ['radarr-hd']);
  assert.equal(JSON.stringify(bundle.payload).includes('forced'), false);
  const bare = buildBundle(detected, cfg, draft(), installationId, metadata());
  assert.equal(bare.summary.length, 2);
});
