import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-credential-status-'));
process.env.DATA_DIR = dataDir;
process.env.SECRET_KEY = '12'.repeat(32);
process.env.QM_HOST = '192.168.1.20';
const { pairPage } = await import('../src/ui/pages/pair.js');
const { pairReadyPage } = await import('../src/ui/pages/pair-ready.js');
const { credentialTag } = await import('../src/ui/bits.js');
const { buildBundle } = await import('../src/build.js');
const { applyMintedKeys } = await import('../src/detect.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));

const included = ['bazarr', 'lidarr', 'prowlarr', 'radarr', 'sonarr', 'tautulli'];
const missing = ['dockhand', 'jellyfin', 'portainer'];
const optional = ['glances', 'pihole', 'streamystats'];
const detected = [...included, ...missing, 'crowdsec', ...optional].map((kind, index) => ({
  instanceId: `${kind}-fixture`, kind, name: kind, port: 18000 + index,
  url: `http://192.168.1.20:${18000 + index}`, dockerState: 'running', up: true,
  ...(included.includes(kind) ? { apiKey: `PRIVATE-FIXTURE-${kind}-KEY` } : {}),
  ...(kind === 'crowdsec' ? { apiKey: 'PRIVATE-FIXTURE-BOUNCER-KEY' } : {}),
}));
const draft = {
  services: detected.map((service) => ({ instanceId: service.instanceId, included: true, baseUrl: service.url })),
  edgeAccess: {},
};
const configure = (rows = detected) => pairPage({
  stage: 'configure', detected: rows, draft, issues: [], csrf: 'fixture-csrf', mintEnabledKinds: [],
});
function serviceMarkup(html, kind) {
  const row = html.match(new RegExp(`<section\\b[^>]*data-kind="${kind}"[\\s\\S]*?<\\/section>`));
  assert.ok(row, `${kind} has a configure row`);
  return row[0];
}

test('13 selected services remain in the real payload and ready badges describe credentials only', () => {
  const bundle = buildBundle(detected, { qmTitle: 'Home', qmHost: '192.168.1.20' }, draft,
    '7ee0d8a0-34d6-46f6-8996-ec578f41f6e2', {
      bundleId: 'credential_status_fixture_01',
      issuedAt: '2026-09-11T12:00:00.000Z', expiresAt: '2026-09-11T12:03:00.000Z',
    });
  assert.equal(bundle.payload.services.length, 13);
  assert.deepEqual(bundle.payload.services.map((service) => service.kind), detected.map((service) => service.kind));
  assert.deepEqual(bundle.payload.profiles[0].serviceIds, bundle.payload.services.map((service) => service.id));
  const html = pairReadyPage({ bundle, qrDataUrl: 'data:image/png;base64,AAAA', filePath: '/pair/file/fixture', csrf: 'fixture-csrf' });
  assert.equal((html.match(/class="pair-ready-row"/g) || []).length, 13);
  assert.match(html, /Handing over 13 services/);
  assert.match(html, /Every service listed below is included/);
  assert.doesNotMatch(html, /Not included|No key needed|PRIVATE-FIXTURE/);

  for (const summary of bundle.summary) {
    const service = bundle.payload.services.find((item) => item.kind === summary.kind);
    const tag = credentialTag(summary, 'ready');
    assert.ok(html.includes(tag), `${summary.kind} uses the actual summary badge`);
    assert.equal(service.baseUrl, detected.find((item) => item.kind === summary.kind).url);
    if (included.includes(service.kind)) {
      assert.match(tag, />Credential included</);
      assert.deepEqual(service.secrets, { apiKey: `PRIVATE-FIXTURE-${service.kind}-KEY` });
      assert.equal(service.disabled, undefined);
    } else {
      assert.deepEqual(service.secrets, {});
      if (optional.includes(service.kind)) {
        assert.match(tag, />No credential supplied</);
        assert.equal(service.disabled, undefined);
      } else {
        assert.equal(service.disabled, true, `${service.kind} is retained awaiting credentials`);
        assert.match(tag, service.kind === 'crowdsec' ? />Sign in later</ : />Add API key in app</);
        assert.equal(service.credentialMode, service.kind === 'crowdsec' ? 'password' : 'api-key');
      }
    }
  }
});

test('configure keeps credential-free rows selected and offers the right optional credential fields', () => {
  const html = configure();
  assert.doesNotMatch(html, /No key needed|PRIVATE-FIXTURE/);
  for (const kind of [...missing, 'crowdsec', ...optional]) {
    assert.match(serviceMarkup(html, kind), /name="include_\d+" checked\s*>/, `${kind} is selected, not dropped`);
  }
  for (const [kind, label] of [
    ['pihole', 'Pi-hole password or app password'],
    ['streamystats', 'Jellyfin API key or access token'],
  ]) {
    const row = serviceMarkup(html, kind);
    assert.ok(row.includes(label), `${kind} names its actual credential`);
    assert.match(row, /<div class="pair-ladder" data-ladder>/, 'entry is available when the row expands');
    assert.match(row, /data-manual-key type="password" maxlength="16384" autocomplete="new-password"/);
    assert.match(row, /data-save-key>Save key</);
    assert.doesNotMatch(row, /data-manual-key[^>]*\bvalue=/, 'no secret is prefilled');
  }
  assert.doesNotMatch(serviceMarkup(html, 'glances'), /data-manual-key/);
  assert.doesNotMatch(serviceMarkup(html, 'crowdsec'), /data-manual-key/);
  assert.match(serviceMarkup(html, 'crowdsec'), /Companion transfers the reviewed addresses but no account password/);
});

test('the emitted refresh logic keeps optional entry usable after saving, removing and conflict updates', () => {
  const html = configure();
  const ladders = JSON.parse(html.match(/var LADDERS = ([^\n]+);/)[1]);
  const start = html.indexOf('function refreshRung(row) {');
  const end = html.indexOf('function setChip(row, state)', start);
  assert.ok(start > -1 && end > start);
  const refresh = new Function('LADDERS', `${html.slice(start, end)}; return refreshRung;`)(ladders);
  for (const kind of ['pihole', 'streamystats']) {
    const ladder = { hidden: true };
    const made = { on: false, classList: { toggle: (_name, value) => { made.on = value; } } };
    const next = { hidden: true };
    const parts = { '[data-ladder]': ladder, '[data-made]': made, '[data-next-step]': next };
    const row = { dataset: { instance: `${kind}-fixture`, credState: 'not-required', minted: '' }, querySelector: (selector) => parts[selector] };
    refresh(row);
    assert.equal(ladder.hidden, false, `${kind} optional entry is shown`);
    row.dataset.credState = 'included'; row.dataset.minted = '1';
    refresh(row);
    assert.equal(ladder.hidden, true);
    assert.equal(made.on, true);
    row.dataset.credState = 'not-required'; row.dataset.minted = '';
    refresh(row);
    assert.equal(ladder.hidden, false, `${kind} can accept a replacement after removal`);
    assert.equal(made.on, false);
    row.dataset.credState = 'conflict';
    refresh(row);
    assert.equal(ladder.hidden, true, 'conflicts do not expose an overwrite shortcut');
  }
  assert.equal(ladders['glances-fixture'], undefined);
  assert.equal(ladders['crowdsec-fixture'], undefined);
});


test('only an actually applied stored credential exposes Remove after a fresh configure render', () => {
  for (const kind of ['dockhand', 'pihole', 'streamystats']) {
    const source = detected.find((row) => row.kind === kind);
    const record = { kind, apiKey: 'SEALED-FIXTURE-KEY', createdBy: 'manual' };
    const saved = applyMintedKeys([source], { [source.instanceId]: record }).services[0];
    assert.equal(saved.storedCredential, true);
    const html = configure([saved]);
    assert.match(html, /data-minted="1"/);
    assert.match(html, /class="pair-ladder" data-ladder hidden/);
    assert.match(html, /class="key-made on" data-made/);
    assert.match(html, /data-forget>Remove from Companion</);
    assert.match(html, /does not revoke the service key/);
    assert.match(html, /credentials already imported on your phone stay unchanged/);
    assert.doesNotMatch(html, /SEALED-FIXTURE-KEY/);
    for (const sourceKind of ['file', 'homepage']) {
      for (const currentKey of [record.apiKey, 'DIFFERENT-SOURCE-KEY']) {
        const discovered = { ...source, apiKey: currentKey, sources: [sourceKind] };
        const result = applyMintedKeys([discovered], { [source.instanceId]: record });
        assert.equal(result.services[0].storedCredential, undefined, `${sourceKind} remains the source`);
        assert.equal(result.services[0].apiKey, currentKey);
        assert.doesNotMatch(configure(result.services), /data-forget>|data-minted="1"/);
        assert.deepEqual(result.stale, currentKey === record.apiKey ? [] : [source.instanceId]);
      }
    }
    const conflict = applyMintedKeys([{ ...source, credentialConflict: true }], { [source.instanceId]: record }).services[0];
    assert.equal(conflict.storedCredential, undefined);
    assert.doesNotMatch(configure([conflict]), /data-forget>/);
  }
});


test('optional Plex, Tdarr and Gluetun fields stay usable after browser initialization and removal', () => {
  const entries = [
    { kind: 'plex', label: 'Plex X-Plex-Token (optional)', note: /Leave this empty to sign in with the Plex PIN flow/, empty: 'sign-in' },
    { kind: 'tdarr', label: 'Tdarr API key (optional)', note: /If your Tdarr server requires authentication/, empty: 'not-required' },
    { kind: 'gluetun', label: 'Gluetun control server API key (optional)', note: /allowed routes determine which features/, empty: 'not-required' },
  ];
  const rows = entries.map(({ kind }) => ({ ...detected[0], kind, name: kind, instanceId: `${kind}-fixture`, apiKey: undefined }));
  const html = configure(rows);
  const ladders = JSON.parse(html.match(/var LADDERS = ([^\n]+);/)[1]);
  const start = html.indexOf('function refreshRung(row) {');
  const end = html.indexOf('function setChip(row, state)', start);
  const refresh = new Function('LADDERS', `${html.slice(start, end)}; return refreshRung;`)(ladders);
  for (const entry of entries) {
    const markup = serviceMarkup(html, entry.kind);
    assert.ok(markup.includes(entry.label));
    assert.match(markup, entry.note);
    assert.match(markup, /data-manual-key type="password" maxlength="16384"/);
    const ladder = { hidden: false };
    const made = { on: false, classList: { toggle: (_name, value) => { made.on = value; } } };
    const row = {
      dataset: { instance: `${entry.kind}-fixture`, credState: entry.empty, minted: '' },
      querySelector: (selector) => ({ '[data-ladder]': ladder, '[data-made]': made })[selector],
    };
    refresh(row);
    assert.equal(ladder.hidden, false, `${entry.kind} is available after initialization`);
    row.dataset.credState = 'included'; row.dataset.minted = '1';
    refresh(row);
    assert.equal(ladder.hidden, true);
    assert.equal(made.on, true);
    row.dataset.credState = entry.empty; row.dataset.minted = '';
    refresh(row);
    assert.equal(ladder.hidden, false, `${entry.kind} accepts replacement after removal`);
    assert.equal(made.on, false);
    row.dataset.credState = 'conflict';
    refresh(row);
    assert.equal(ladder.hidden, true);
  }
});
