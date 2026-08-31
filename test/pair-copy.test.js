import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-companion-paircopy-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = '192.168.1.20';
process.env.DATA_DIR = dataDir;

const { pairPage, pairTransferSummary, selectedPairReadiness } = await import('../src/ui/pages/pair.js');
const { pairReadyPage, pairExpiryText } = await import('../src/ui/pages/pair-ready.js');
const { ladderMarkup } = await import('../src/ui/pages/pair-ladder.js');
const { LIVE_CHECK_SCRIPT } = await import('../src/ui/pages/pair-live.js');
const { ladderFor } = await import('../src/keyladder.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

const DETECTED = [
  { instanceId: 'radarr-up', kind: 'radarr', name: 'Radarr', port: 7878, url: 'http://192.168.1.20:7878', dockerState: 'running', up: true, apiKey: 'k'.repeat(32) },
  { instanceId: 'sonarr-unreachable', kind: 'sonarr', name: 'Sonarr', port: 8989, url: 'http://192.168.1.20:8989', dockerState: 'running', up: false },
  { instanceId: 'lidarr-stopped', kind: 'lidarr', name: 'Lidarr', port: 8686, dockerState: 'exited' },
  { instanceId: 'prowlarr-unverified', kind: 'prowlarr', name: 'Prowlarr', port: 9696 },
];

function draftFor(rows) {
  return {
    services: rows.map((d) => ({ instanceId: d.instanceId, included: true, baseUrl: `http://192.168.1.20:${d.port}`, remoteBaseUrl: '' })),
    edgeAccess: {},
  };
}

function configure(rows, extra = {}) {
  return pairPage({ stage: 'configure', detected: rows, draft: draftFor(rows), issues: [], csrf: 'csrf-token', mintEnabledKinds: [], ...extra });
}

test('does not mark an empty selection ready', () => {
  assert.deepEqual(selectedPairReadiness([]), {
    ready: false,
    line: 'Nothing selected: tick at least one service to hand over',
  });
  assert.deepEqual(selectedPairReadiness(undefined), {
    ready: false,
    line: 'Nothing selected: tick at least one service to hand over',
  });

  const blocked = DETECTED.filter((d) => d.instanceId !== 'radarr-up' && d.instanceId !== 'prowlarr-unverified');
  const html = configure(blocked);
  assert.match(html, /id="pair-ready-line">Nothing selected: tick at least one service to hand over/);
  assert.match(html, /class="pair-readiness" id="pair-readiness"/);
  assert.match(html, /id="pair-ready-line">[^<]*1 unreachable, not included · 1 not running</);
});

test('counts only transferable services as ready', () => {
  const summary = pairTransferSummary(DETECTED);
  assert.match(summary, /^1 of 4 detected services is ready for this scan\./, 'a stopped and an unreachable row are not ready');
  assert.doesNotMatch(summary, /^3 services are ready|^2 of 4/);
  assert.match(summary, /1 still needs a service credential: open the row and create or paste the key there\./);
  assert.match(summary, /Companion could not check 1 of them, so tick it only if you know it is running\./);
  assert.match(summary, /1 is not running and cannot be handed over: start it in Docker and this page updates on its own\./);
  assert.match(summary, /1 is running but unreachable from Companion and left out: use Include anyway on its row if your phone can reach it\./);

  assert.equal(pairTransferSummary([]), 'No services detected yet.');
  assert.equal(
    pairTransferSummary([DETECTED[2]]),
    'The one detected service is not ready for this scan. 1 is not running and cannot be handed over: start it in Docker and this page updates on its own.',
  );
  assert.equal(pairTransferSummary([DETECTED[0]]), 'The one detected service is ready for this scan.');
  assert.match(configure(DETECTED), /<b>Transfer readiness<\/b><span>1 of 4 detected services is ready for this scan\./);
});

test('renders paste controls for file credentials', () => {
  const withoutControl = ladderMarkup('radarr', ladderFor('radarr'), false, false);
  assert.match(withoutControl, /data-manual-key type="password" maxlength="16384"/, 'the paste field is not withheld');
  assert.match(withoutControl, /data-save-key>Save key</);
  assert.match(withoutControl, /<a class="btn pair-open" data-open target="_blank" rel="noopener">Open settings page<\/a>/);
  assert.match(withoutControl, /enable Management \+ shell under Docker access/);
  assert.doesNotMatch(withoutControl, /data-read>/);
  assert.doesNotMatch(withoutControl, /- \/path:\/stack\/radarr:ro/, 'the dead-end placeholder mount line is gone');
  assert.match(withoutControl, /Mount Radarr's <code>config\.xml<\/code> read only at <code>\/stack\/radarr<\/code>/);
  assert.match(withoutControl, /host path or named volume that Radarr mounts at <code>\/config<\/code>/);
  assert.match(withoutControl, /same <code>docker compose -f<\/code> list you already use, in the same order/);

  const withControl = ladderMarkup('jackett', ladderFor('jackett'), true, false);
  assert.match(withControl, /data-manual-key type="password"/);
  assert.match(withControl, /data-read>Read key from container</);
  assert.doesNotMatch(withControl, /enable Management \+ shell/);
  assert.match(withControl, /ServerConfig\.json/);
  assert.match(withControl, /mounts at <code>\/config\/Jackett<\/code>/);

  assert.ok(withControl.indexOf('data-read>') < withControl.indexOf('<div class="key-made"'), 'the read control is inside the hideable ladder');
});

test('renders bundle expiry and disabled behavior', () => {
  const bundle = {
    setupCode: 'ABCD-1234',
    companion: { expiresAt: '2026-08-23T13:24:07.000Z' },
    summary: [
      { instanceId: 'radarr-up', kind: 'radarr', label: 'Radarr', baseUrl: 'http://192.168.1.20:7878', hasKey: true },
      { instanceId: 'sonarr-up', kind: 'sonarr', label: 'Sonarr', baseUrl: 'http://192.168.1.20:8989', hasKey: false },
    ],
  };
  assert.equal(pairExpiryText('2026-08-23T13:24:07.000Z'), 'Expires at 13:24:07 UTC');
  assert.equal(pairExpiryText('not a date'), 'Expires shortly. Create another transfer if the code is refused.');

  const html = pairReadyPage({ bundle, qrDataUrl: 'data:image/png;base64,AAAA', filePath: '/pair/file/abc', csrf: 'csrf-token' });
  assert.doesNotMatch(html, /Expires in three minutes/);
  assert.match(html, /id="pair-expiry">Expires at 13:24:07 UTC</);
  assert.match(html, /id="pair-again" href="\/pair" hidden style="display:none"/);
  assert.match(html, /qr\.style\.filter = 'grayscale\(1\) blur\(5px\)'/, 'the expired code stops being scannable');
  assert.match(html, /copy\.disabled = true; copy\.textContent = 'Expired'/);
  assert.match(html, /file\.removeAttribute\('href'\)/);
  assert.match(html, /if \(!seconds\) \{ expire\(\); return; \}/);
});

test('renders poll stalls, authorization failures, and last success', () => {
  const configureHtml = configure(DETECTED);
  const readyHtml = pairReadyPage({
    bundle: {
      setupCode: 'A', companion: { expiresAt: new Date(Date.now() + 60000).toISOString() },
      summary: [{ instanceId: 'sonarr-up', kind: 'sonarr', label: 'Sonarr', baseUrl: 'http://192.168.1.20:8989', hasKey: false }],
    },
    qrDataUrl: 'data:image/png;base64,AAAA', filePath: '/pair/file/abc', csrf: 'csrf-token',
  });
  for (const [name, html] of [['configure', configureHtml], ['ready', readyHtml]]) {
    assert.match(html, /data-live-banner/, `${name} renders the live strip`);
    assert.match(html, /data-live-stamp>[^<]*Checked when this page loaded\./, `${name} stamps the load`);
    assert.match(html, /live\.fail\(r\.status\)/, `${name} passes the status through instead of swallowing it`);
    assert.match(html, /\.catch\(function \(\) \{ live\.fail\(0\); \}\)/, `${name} counts a network failure`);
    assert.match(html, /live\.onRetry\(poll\)/, `${name} wires a real control`);
    assert.match(html, /Your Companion session expired/, `${name} names an expired session`);
    assert.match(html, /did not answer the last two checks/, `${name} names an outage differently`);
  }
  assert.doesNotMatch(configureHtml, /\}\)\.catch\(function \(\) \{\}\);/, 'no empty catch is left on the services poll');
  assert.doesNotMatch(readyHtml, /\}\)\.catch\(function \(\) \{\}\);/, 'no empty catch is left on the key watch');
});

test('reports live poll failure after the retry threshold', () => {
  const parts = {};
  for (const name of ['banner', 'msg', 'stamp', 'signin', 'retry']) {
    parts[name] = { hidden: true, style: {}, textContent: '', handler: null, addEventListener(type, fn) { this.handler = fn; } };
  }
  const root = { querySelector: (selector) => parts[/\[data-live-([a-z]+)\]/.exec(selector)[1]] || null };
  const documentStub = { getElementById: () => root };
  const build = new Function('document', `${LIVE_CHECK_SCRIPT}\nreturn qmLiveCheck;`)(documentStub);
  const live = build('pair-live', { expired: 'session gone', unreachable: 'companion gone' });

  live.fail(0);
  assert.equal(parts.banner.hidden, true);
  live.fail(0);
  assert.equal(parts.banner.hidden, false);
  assert.equal(parts.msg.textContent, 'companion gone');
  assert.equal(parts.signin.hidden, true, 'an outage is not cured by signing in');
  assert.equal(parts.retry.hidden, false);
  assert.equal(parts.retry.style.display, '');

  live.ok();
  assert.equal(parts.banner.hidden, true);
  assert.match(parts.stamp.textContent, /^Last successful check at \d\d:\d\d:\d\d\.$/);

  live.fail(401);
  assert.equal(parts.banner.hidden, true, 'the counter reset on success');
  live.fail(401);
  assert.equal(parts.msg.textContent, 'session gone');
  assert.equal(parts.signin.hidden, false);
  assert.equal(parts.signin.style.display, '');
  assert.equal(parts.retry.hidden, false);

  let retried = 0;
  live.onRetry(() => { retried += 1; });
  parts.retry.handler();
  assert.equal(retried, 1);
});
