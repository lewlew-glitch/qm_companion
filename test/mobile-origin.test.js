import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


process.env.SECRET_KEY = 'ef'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-origin-root-'));
process.env.QM_HOST = 'nas.local';

const { ensureMobileCertificate, rotateMobileCertificate, tlsPaths } = await import('../src/mobile/cert.js');
const { mobileListenerPlan } = await import('../src/mobile/config.js');
const { hostKind, parseAdvertisedOrigin, unusableHostReason } = await import('../src/mobile/origin.js');
const { buildTranscript } = await import('../src/mobile/protocol.js');
const { buildQrPayload, parseQrPayload } = await import('../src/mobile/qr.js');
const { generalName } = await import('../src/mobile/x509.js');

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-origin-'));
  roots.push(root);
  return root;
};

const MAPPED = [
  { origin: 'https://[::ffff:0:0]:8788', host: '[::ffff:0:0]', why: /unspecified \(wildcard\) address/ },
  { origin: 'https://[::ffff:e000:1]:8788', host: '[::ffff:e000:1]', why: /multicast address/ },
  { origin: 'https://[::ffff:f000:1]:8788', host: '[::ffff:f000:1]', why: /reserved or broadcast address/ },
];

const REFUSED = [
  ...[
    { origin: 'https://[::ffff:0:0]:8788', host: '[::ffff:0:0]', why: /unspecified \(wildcard\) address/ },
    { origin: 'https://[::ffff:e000:1]:8788', host: '[::ffff:e000:1]', why: /multicast address/ },
    { origin: 'https://[::ffff:f000:1]:8788', host: '[::ffff:f000:1]', why: /reserved or broadcast address/ },
  ],
  { origin: 'https://0.0.0.0:8788', host: '0.0.0.0', why: /unspecified \(wildcard\) address/ },
  { origin: 'https://[::]:8788', host: '[::]', why: /unspecified \(wildcard\) address/ },
  { origin: 'https://0.1.2.3:8788', host: '0.1.2.3', why: /unspecified \(wildcard\) address/ },
  { origin: 'https://224.0.0.1:8788', host: '224.0.0.1', why: /multicast address/ },
  { origin: 'https://239.255.255.250:8788', host: '239.255.255.250', why: /multicast address/ },
  { origin: 'https://[ff02::1]:8788', host: '[ff02::1]', why: /multicast address/ },
  { origin: 'https://255.255.255.255:8788', host: '255.255.255.255', why: /reserved or broadcast address/ },
  { origin: 'https://240.0.0.1:8788', host: '240.0.0.1', why: /reserved or broadcast address/ },
].flat();

const ACCEPTED = [
  { origin: 'https://192.168.1.20:8788', host: '192.168.1.20', kind: 'ipv4', note: 'LAN IPv4' },
  { origin: 'https://192.168.1.10:8788', host: '192.168.1.10', kind: 'ipv4', note: 'LAN IPv4' },
  { origin: 'https://100.100.20.5:8788', host: '100.100.20.5', kind: 'ipv4', note: 'Tailscale IPv4 (CGNAT range)' },
  { origin: 'https://nas.tail1a2b3c.ts.net:8788', host: 'nas.tail1a2b3c.ts.net', kind: 'dns', note: 'Tailscale MagicDNS' },
  { origin: 'https://nas.local:8788', host: 'nas.local', kind: 'dns', note: 'mDNS name' },
  { origin: 'https://[fd7a:115c:a1e0::1]:8788', host: '[fd7a:115c:a1e0::1]', kind: 'ipv6', note: 'Tailscale ULA IPv6' },
  { origin: 'https://[fe80::1]:8788', host: '[fe80::1]', kind: 'ipv6', note: 'link-local IPv6' },
  { origin: 'https://127.0.0.1:8788', host: '127.0.0.1', kind: 'ipv4', note: 'loopback stays legal: one machine' },
  { origin: 'https://[::1]:443', host: '[::1]', kind: 'ipv6', note: 'loopback IPv6' },
];

test('rejects wildcard, multicast, and reserved origins', () => {
  for (const c of REFUSED) {
    const parsed = parseAdvertisedOrigin(c.origin);
    assert.equal(parsed.ok, false, c.origin);
    assert.match(parsed.error, c.why, c.origin);
    assert.match(unusableHostReason(c.host), c.why, c.host);
  }
});

test('accepts LAN, overlay DNS, and IPv6 origins', () => {
  for (const c of ACCEPTED) {
    const parsed = parseAdvertisedOrigin(c.origin);
    assert.equal(parsed.ok, true, `${c.note}: ${parsed.error || ''}`);
    assert.equal(parsed.origin, c.origin);
    assert.equal(parsed.host, c.host);
    assert.equal(hostKind(c.host), c.kind, c.note);
    assert.equal(unusableHostReason(c.host), null, c.note);
  }
});

test('IPv4 octets use strict range and leading-zero validation', () => {
  for (const bad of ['https://256.1.1.1:8788', 'https://1.2.3.4.5:8788', 'https://999.999.999.999:8788', 'https://01.02.03.04:8788', 'https://192.168.001.010:8788']) {
    assert.equal(parseAdvertisedOrigin(bad).ok, false, bad);
  }
  assert.match(unusableHostReason('1.2.3.4.5'), /not a valid IPv4 address/);
  assert.match(unusableHostReason('256.1.1.1'), /not a valid IPv4 address/);
  assert.match(unusableHostReason('01.02.03.04'), /not a valid IPv4 address/);
  assert.equal(unusableHostReason('223.255.255.254'), null, '223.255.255.254 is a legal unicast host');
  assert.equal(unusableHostReason('223.0.0.1'), null);
});

test('a DNS name over the label or name limits is refused', () => {
  assert.match(unusableHostReason(`${'a'.repeat(64)}.local`), /invalid label/);
  assert.match(unusableHostReason(`${'a'.repeat(60)}.`.repeat(5) + 'a'.repeat(60)), /too long|invalid label/);
  assert.equal(unusableHostReason(`${'a'.repeat(63)}.local`), null);
});

test('rejects wildcard origins while allowing wildcard binds', () => {
  process.env.MOBILE_API_ENABLED = 'true';
  for (const c of REFUSED) {
    const plan = mobileListenerPlan({ MOBILE_API_ENABLED: 'true', QM_ADVERTISED_ORIGIN: c.origin, MOBILE_PORT: '8788', MOBILE_BIND_ADDRESS: '0.0.0.0' });
    assert.equal(plan.ok, false, c.origin);
    assert.match(plan.reason, c.why, c.origin);
  }
  const ok = mobileListenerPlan({ MOBILE_API_ENABLED: 'true', QM_ADVERTISED_ORIGIN: 'https://192.168.1.20:8788', MOBILE_PORT: '8788', MOBILE_BIND_ADDRESS: '0.0.0.0' });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.bind, '0.0.0.0');
  assert.equal(ok.host, '192.168.1.20');
  const v6 = mobileListenerPlan({ MOBILE_API_ENABLED: 'true', QM_ADVERTISED_ORIGIN: 'https://[fd7a:115c:a1e0::1]:8788', MOBILE_PORT: '8788', MOBILE_BIND_ADDRESS: '::' });
  assert.equal(v6.ok, true, v6.reason);
  assert.equal(v6.bind, '::');
});

test('rejects wildcard certificate hosts', () => {
  for (const c of REFUSED) {
    assert.throws(() => generalName(c.host), c.why, c.host);
    const dataDir = fresh();
    const made = ensureMobileCertificate({ dataDir, host: c.host });
    assert.equal(made.ok, false, c.host);
    assert.equal(made.code, 'host_unusable', c.host);
    assert.equal(rotateMobileCertificate({ dataDir, host: c.host }).ok, false, c.host);
    assert.equal(tlsPaths(dataDir).certPath.endsWith('mobile.crt'), true);
  }
});

test('rejects wildcard origins in QR payloads', () => {
  const key = `qme_${'a'.repeat(43)}`;
  const fingerprint = 'ab'.repeat(32);
  for (const c of REFUSED) {
    assert.throws(() => buildQrPayload(c.origin, key, fingerprint), /canonical https origin/, c.origin);
    const forged = `QMC2:${Buffer.from(JSON.stringify({ fingerprint, key, origin: c.origin, v: 2 }), 'utf8').toString('base64url')}`;
    const parsed = parseQrPayload(forged);
    assert.equal(parsed.ok, false, c.origin);
  }
});

test('transcript creation cannot bind a wildcard origin', () => {
  const server = {
    mobileInstallationId: '11111111-1111-4111-8111-111111111111',
    legacyInstallationId: '22222222-2222-4222-8222-222222222222',
    serverSigningPublicKey: Buffer.alloc(32, 7).toString('base64url'),
    serverSigningFingerprint: 'cd'.repeat(32),
    tlsLeafFingerprint: 'ef'.repeat(32),
  };
  const claim = {
    enrolmentId: Buffer.alloc(16, 1).toString('base64url'),
    claimEncryptionPublicKey: Buffer.alloc(32, 2).toString('base64url'),
    clientNonce: Buffer.alloc(16, 3).toString('base64url'),
    requestedScopes: ['containers.read'],
    deviceName: 'iPhone',
    expiresAt: Date.now() + 600_000,
  };
  for (const c of REFUSED) {
    assert.throws(() => buildTranscript({ ...server, origin: c.origin }, claim), /canonical https origin/, c.origin);
  }
  const good = buildTranscript({ ...server, origin: 'https://192.168.1.20:8788' }, claim);
  assert.equal(good.origin, 'https://192.168.1.20:8788');
});

test('normalizes mapped IPv6 origins', () => {
  for (const c of MAPPED) {
    assert.match(unusableHostReason(c.host), c.why, c.host);
    assert.equal(parseAdvertisedOrigin(c.origin).ok, false, c.origin);
  }
  assert.match(unusableHostReason('::ffff:0.0.0.0'), /unspecified \(wildcard\) address/);
  assert.match(unusableHostReason('::ffff:224.0.0.1'), /multicast address/);
  assert.match(unusableHostReason('::ffff:240.0.0.1'), /reserved or broadcast address/);
  assert.match(unusableHostReason('::ffff:255.255.255.255'), /reserved or broadcast address/);
  assert.equal(unusableHostReason('::ffff:192.168.1.20'), null);
  assert.equal(unusableHostReason('::1'), null, 'loopback must not be folded as ::a.b.c.d');
  assert.equal(unusableHostReason('2001:db8::1'), null);
  for (const bad of ['::ffff:1:2:3:4:5:6:7:8', '1:2:3', 'gggg::1', '::ffff:999.1.1.1']) {
    assert.ok(unusableHostReason(bad) !== null, bad);
  }
});

test('applies origin validation to every consumer', () => {
  const key = `qme_${'a'.repeat(43)}`;
  const fingerprint = 'ab'.repeat(32);
  const server = {
    mobileInstallationId: '11111111-1111-4111-8111-111111111111',
    legacyInstallationId: '22222222-2222-4222-8222-222222222222',
    serverSigningPublicKey: Buffer.alloc(32, 7).toString('base64url'),
    serverSigningFingerprint: 'cd'.repeat(32),
    tlsLeafFingerprint: 'ef'.repeat(32),
  };
  const claim = {
    enrolmentId: Buffer.alloc(16, 1).toString('base64url'),
    claimEncryptionPublicKey: Buffer.alloc(32, 2).toString('base64url'),
    clientNonce: Buffer.alloc(16, 3).toString('base64url'),
    requestedScopes: ['containers.read'],
    deviceName: 'iPhone',
    expiresAt: Date.now() + 600_000,
  };
  for (const c of MAPPED) {
    process.env.MOBILE_API_ENABLED = 'true';
    const plan = mobileListenerPlan({ MOBILE_API_ENABLED: 'true', QM_ADVERTISED_ORIGIN: c.origin, MOBILE_PORT: '8788', MOBILE_BIND_ADDRESS: '::' });
    assert.equal(plan.ok, false, c.origin);
    assert.match(plan.reason, c.why);
    const dataDir = fresh();
    assert.equal(ensureMobileCertificate({ dataDir, host: c.host }).code, 'host_unusable', c.host);
    assert.equal(rotateMobileCertificate({ dataDir, host: c.host }).code, 'host_unusable', c.host);
    assert.throws(() => generalName(c.host), c.why, c.host);
    assert.throws(() => buildQrPayload(c.origin, key, fingerprint), /canonical https origin/, c.origin);
    const forged = `QMC2:${Buffer.from(JSON.stringify({ fingerprint, key, origin: c.origin, v: 2 }), 'utf8').toString('base64url')}`;
    assert.equal(parseQrPayload(forged).ok, false, c.origin);
    assert.throws(() => buildTranscript({ ...server, origin: c.origin }, claim), /canonical https origin/, c.origin);
  }
});
