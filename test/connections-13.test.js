import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PORTS, matchImage, canTransferApiKey, pairingCredentialState, minimumAppVersionForKind } from '../src/kinds.js';
import { canSaveManualKey, ladderFor } from '../src/keyladder.js';
import { homepageCredential, publishedMappingOf } from '../src/detect.js';
import { buildBundle, defaultPairDraft } from '../src/build.js';
import { MARKETPLACE_MODES, marketplaceEntry } from '../src/marketplace.js';

const dir = mkdtempSync(join(tmpdir(), 'qm-new-connections-'));
process.env.DATA_DIR = dir;
process.env.SECRET_KEY = '32'.repeat(32);
process.env.QM_HOST = '192.168.1.20';
const { pairPage } = await import('../src/ui/pages/pair.js');
const { pairReadyPage } = await import('../src/ui/pages/pair-ready.js');
after(() => rmSync(dir, { recursive: true, force: true }));
const additions = ['uptimekuma', 'peanut', 'pulsarr'];
const cfg = { qmTitle: 'Home', qmHost: '192.168.1.20' };
const rows = ['radarr', ...additions].map((kind, index) => ({
  instanceId: `${kind}-fixture`, kind, name: kind, dockerState: 'running', up: true,
  availability: 'reachable', port: 18000 + index, containerPort: PORTS[kind],
  url: `http://192.168.1.20:${18000 + index}`,
  apiKey: `fixture-${kind}-key`,
}));
function build(draft = defaultPairDraft(rows, cfg), input = rows) {
  return buildBundle(input, cfg, draft, 'connections_13_installation', {
    bundleId: 'connections_13_bundle_fixture', issuedAt: '2026-09-18T12:00:00.000Z', expiresAt: '2026-09-18T12:03:00.000Z',
  });
}
function configure(draft = defaultPairDraft(rows, cfg)) {
  return pairPage({ stage: 'configure', detected: rows, draft, issues: [], csrf: 'fixture-csrf' });
}
const serviceMarkup = (html, kind) => html.match(new RegExp(`<section\\b[^>]*data-kind="${kind}"[\\s\\S]*?<\\/section>`))[0];

test('recognizes official images and keeps new-kind matches exact', () => {
  for (const [kind, image] of [['uptimekuma', 'louislam/uptime-kuma'], ['peanut', 'brandawg93/peanut'], ['pulsarr', 'lakker/pulsarr']]) {
    for (const suffix of [':latest', `@sha256:${'a'.repeat(64)}`]) assert.equal(matchImage(image + suffix, 'service'), kind);
    assert.equal(matchImage('custom/image', kind), kind);
    assert.equal(matchImage(`custom/${kind}-exporter`, `${kind}-worker`), null);
    assert.equal(matchImage('custom/image', `not-${kind}`), null);
    assert.equal(minimumAppVersionForKind(kind), '1.3');
    const entry = marketplaceEntry(kind);
    assert.equal(entry.mode, MARKETPLACE_MODES.CONNECT_ONLY);
    assert.equal(entry.starter, null);
    assert.match(entry.upstreamUrl, /^https:\/\/github\.com\//);
  }
  assert.equal(minimumAppVersionForKind('radarr'), undefined);
});

test('uses the exact scalar or app-login credential contract for all additions', () => {
  assert.equal(pairingCredentialState('uptimekuma'), 'not-required');
  assert.equal(pairingCredentialState('uptimekuma', 'fixture-key'), 'included');
  assert.equal(canSaveManualKey('uptimekuma'), true);
  assert.equal(ladderFor('uptimekuma').settingsPath, '/settings/api-keys');
  assert.equal(pairingCredentialState('pulsarr'), 'missing-key');
  assert.equal(pairingCredentialState('pulsarr', 'fixture-key'), 'included');
  assert.equal(ladderFor('pulsarr').class, 'manual');
  assert.equal(canTransferApiKey('peanut'), false);
  assert.equal(canSaveManualKey('peanut'), false);
  assert.equal(ladderFor('peanut'), null);
  assert.equal(pairingCredentialState('peanut', 'ups-name-not-a-key'), 'not-required');
  // Homepage PeaNUT key means UPS name; Kuma uses a public status slug. Neither is a metrics/API key.
  for (const kind of additions) assert.deepEqual(homepageCredential(kind, {
    'homepage.widget.type': kind, 'homepage.widget.key': 'wrong-kind-of-value',
    'homepage.widget.username': 'fixture-user', 'homepage.widget.password': 'fixture-password',
  }), { apiKey: undefined, credentialConflict: false });
});

test('leaves new kinds unselected for 1.2 while explicit selection retains their exact credential contracts', () => {
  const draft = defaultPairDraft(rows, cfg);
  assert.deepEqual(draft.services.filter((r) => r.included).map((r) => r.instanceId), ['radarr-fixture']);
  const old = build(draft);
  assert.deepEqual(old.payload.services.map((s) => s.kind), ['radarr']);
  assert.doesNotMatch(pairReadyPage({ bundle: old, qrDataUrl: 'data:image/png;base64,AA', csrf: 'fixture' }), /requires Quartermaster 1\.3/);
  for (const row of draft.services) row.included = additions.some((kind) => row.instanceId === `${kind}-fixture`);
  const bundle = build(draft);
  assert.deepEqual(bundle.payload.services.map((s) => s.kind), additions);
  for (const service of bundle.payload.services) {
    assert.deepEqual(service.secrets, service.kind === 'peanut' ? {} : { apiKey: `fixture-${service.kind}-key` });
    assert.equal(service.disabled, undefined);
    assert.equal(service.credentialMode, undefined);
  }
  assert.doesNotMatch(bundle.envelopeJson, /fixture-.*-key/);
  assert.match(pairReadyPage({ bundle, qrDataUrl: 'data:image/png;base64,AA', csrf: 'fixture' }), /requires Quartermaster 1\.3 or later/);
  const withoutKeys = build(draft, rows.map(({ apiKey: _key, ...row }) => row)).payload.services;
  assert.equal(withoutKeys.find((s) => s.kind === 'pulsarr').disabled, true);
  assert.equal(withoutKeys.find((s) => s.kind === 'pulsarr').credentialMode, 'api-key');
  for (const kind of ['peanut', 'uptimekuma']) assert.equal(withoutKeys.find((s) => s.kind === kind).disabled, undefined);
});

test('uses mapped ports and explains compatibility and PeaNUT sign-in without exposing its password', () => {
  for (const kind of additions) assert.deepEqual(publishedMappingOf([
    { Type: 'tcp', PrivatePort: PORTS[kind], PublicPort: 19000, IP: '0.0.0.0' },
  ], kind), { privatePort: PORTS[kind], publicPort: 19000 });
  const html = configure();
  for (const kind of additions) {
    const row = serviceMarkup(html, kind);
    assert.match(row, /Requires Quartermaster 1\.3 or later/);
    assert.doesNotMatch(row, /name="include_\d+" checked/);
  }
  assert.doesNotMatch(serviceMarkup(html, 'peanut'), /data-manual-key/);
  assert.match(serviceMarkup(html, 'peanut'), /Companion does not transfer this password/);
  const source = /function refreshRung\(row\) \{([\s\S]*?)\n        \}/.exec(html)[0];
  const next = { hidden: false };
  const row = { dataset: { kind: 'peanut', credState: 'not-required', instance: 'peanut-fixture' },
    querySelector: (selector) => selector === '[data-next-step]' ? next : null };
  new Function('LADDERS', `return (${source});`)({})(row);
  assert.equal(next.hidden, false, 'initial browser setup keeps the app sign-in explanation visible');
});
