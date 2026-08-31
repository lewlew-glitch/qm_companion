import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-companion-pair-offline-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = '192.168.1.20';
process.env.DATA_DIR = dataDir;
process.env.DOCKER_ACCESS_MAX = 'read';

const { buildBundle, defaultPairDraft, includedByDefault, availabilityOf, dockerStateWord, PairingValidationError } = await import('../src/build.js');
const { pairPage } = await import('../src/ui/views.js');
const offlineModule = await import('../src/ui/pages/pair-offline.js');
const { pairReadinessLine, availabilityNoteText, pairGroupFor, availabilityChip, INCLUDE_ANYWAY_COPY } = offlineModule;
const { mergeDetectedServices, mergeLiveProbes, availabilityFor } = await import('../src/detect.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

const cfg = { qmTitle: 'Home', qmHost: '192.168.1.20' };
const installationId = '7ee0d8a0-34d6-46f6-8996-ec578f41f6e2';
const metadata = { bundleId: 'b1234567890abcdefghijklm', issuedAt: '2026-08-21T18:00:00.000Z', expiresAt: '2026-08-21T18:03:00.000Z' };

const detected = [
  { instanceId: 'radarr-up', kind: 'radarr', name: 'Radarr', port: 7878, apiKey: 'radarr-key', dockerState: 'running', up: true, url: 'http://192.168.1.20:7878', availability: 'reachable' },
  { instanceId: 'sonarr-unreachable', kind: 'sonarr', name: 'Sonarr', port: 8989, apiKey: 'sonarr-key', dockerState: 'running', up: false, url: 'http://192.168.1.20:8989', availability: 'unreachable' },
  { instanceId: 'lidarr-stopped', kind: 'lidarr', name: 'Lidarr', port: 8686, apiKey: 'lidarr-key', dockerState: 'exited', up: false, url: null, availability: 'not-running' },
  { instanceId: 'prowlarr-unverified', kind: 'prowlarr', name: 'Prowlarr', port: 9696, apiKey: 'prowlarr-key', up: null, url: null, availability: 'unverified' },
  { instanceId: 'bazarr-conflict', kind: 'bazarr', name: 'Bazarr', port: 6767, apiKey: 'bazarr-key', credentialConflict: true, dockerState: 'running', up: true, availability: 'reachable' },
];

function compileInlineScripts(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  return scripts.length;
}

function rowFor(html, instanceId) {
  const at = html.indexOf(`data-instance="${instanceId}"`);
  assert.notEqual(at, -1, `${instanceId} row exists`);
  const start = html.lastIndexOf('<section class="pair-service', at);
  const end = html.indexOf('</section>', at);
  return html.slice(start, end);
}

function draftRow(instanceId, port, extra = {}) {
  return { instanceId, included: true, baseUrl: `http://192.168.1.20:${port}`, remoteBaseUrl: '', ...extra };
}

test('default draft selects only reachable rows', () => {
  const draft = defaultPairDraft(detected, cfg);
  const included = Object.fromEntries(draft.services.map((row) => [row.instanceId, row.included]));
  assert.deepEqual(included, {
    'radarr-up': true,
    'sonarr-unreachable': false,
    'lidarr-stopped': false,
    'prowlarr-unverified': false,
    'bazarr-conflict': false,
  });
  assert.equal(includedByDefault({ kind: 'radarr' }), false);
  assert.equal(includedByDefault({ kind: 'radarr', up: true }), false);
  assert.equal(availabilityOf({ kind: 'radarr' }), 'unverified');
  assert.equal(availabilityOf({ dockerState: 'running', up: true }), 'reachable');
  assert.equal(availabilityOf({ availability: 'not-running' }), 'not-running', 'a carried word wins');
  for (const d of detected) assert.equal(availabilityOf(d), availabilityFor(d), `${d.instanceId} carries the word detect derives`);
  assert.deepEqual(detected.map(pairGroupFor), ['reachable', 'unreachable', 'stopped', 'unverified', 'reachable']);
});

test('renders lifecycle state in status copy', () => {
  assert.equal(dockerStateWord('exited'), 'Stopped');
  assert.equal(dockerStateWord('paused'), 'Paused');
  assert.equal(dockerStateWord('restarting'), 'Restarting');
  assert.equal(dockerStateWord('created'), 'Created, never started');
  assert.equal(dockerStateWord('dead'), 'Dead');
  assert.match(availabilityChip('not-running', 'paused'), /class="badge bad">[\s\S]*Paused<\/span>/);
  assert.match(availabilityChip('unreachable'), /class="badge warn">[\s\S]*Unreachable from Companion<\/span>/);
  assert.equal(availabilityChip('unverified'), '<span class="badge line">Not checked</span>');
  assert.equal(availabilityChip('reachable'), '');
  assert.equal(availabilityNoteText('not-running', '', 'restarting'), 'Restarting in Docker. Start it in Docker; this page updates on its own.');
  assert.match(availabilityNoteText('unreachable', 'http://192.168.1.20:8989'), /^Running in Docker, but Companion could not reach it at http:\/\/192\.168\.1\.20:8989\./);
  assert.match(availabilityNoteText('unreachable', 'http://192.168.1.20:8989'), /VPN/);
  assert.match(availabilityNoteText('unverified'), /^Not checked:/);
  assert.equal(availabilityNoteText('reachable'), '');

  const ready = { ready: true, line: 'Everything selected is ready' };
  assert.equal(pairReadinessLine(ready, { unreachable: 0, stopped: 0 }), 'Everything selected is ready');
  assert.equal(pairReadinessLine(ready, { unreachable: 1, stopped: 0 }), 'Everything selected is ready · 1 unreachable, not included');
  assert.equal(pairReadinessLine(ready, { unreachable: 0, stopped: 2 }), 'Everything selected is ready · 2 not running');
  assert.equal(pairReadinessLine({ ready: false, line: 'Watching for 1 service key' }, { unreachable: 1, stopped: 1 }), 'Watching for 1 service key · 1 unreachable, not included · 1 not running');
});

test('buildBundle applies availability and override rules', () => {
  const reachable = { services: [draftRow('radarr-up', 7878)], edgeAccess: {} };
  assert.deepEqual(buildBundle(detected, cfg, reachable, installationId, metadata).summary.map((s) => s.instanceId), ['radarr-up']);

  const forcedReachable = { services: [draftRow('radarr-up', 7878, { forced: true })], edgeAccess: {} };
  assert.deepEqual(buildBundle(detected, cfg, forcedReachable, installationId, metadata).summary.map((s) => s.instanceId), ['radarr-up'], 'a forced flag on a reachable row is ignored');

  const unreachable = { services: [draftRow('sonarr-unreachable', 8989)], edgeAccess: {} };
  assert.throws(
    () => buildBundle(detected, cfg, unreachable, installationId, metadata),
    (error) => error instanceof PairingValidationError && error.issues[0] === 'Sonarr is running but Companion cannot reach it. Check its address, or choose Include anyway if your phone can reach it.',
  );
  const forcedUnreachable = { services: [draftRow('sonarr-unreachable', 8989, { forced: true })], edgeAccess: {} };
  assert.deepEqual(buildBundle(detected, cfg, forcedUnreachable, installationId, metadata).summary.map((s) => s.instanceId), ['sonarr-unreachable']);

  for (const forced of [false, true]) {
    const stopped = { services: [draftRow('lidarr-stopped', 8686, { forced })], edgeAccess: {} };
    assert.throws(
      () => buildBundle(detected, cfg, stopped, installationId, metadata),
      (error) => error instanceof PairingValidationError && error.name === 'PairingValidationError' && error.issues[0] === 'Lidarr is stopped in Docker. Start it, then create the transfer again.',
      `a Docker-confirmed stopped container is refused${forced ? ' even when forced' : ''}`,
    );
  }
  const paused = detected.map((d) => (d.instanceId === 'lidarr-stopped' ? { ...d, dockerState: 'paused' } : d));
  assert.throws(
    () => buildBundle(paused, cfg, { services: [draftRow('lidarr-stopped', 8686, { forced: true })], edgeAccess: {} }, installationId, metadata),
    (error) => error instanceof PairingValidationError && error.issues[0] === 'Lidarr is paused in Docker. Start it, then create the transfer again.',
  );

  const unverified = { services: [draftRow('prowlarr-unverified', 9696)], edgeAccess: {} };
  assert.deepEqual(buildBundle(detected, cfg, unverified, installationId, metadata).summary.map((s) => s.instanceId), ['prowlarr-unverified'], 'an owner-ticked unverified row is accepted');
});

test('renders controls for each availability group', () => {
  const html = pairPage({
    stage: 'configure', detected, draft: defaultPairDraft(detected, cfg), issues: [], csrf: 'csrf-token', mintEnabledKinds: [],
  });
  assert.match(html, /data-pair-reachable-rows>[\s\S]*data-instance="radarr-up"[\s\S]*data-pair-section="unreachable">[\s\S]*data-instance="sonarr-unreachable"[\s\S]*data-pair-section="stopped">[\s\S]*data-instance="lidarr-stopped"[\s\S]*data-pair-section="unverified">[\s\S]*data-instance="prowlarr-unverified"/);
  assert.match(html, /Not reachable from Companion/);
  assert.match(html, /<div class="sec-h">Not running<\/div>/);
  assert.match(html, /<div class="sec-h">Not checked<\/div>/);
  assert.match(html, /data-pair-section="stopped">\s*<div class="sec-h">Not running<\/div>\s*<p class="cc-hint">Docker reports these containers are not running, so they cannot be handed over\. Start one in Docker; this page updates on its own\./);

  const sonarr = rowFor(html, 'sonarr-unreachable');
  assert.match(sonarr, /class="pair-service is-unreachable"/);
  assert.match(sonarr, /data-avail="unreachable" data-docker-state="running"/);
  assert.match(sonarr, /<input type="checkbox" name="include_1"\s+disabled>/);
  assert.match(sonarr, /<span class="badge warn">[\s\S]*?Unreachable from Companion<\/span>/);
  assert.match(sonarr, /data-avail-note-text>Running in Docker, but Companion could not reach it at http:\/\/192\.168\.1\.20:8989\./);
  assert.match(sonarr, /data-include-anyway>Include anyway<\/button><small>Your phone may reach it even though Companion cannot; it will be checked on the phone before it is saved\.<\/small>/);
  assert.match(sonarr, /name="force_1" value="" data-force-flag/, 'the override flag starts unset');

  const lidarr = rowFor(html, 'lidarr-stopped');
  assert.match(lidarr, /class="pair-service is-stopped"/);
  assert.match(lidarr, /data-avail="not-running" data-docker-state="exited"/);
  assert.match(lidarr, /<input type="checkbox" name="include_2"\s+disabled>/, 'not-running rows are unticked and disabled');
  assert.match(lidarr, /<span class="badge bad">[\s\S]*?Stopped<\/span>/);
  assert.match(lidarr, /data-avail-note-text>Stopped in Docker\. Start it in Docker; this page updates on its own\.</);
  assert.doesNotMatch(lidarr, /data-include-anyway|Include anyway/, 'a not-running row has no override control');
  assert.doesNotMatch(lidarr, /Included automatically/);

  const prowlarr = rowFor(html, 'prowlarr-unverified');
  assert.match(prowlarr, /class="pair-service is-unverified"/);
  assert.match(prowlarr, /data-avail="unverified"/);
  assert.match(prowlarr, /<input type="checkbox" name="include_3"\s*>/, 'unverified rows are unticked but enabled');
  assert.match(prowlarr, /<span class="badge line">Not checked<\/span>/);
  assert.match(prowlarr, /data-avail-note-text>Not checked: Companion has no Docker state or probe answer/);
  assert.doesNotMatch(prowlarr, /data-include-anyway/);

  const radarr = rowFor(html, 'radarr-up');
  assert.match(radarr, /class="pair-service" data-pair-row/);
  assert.match(radarr, /data-avail="reachable"/);
  assert.match(radarr, /<input type="checkbox" name="include_0" checked\s*>/);
  assert.match(radarr, /Included automatically/);
  assert.match(radarr, /data-avail-note hidden>/);
  assert.match(radarr, /data-override-slot><\/span>/, 'and an empty override slot');

  assert.match(html, /id="pair-ready-line">Everything selected is ready · 1 unreachable, not included · 1 not running</);
  assert.match(html, /setAvailability\(row, s\.availability, s\.dockerState \|\| '', s\.url\)/, 'the poll moves rows by availability');
  assert.match(html, /pairReadinessLine\(readiness, leftOutCounts\(\)\)/);
  assert.doesNotMatch(html, /sonarr-key|radarr-key|prowlarr-key|lidarr-key/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('hides empty availability groups', () => {
  const rows = detected.filter((d) => d.availability === 'reachable' || d.availability === 'unverified');
  const draft = defaultPairDraft(rows, cfg);
  draft.services.find((row) => row.instanceId === 'prowlarr-unverified').included = true;
  const html = pairPage({ stage: 'configure', detected: rows, draft, issues: [], csrf: 'csrf-token', mintEnabledKinds: [] });
  assert.match(html, /data-pair-section="unreachable" hidden>/);
  assert.match(html, /data-pair-section="stopped" hidden>/);
  assert.match(html, /data-pair-section="unverified">/);
  assert.match(rowFor(html, 'prowlarr-unverified'), /<input type="checkbox" name="include_1" checked\s*>/);
  assert.doesNotMatch(html, /id="pair-ready-line">[^<]*(unreachable|not running)/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('maps Docker and probe state into bundle availability', () => {
  const local = mergeDetectedServices([
    { kind: 'radarr', name: 'radarr', identity: 'docker:radarr', aliases: ['radarr'], publishedPort: 7878, apiKey: 'radarr-key', sources: ['docker'], dockerState: 'running' },
    { kind: 'sonarr', name: 'sonarr', identity: 'docker:sonarr', aliases: ['sonarr'], publishedPort: 8989, apiKey: 'sonarr-key', sources: ['docker'], dockerState: 'running' },
    { kind: 'lidarr', name: 'lidarr', identity: 'docker:lidarr', aliases: ['lidarr'], apiKey: 'lidarr-key', sources: ['docker'], dockerState: 'exited', up: false },
  ], [
    { kind: 'prowlarr', name: 'prowlarr', identity: 'config:/stack/prowlarr', aliases: ['prowlarr'], configPort: 9696, apiKey: 'prowlarr-key', sources: ['config'] },
  ]);
  const rows = mergeLiveProbes(local, [
    { kind: 'radarr', port: 7878, up: true, confirmed: true, url: 'http://192.168.1.20:7878' },
    { kind: 'sonarr', port: 8989, up: false, confirmed: false, url: 'http://192.168.1.20:8989' },
    { kind: 'prowlarr', port: 9696, up: true, confirmed: true, url: 'http://192.168.1.20:9696' },
  ], '192.168.1.20');
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
  assert.equal(byKind.radarr.availability, 'reachable');
  assert.equal(byKind.sonarr.availability, 'unreachable');
  assert.equal(byKind.lidarr.availability, 'not-running');
  assert.equal(byKind.lidarr.dockerState, 'exited');
  assert.equal(byKind.prowlarr.availability, 'unverified');
  assert.equal(byKind.prowlarr.up, true);

  const draft = defaultPairDraft(rows, cfg);
  assert.deepEqual(draft.services.filter((row) => row.included).map((row) => row.instanceId), [byKind.radarr.instanceId]);
  const everything = { ...draft, services: draft.services.map((row) => ({ ...row, included: true, forced: true })) };
  assert.throws(
    () => buildBundle(rows, cfg, everything, installationId, metadata),
    (error) => error instanceof PairingValidationError && /stopped in Docker/.test(error.issues[0]),
    'expected failure',
  );
  const withoutStopped = { ...draft, services: draft.services.filter((row) => row.instanceId !== byKind.lidarr.instanceId).map((row) => ({ ...row, included: true, forced: true })) };
  const bundle = buildBundle(rows, cfg, withoutStopped, installationId, metadata);
  assert.deepEqual(bundle.summary.map((s) => s.kind).sort(), ['prowlarr', 'radarr', 'sonarr']);
});

function fakeDom() {
  const listeners = {};
  const doc = { activeElement: null, listeners, addEventListener(name, fn) { listeners[name] = fn; } };
  function container(name) {
    return { name, children: [], insertBefore(row, next) {
      if (row.parentNode) row.parentNode.children.splice(row.parentNode.children.indexOf(row), 1);
      const at = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(at, 0, row);
      row.parentNode = this;
    } };
  }
  const groups = { reachable: container('reachable'), unreachable: container('unreachable'), stopped: container('stopped'), unverified: container('unverified') };
  const sections = { unreachable: { hidden: true }, stopped: { hidden: true }, unverified: { hidden: true } };
  const allRows = () => Object.values(groups).flatMap((g) => g.children);
  doc.querySelector = (sel) => {
    const rows = /data-pair-(\w+)-rows/.exec(sel);
    if (rows) return groups[rows[1]];
    const section = /data-pair-section="(\w+)"/.exec(sel);
    return section ? sections[section[1]] : null;
  };
  doc.querySelectorAll = (sel) => {
    const avail = /data-avail="([\w-]+)"/.exec(sel);
    return allRows().filter((row) => !avail || row.dataset.avail === avail[1]);
  };
  function row(order, avail = 'reachable') {
    const pick = { checked: avail === 'reachable', disabled: avail === 'unreachable' || avail === 'not-running' };
    const chip = { innerHTML: '' };
    const note = { hidden: avail === 'reachable' };
    const noteText = { textContent: '' };
    const slot = { innerHTML: '' };
    const flag = { value: '' };
    const input = {};
    const r = { dataset: { avail, dockerState: avail === 'not-running' ? 'exited' : 'running', order: String(order), credState: 'included' }, parentNode: null, input,
      contains: (node) => node === input || node === pick,
      querySelector: (sel) => (sel.includes('.pair-pick') ? pick : sel.includes('data-cred') ? chip : sel.includes('data-force-flag') ? flag : sel.includes('data-override-slot') ? slot : sel.includes('data-avail-note-text') ? noteText : note) };
    groups[offlineModule.GROUP_BY_AVAILABILITY[avail]].insertBefore(r, null);
    return { r, pick, chip, note, noteText, slot, flag, input };
  }
  return { doc, groups, sections, row };
}

function clientHalf(doc) {
  const factory = new Function('document', 'chipHtml', 'ALERT', `${offlineModule.PAIR_OFFLINE_SCRIPT}\nreturn { setAvailability: setAvailability, includeAnyway: includeAnyway, leftOutCounts: leftOutCounts, countOffline: countOffline };`);
  return factory(doc, () => '<span class="badge ok">Key ready</span>', '<svg/>');
}

test('applies poll failure and recovery thresholds', () => {
  const dom = fakeDom();
  const { r, pick, chip, slot, note } = dom.row(0);
  const { setAvailability, countOffline } = clientHalf(dom.doc);
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(r.dataset.avail, 'reachable', 'a single miss is not an outage');
  assert.equal(pick.checked, true);
  assert.equal(r.parentNode, dom.groups.reachable);
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(r.dataset.avail, 'unreachable', 'two consecutive misses demote');
  assert.equal(pick.disabled, true);
  assert.equal(pick.checked, false);
  assert.match(chip.innerHTML, /Unreachable from Companion/);
  assert.match(slot.innerHTML, /data-include-anyway/, 'the override is injected into an unreachable row');
  assert.equal(note.hidden, false);
  assert.equal(r.parentNode, dom.groups.unreachable);
  assert.equal(dom.sections.unreachable.hidden, false);
  assert.equal(countOffline(), 1);
  setAvailability(r, 'reachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(r.dataset.avail, 'reachable', 'promotion is immediate');
  assert.equal(pick.checked, true, 'the earlier tick comes back');
  assert.equal(pick.disabled, false);
  assert.equal(slot.innerHTML, '', 'the override leaves with the state');
  assert.equal(chip.innerHTML, '<span class="badge ok">Key ready</span>');
  assert.equal(r.parentNode, dom.groups.reachable);
  assert.equal(dom.sections.unreachable.hidden, true);
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  setAvailability(r, 'reachable', 'running', 'http://192.168.1.20:8989');
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(r.dataset.avail, 'reachable', 'an answer in between resets the miss count');
});

test('Docker stop disables override until the row is running again', () => {
  const dom = fakeDom();
  const { r, pick, chip, slot, noteText, flag } = dom.row(0);
  const { setAvailability, includeAnyway, leftOutCounts } = clientHalf(dom.doc);
  setAvailability(r, 'not-running', 'exited', '');
  assert.equal(r.dataset.avail, 'not-running', 'a Docker lifecycle change needs no second miss');
  assert.equal(pick.checked, false);
  assert.equal(pick.disabled, true);
  assert.match(chip.innerHTML, /class="badge bad">[\s\S]*Stopped<\/span>/);
  assert.equal(noteText.textContent, 'Stopped in Docker. Start it in Docker; this page updates on its own.');
  assert.equal(slot.innerHTML, '', 'no override control on a not-running row');
  assert.equal(r.parentNode, dom.groups.stopped);
  assert.equal(dom.sections.stopped.hidden, false);
  assert.deepEqual(leftOutCounts(), { unreachable: 0, stopped: 1 });
  includeAnyway(r);
  assert.equal(pick.checked, false);
  assert.equal(flag.value, '');
  assert.equal(r.dataset.forced, undefined);
  setAvailability(r, 'not-running', 'paused', '');
  assert.match(chip.innerHTML, /Paused<\/span>/);
  assert.equal(noteText.textContent, 'Paused in Docker. Start it in Docker; this page updates on its own.');
  setAvailability(r, 'not-running', 'restarting', '');
  assert.match(chip.innerHTML, /Restarting<\/span>/);
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(r.dataset.avail, 'unreachable');
  assert.equal(r.parentNode, dom.groups.unreachable);
  assert.match(slot.innerHTML, /data-include-anyway/);
  setAvailability(r, 'reachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(pick.checked, true);
  assert.equal(pick.disabled, false);
  assert.equal(r.parentNode, dom.groups.reachable);
  assert.equal(dom.sections.stopped.hidden, true);
});

test('focused rows defer updates until blur', () => {
  const dom = fakeDom();
  const { r, input } = dom.row(0);
  const other = dom.row(1);
  const { setAvailability } = clientHalf(dom.doc);
  dom.doc.activeElement = input;
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(r.dataset.avail, 'unreachable');
  assert.equal(r.parentNode, dom.groups.reachable, 'but the focused row stays where it is');
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(r.parentNode, dom.groups.reachable);
  setAvailability(other.r, 'reachable', 'running', 'http://192.168.1.20:7878');
  assert.deepEqual(dom.groups.reachable.children, [r, other.r]);
  dom.doc.activeElement = null;
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(r.parentNode, dom.groups.unreachable);
});

test('updates Include anyway across availability changes', () => {
  const dom = fakeDom();
  const { r, pick, flag } = dom.row(0);
  const { setAvailability, includeAnyway, leftOutCounts } = clientHalf(dom.doc);
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(pick.disabled, true);
  assert.deepEqual(leftOutCounts(), { unreachable: 1, stopped: 0 });
  includeAnyway(r);
  assert.equal(pick.checked, true, 'the owner override ticks the row');
  assert.equal(pick.disabled, false);
  assert.equal(flag.value, 'on');
  assert.equal(r.dataset.forced, '1');
  assert.deepEqual(leftOutCounts(), { unreachable: 0, stopped: 0 }, 'a forced row is no longer reported as left out');
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(pick.checked, true, 'a later failed poll does not untick a forced row');
  setAvailability(r, 'not-running', 'exited', '');
  assert.equal(pick.checked, false);
  assert.equal(pick.disabled, true);
  assert.equal(r.dataset.forced, '1', 'the override outlives the stop');
  setAvailability(r, 'reachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(pick.checked, true, 'back online, restored to what the owner chose');
  assert.equal(pick.disabled, false);
});

test('preserves Include anyway during service flapping', () => {
  const dom = fakeDom();
  const { r, pick, flag } = dom.row(0);
  const { setAvailability, includeAnyway, leftOutCounts } = clientHalf(dom.doc);
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  includeAnyway(r);
  assert.equal(pick.checked, true);

  setAvailability(r, 'reachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(pick.checked, true);

  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:8989');
  assert.equal(pick.checked, true);
  assert.equal(pick.disabled, false);
  assert.equal(flag.value, 'on');
  assert.deepEqual(leftOutCounts(), { unreachable: 0, stopped: 0 }, 'and it is not reported as left out');
});

test('excluded services stay unselected', () => {
  const dom = fakeDom();
  const { r, pick } = dom.row(0, 'reachable');
  const { setAvailability } = clientHalf(dom.doc);
  assert.equal(pick.checked, true, 'the server pre-ticked this reachable row');

  pick.checked = false;
  r.dataset.intent = '0';

  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:7878');
  setAvailability(r, 'unreachable', 'running', 'http://192.168.1.20:7878');
  setAvailability(r, 'reachable', 'running', 'http://192.168.1.20:7878');
  assert.equal(pick.checked, false);
});

test('preserves the default selection for untouched rows', () => {
  const dom = fakeDom();
  const ticked = dom.row(0, 'reachable');
  const { setAvailability } = clientHalf(dom.doc);
  assert.equal(ticked.pick.checked, true);
  setAvailability(ticked.r, 'unreachable', 'running', 'http://192.168.1.20:7878');
  setAvailability(ticked.r, 'unreachable', 'running', 'http://192.168.1.20:7878');
  setAvailability(ticked.r, 'reachable', 'running', 'http://192.168.1.20:7878');
  assert.equal(ticked.pick.checked, true, 'a pre-ticked row comes back ticked');
});

test('unverified rows remain user-selectable', () => {
  const dom = fakeDom();
  const { r, pick, chip } = dom.row(0, 'unverified');
  pick.checked = false;
  const { setAvailability } = clientHalf(dom.doc);
  assert.equal(pick.disabled, false);
  setAvailability(r, 'reachable', 'running', 'http://192.168.1.20:7878');
  assert.equal(r.dataset.avail, 'reachable');
  assert.equal(pick.checked, false);
  assert.equal(r.parentNode, dom.groups.reachable);
  pick.checked = true;
  setAvailability(r, 'unverified', '', '');
  assert.equal(r.parentNode, dom.groups.unverified);
  assert.equal(pick.disabled, false, 'unverified stays selectable');
  assert.equal(pick.checked, true, 'an owner tick survives a loss of evidence');
  assert.equal(chip.innerHTML, '<span class="badge line">Not checked</span>');
  assert.match(offlineModule.includeAnywayMarkup(), new RegExp(INCLUDE_ANYWAY_COPY.replace(/[.;]/g, '\\$&')));
});
