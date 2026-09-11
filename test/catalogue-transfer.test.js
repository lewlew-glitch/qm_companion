import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PORTS, pairingCredentialState } from '../src/kinds.js';
import { mergeDetectedServices } from '../src/detect.js';
import { buildBundle, defaultPairDraft } from '../src/build.js';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-catalogue-transfer-'));
process.env.SECRET_KEY = '12'.repeat(32);
process.env.DATA_DIR = dataDir;
process.env.QM_HOST = '192.168.1.20';
const { credentialTag } = await import('../src/ui/bits.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));

const modes = {
  requiredKey: 'radarr sonarr lidarr prowlarr bazarr sabnzbd jackett nzbhydra2 qui jellyfin emby jellyseerr wizarr tautulli jellystat tracearr portainer dockhand arcane coolify dispatcharr technitium homeassistant unifi proxmox truenas unraid komga kavita audiobookshelf readmeabook shelfarr immich'.split(' '),
  optionalKey: ['pihole', 'streamystats', 'tdarr', 'gluetun', 'glances'],
  optionalLogin: ['transmission', 'adguard', 'dozzle', 'maintainerr', 'scrutiny', 'shelfmark'],
  requiredLogin: ['qbittorrent', 'deluge', 'synology', 'nzbget', 'ugreen', 'musicseerr', 'beszel', 'bookorbit', 'crowdsec'],
  pairedKey: ['komodo'],
  oauth: ['plex'],
};
const policy = new Map(Object.entries(modes).flatMap(([mode, kinds]) => kinds.map((kind) => [kind, mode])));
const installationId = '7ee0d8a0-34d6-46f6-8996-ec578f41f6e2';
const cfg = { qmTitle: 'Home', qmHost: '192.168.1.20' };
function bundle(rows, selected = rows, id = 'catalogue_transfer_fixture_01') {
  const draft = defaultPairDraft(rows, cfg);
  const ids = new Set(selected.map((row) => row.instanceId));
  draft.services = draft.services.map((row) => ({ ...row, included: ids.has(row.instanceId), remoteBaseUrl: `https://${row.instanceId}.example.test/service` }));
  return buildBundle(rows, cfg, draft, installationId, {
    bundleId: id, issuedAt: '2026-09-11T12:00:00.000Z', expiresAt: '2026-09-11T12:03:00.000Z',
  });
}
function rowsWithKeys(hasKeys, copies = 1) {
  const rows = Object.keys(PORTS).flatMap((kind, index) => Array.from({ length: copies }, (_, copy) => ({
    kind, name: `${kind}-${copy}`, identity: `docker:${kind}-${copy}`, aliases: [`${kind}-${copy}`],
    publishedPort: 18000 + index * copies + copy, containerPort: PORTS[kind],
    dockerState: 'running', up: true, sources: ['docker'],
    ...(hasKeys ? { apiKey: `CATALOGUE-SECRET-${kind}-${copy}` } : {}),
  })));
  return mergeDetectedServices(rows, []).map((row) => ({ ...row, availability: 'reachable' }));
}
function decode(result) {
  const e = JSON.parse(result.envelopeJson);
  const key = scryptSync(result.setupCode, Buffer.from(e.kdf.saltHex, 'hex'), 48,
    { N: e.kdf.N, r: e.kdf.r, p: e.kdf.p, maxmem: 256 * 1024 * 1024 }).subarray(0, 32);
  const bytes = Buffer.from(e.ciphertextHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.cipher.nonceHex, 'hex'));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]));
}

test('every supported kind has an explicit handoff credential contract', () => {
  assert.equal(policy.size, 55);
  assert.deepEqual([...policy.keys()].sort(), Object.keys(PORTS).sort());
});
for (const hasKeys of [false, true]) test(`all 55 kinds survive an encrypted handoff with credentials ${hasKeys ? 'supplied' : 'absent'}`, () => {
  const rows = rowsWithKeys(hasKeys);
  const result = bundle(rows);
  const payload = decode(result);
  assert.deepEqual(payload, result.payload);
  assert.equal(payload.services.length, 55);
  assert.deepEqual(payload.profiles[0].serviceIds, payload.services.map((service) => service.id));
  assert.equal(new Set(payload.services.map((service) => service.id)).size, 55);
  assert.doesNotMatch(result.envelopeJson, /CATALOGUE-SECRET/);
  for (const service of payload.services) {
    const mode = policy.get(service.kind);
    const source = rows.find((row) => row.name === service.label);
    const transferable = hasKeys && ['requiredKey', 'optionalKey', 'oauth'].includes(mode);
    const optional = mode === 'optionalKey' || mode === 'optionalLogin';
    assert.deepEqual(service.secrets, transferable ? { apiKey: source.apiKey } : {}, service.kind);
    assert.equal(service.disabled === true, !transferable && !optional, service.kind);
    assert.equal(service.baseUrl.endsWith(`:${source.port}`), true, service.kind);
    assert.equal(service.remoteBaseUrl, `https://${source.instanceId}.example.test/service`);
    const expectedState = transferable ? 'included' : optional ? 'not-required' : mode === 'pairedKey' ? 'key-and-secret' : (mode === 'oauth' || mode === 'requiredLogin') ? 'sign-in' : 'missing-key';
    assert.equal(pairingCredentialState(service.kind, source.apiKey), expectedState, service.kind);
    const summary = result.summary.find((row) => row.kind === service.kind);
    assert.equal(summary.credentialState, expectedState, service.kind);
    const tag = credentialTag(summary, 'ready');
    assert.doesNotMatch(tag, /CATALOGUE-SECRET|Not included|No key needed/);
    assert.equal(tag.includes('Credential included'), transferable, service.kind);
    if (service.kind === 'plex') assert.equal(service.credentialMode, 'plex');
    if (mode === 'requiredLogin') assert.equal(service.credentialMode, 'password');
    if (mode === 'pairedKey') assert.equal(service.credentialMode, 'key-and-secret');
  }
});

test('larger mixed stacks preserve exact selected instances, routes and keys across reissues', () => {
  const rows = rowsWithKeys(true, 2);
  assert.equal(rows.length, 110);
  assert.equal(new Set(rows.map((row) => row.instanceId)).size, 110);
  const selected = rows.filter((_row, index) => index % 2 === 1);
  const first = bundle(rows, selected);
  const renewed = bundle([...rows].reverse(), [...selected].reverse(), 'catalogue_transfer_fixture_02');
  const firstByLabel = new Map(first.payload.services.map((service) => [service.label, service]));
  assert.equal(first.payload.services.length, 55);
  for (const service of renewed.payload.services) assert.deepEqual(service, firstByLabel.get(service.label));
  const payload = decode(first);
  for (const row of rows) {
    const service = payload.services.find((item) => item.label === row.name);
    assert.equal(!!service, selected.includes(row), row.name);
    if (!selected.includes(row)) assert.equal(JSON.stringify(payload).includes(row.apiKey), false, row.name);
  }
  assert.deepEqual(new Set(payload.services.map((service) => service.label)), new Set(selected.map((row) => row.name)));
});

test('64 selected instances export fully and larger transfers fail explicitly without truncation', () => {
  const rows = rowsWithKeys(false, 2);
  const full = bundle(rows, rows.slice(0, 64));
  assert.equal(decode(full).services.length, 64);
  assert.throws(() => bundle(rows, rows.slice(0, 65)), /Select up to 64 services, then send the rest in another transfer/);
  assert.throws(() => bundle(rows, []), /Pick at least one/);
});
