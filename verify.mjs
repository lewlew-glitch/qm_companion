// Verifies QMC1 bundle decryption and one-use redemption using the production bundle builder.

import { scryptSync, createDecipheriv, timingSafeEqual } from 'node:crypto';
import assert from 'node:assert/strict';

import { buildBundle } from './src/build.js';
import { OneTimeTransfers, qmc1Payload } from './src/qmbackup.js';

// Decrypt the bundle using the app-side envelope format.
function appDecrypt(envelope, passphrase) {
  assert.equal(envelope.magic, 'qmbackup');
  assert.equal(envelope.version, 1);
  const salt = Buffer.from(envelope.kdf.saltHex, 'hex');
  const nonce = Buffer.from(envelope.cipher.nonceHex, 'hex');
  const okm = scryptSync(Buffer.from(passphrase.normalize('NFKC'), 'utf8'), salt, 48, {
    N: envelope.kdf.N,
    r: envelope.kdf.r,
    p: envelope.kdf.p,
    maxmem: 256 * 1024 * 1024,
  });
  const key = okm.subarray(0, 32);
  const verifier = okm.subarray(32);
  assert.ok(timingSafeEqual(verifier, Buffer.from(envelope.verifierHex, 'hex')), 'verifier must match');
  const ciphertext = Buffer.from(envelope.ciphertextHex, 'hex');
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}

const now = Date.parse('2026-08-18T18:00:00.000Z');
const metadata = {
  bundleId: 'verification_bundle_123456',
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 180_000).toISOString(),
};
const detected = [
  {
    instanceId: 'radarr-verification-1',
    kind: 'radarr',
    name: 'Movies',
    port: 7878,
    apiKey: 'verification-radarr-api-key',
  },
  {
    instanceId: 'sonarr-verification-1',
    kind: 'sonarr',
    name: 'TV',
    port: 8989,
    apiKey: 'verification-sonarr-api-key',
  },
  {
    instanceId: 'qbittorrent-verification-1',
    kind: 'qbittorrent',
    name: 'Downloads',
    port: 8080,
  },
];
const draft = {
  services: [
    {
      instanceId: 'radarr-verification-1',
      included: true,
      baseUrl: 'http://192.168.1.20:7878/',
      remoteBaseUrl: 'https://apps.example.com/radarr/',
    },
    {
      instanceId: 'sonarr-verification-1',
      included: true,
      baseUrl: 'http://192.168.1.20:8989',
      remoteBaseUrl: 'https://sonarr.apps.example.com/',
    },
    {
      instanceId: 'qbittorrent-verification-1',
      included: true,
      baseUrl: 'http://192.168.1.20:8080',
      remoteBaseUrl: '',
    },
  ],
  edgeAccess: {
    domain: 'apps.example.com',
    clientId: 'verification-client-id.access',
    clientSecret: 'verification-client-secret',
  },
};

const bundle = buildBundle(
  detected,
  { qmTitle: 'Verification Home', qmHost: '192.168.1.20' },
  draft,
  'verification-installation-id',
  metadata,
);
const payload = bundle.payload;

// Check bundle metadata and per-service routing.
assert.equal(payload.schema, 1);
assert.equal(payload.exportedAt, metadata.issuedAt);
assert.deepEqual(payload.companion, { version: 1, ...metadata });
assert.equal(payload.profiles.length, 1);
assert.equal(payload.profiles[0].id, payload.activeProfileId);
assert.deepEqual(payload.profiles[0].serviceIds, payload.services.map((service) => service.id));
assert.equal(Object.hasOwn(payload, 'profileSecrets'), false, 'Access credentials must not be profile-wide');

const protectedServices = payload.services.filter((service) => service.remoteBaseUrl);
assert.equal(protectedServices.length, 2);
for (const service of protectedServices) {
  const remoteHost = new URL(service.remoteBaseUrl).hostname;
  assert.equal(service.edgeDomain, remoteHost, 'Access binding must use the exact reviewed away host');
  assert.deepEqual(service.secrets.headers, {
    'CF-Access-Client-Id': draft.edgeAccess.clientId,
    'CF-Access-Client-Secret': draft.edgeAccess.clientSecret,
  });
}
assert.equal(protectedServices[0].baseUrl, 'http://192.168.1.20:7878');
assert.equal(protectedServices[0].remoteBaseUrl, 'https://apps.example.com/radarr');
assert.equal(protectedServices[1].edgeDomain, 'sonarr.apps.example.com');

const loginRequired = payload.services.find((service) => service.kind === 'qbittorrent');
assert.deepEqual(loginRequired, {
  id: loginRequired.id,
  kind: 'qbittorrent',
  label: 'Downloads',
  // A login service carries no transferable key; the phone signs in after import.
  credentialMode: 'password',
  disabled: true,
  baseUrl: 'http://192.168.1.20:8080',
  secrets: {},
});

assert.match(bundle.setupCode, /^[0-7][0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/u);
assert.equal(bundle.companion.bundleId, metadata.bundleId);
assert.equal(bundle.envelopeJson.includes(draft.edgeAccess.clientSecret), false, 'the sealed envelope must not expose Access credentials');
assert.equal(bundle.envelopeJson.includes(detected[0].apiKey), false, 'the sealed envelope must not expose service credentials');

// The encrypted file decodes to the original payload.
const envelope = JSON.parse(bundle.envelopeJson);
assert.deepEqual(appDecrypt(envelope, bundle.setupCode), payload);

let rejected = false;
try {
  appDecrypt(envelope, 'wrong-passphrase-99');
} catch {
  rejected = true;
}
assert.ok(rejected, 'a wrong setup code must be rejected');

// The QR contains only a redemption capability. Retries are bounded by count and time.
let clock = now;
const transfers = new OneTimeTransfers({ now: () => clock });
const issued = transfers.create({
  envelopeJson: bundle.envelopeJson,
  sessionToken: 'verification-session-token',
  bundleId: bundle.companion.bundleId,
  expiresAt: Date.parse(bundle.companion.expiresAt),
});
const qr = qmc1Payload('https://companion.example.com', issued.redeemToken);
assert.equal(qr, `QMC1:https://companion.example.com/pair/redeem/${issued.redeemToken}`);
assert.equal(qr.includes(bundle.setupCode), false, 'the QR must not contain the separate setup code');

// The first redemption returns the envelope and starts the grace period.
const redeemed = transfers.consumeRedeem(issued.redeemToken);
assert.ok(redeemed, 'the live redemption capability returns its envelope');
assert.deepEqual(appDecrypt(JSON.parse(redeemed), bundle.setupCode), payload);
// A retry within the grace period returns the same bytes.
assert.equal(transfers.consumeRedeem(issued.redeemToken), redeemed, 'a redeem inside the grace window re-serves the same envelope');
// The capability expires after the allowed retries.
transfers.consumeRedeem(issued.redeemToken);
transfers.consumeRedeem(issued.redeemToken);
assert.equal(transfers.consumeRedeem(issued.redeemToken), null, 'the redemption capability dies after its bounded grace');

// Elapsed time also closes the grace period.
const second = transfers.create({
  envelopeJson: bundle.envelopeJson,
  sessionToken: 'verification-session-token',
  bundleId: bundle.companion.bundleId,
  expiresAt: clock + 180_000,
});
assert.ok(transfers.consumeRedeem(second.redeemToken), 'the second transfer serves once');
clock += 20_001;
assert.equal(transfers.consumeRedeem(second.redeemToken), null, 'the grace window closes on time');

console.log('OK: buildBundle production payload + bounded-grace QMC1 handoff verified; wrong setup code rejected.');
console.log(`   services=${payload.services.length} tokenChars=${issued.redeemToken.length} ciphertextBytes=${Buffer.from(envelope.ciphertextHex, 'hex').length}`);
