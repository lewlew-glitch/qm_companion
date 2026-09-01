import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-companion-ui-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = '192.168.1.20';
process.env.DATA_DIR = dataDir;
process.env.DOCKER_ACCESS_MAX = 'read';

const { cataloguePage, composeStarter, containersPage, consolePage, cronPage, dashboardPage, pairPage, settingsPage, stacksPage } = await import('../src/ui/views.js');
const { deployableKinds } = await import('../src/starters.js');
const { publicUrlFromLabels } = await import('../src/ui/pages/containers.js');
const { selectedPairReadiness, syncPairRouteSummary } = await import('../src/ui/pages/pair.js');
const { appRuntime, gridKeyStartsInControl } = await import('../src/ui/runtime.js');
const { MARKETPLACE_ENTRIES } = await import('../src/marketplace.js');
const { styles } = await import('../src/ui/styles.js');
const { FOCUS_FN, I, badge } = await import('../src/ui/bits.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

function compileInlineScripts(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  return scripts.length;
}

function marketplaceCard(html, kind) {
  const marker = `data-kind="${kind}"`;
  const at = html.indexOf(marker);
  assert.notEqual(at, -1, `Marketplace card ${kind} exists`);
  const start = html.lastIndexOf('<article class="market-card"', at);
  const end = html.indexOf('</article>', at);
  assert.ok(start >= 0 && end > at, `Marketplace card ${kind} is complete`);
  return html.slice(start, end + '</article>'.length);
}

test('contains and restores overlay focus', () => {
  let modalList = [];
  let keyListener = null;
  let documentMock;
  function target(name) {
    return {
      name, offsetWidth: 1, offsetHeight: 0, isConnected: true,
      getAttribute: () => null,
      closest: () => null,
      getClientRects: () => [1],
      focus() { documentMock.activeElement = this; },
    };
  }
  const opener = target('opener');
  const first = target('first');
  const last = target('last');
  const nested = target('nested');
  const root = {
    querySelectorAll: () => [first, last],
    contains: (item) => item === first || item === last,
    setAttribute() {},
    focus() { documentMock.activeElement = this; },
  };
  documentMock = {
    activeElement: opener,
    querySelectorAll: () => modalList,
    addEventListener(type, listener, capture) { if (type === 'keydown' && capture) keyListener = listener; },
    removeEventListener(type, listener, capture) { if (type === 'keydown' && capture && keyListener === listener) keyListener = null; },
  };
  const trap = new Function('document', 'root', `${FOCUS_FN}; return qmFocusTrap(root);`)(documentMock, root);
  trap.open(opener, first);
  assert.equal(documentMock.activeElement, first);
  assert.equal(typeof keyListener, 'function');

  documentMock.activeElement = last;
  let prevented = false;
  keyListener({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(documentMock.activeElement, first);

  documentMock.activeElement = first;
  prevented = false;
  keyListener({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(documentMock.activeElement, last);

  modalList = [nested];
  documentMock.activeElement = last;
  prevented = false;
  keyListener({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'a nested modal owns its own keyboard focus');
  assert.equal(documentMock.activeElement, last);

  modalList = [];
  trap.close();
  assert.equal(keyListener, null);
  assert.equal(documentMock.activeElement, opener);

  const chrome = dashboardPage([], { now: [], arr: [] }, { counts: {}, info: {}, events: [], containers: [] }, 'csrf-token');
  const market = cataloguePage([], false, 'csrf-token');
  const stacks = stacksPage([], false, 'csrf-token', []);
  assert.match(chrome, /navTrap\.open\(opener,/);
  assert.match(chrome, /navTrap\.close\(restore\)/);
  assert.match(chrome, /jumpTrap\.open\(opener, q\)/);
  assert.match(chrome, /jumpTrap\.close\(\)/);
  assert.match(market, /marketTrap\.open\(opener,/);
  assert.match(market, /marketTrap\.close\(\)/);
  assert.match(stacks, /sedTrap\.open\(opener,/);
  assert.match(stacks, /sedTrap\.close\(\)/);
});

test('renders an accessible Docker access chooser', () => {
  const html = dashboardPage([], { now: [], arr: [] }, { counts: {}, info: {}, events: [], containers: [] }, 'csrf-token');

  assert.match(html, /id="docker-mode-open"[^>]*aria-haspopup="dialog"[^>]*aria-controls="docker-mode-dialog"[^>]*aria-expanded="false"/);
  assert.match(html, /aria-label="Docker access: Read only"/);
  assert.match(html, /id="docker-mode-form"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="docker-mode-title"[^>]*aria-describedby="docker-mode-intro"/);
  assert.match(html, /<legend class="sr-only">Docker access mode<\/legend>/);
  assert.match(html, /name="docker-mode" value="read" checked/);
  assert.match(html, /name="docker-mode" value="manage"[^>]*disabled/);
  assert.match(html, /name="docker-mode" value="shell"[^>]*disabled/);
  assert.match(html, /docker-compose\.management\.yml/, 'the manage refusal names its overlay file');
  assert.match(html, /DOCKER_ACCESS_MAX: manage/, 'and the value it sets');
  assert.match(html, /POST: 1/, 'and the socket-proxy switch behind it');
  assert.match(html, /docker compose -f docker-compose\.example\.yml -f docker-compose\.management\.yml up -d/, 'and the command');
  assert.match(html, /docker-compose\.shell\.yml/, 'the shell refusal names its own overlay');
  assert.match(html, /EXEC: 1/, 'and the extra switch shell needs');
  assert.doesNotMatch(html, /Requires the management install profile and a container restart/, 'the dead end is gone');
  assert.match(html, /id="docker-mode-status" role="status" aria-live="polite"/);
  assert.match(html, /modeTrap\.open\(trigger,/);
  assert.match(html, /modeTrap\.close\(\)/);
  assert.match(html, /Docker has no daemon-level read-only boundary here/);
  assert.match(html, /configured user and privileges/);
  assert.doesNotMatch(html, /Commands run as root|runs as root inside/i);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('renders dashboard status without credentials', () => {
  const detected = [
    { kind: 'radarr', port: 7878, up: true, apiKey: 'dashboard-sentinel-secret', credentialState: 'included' },
    { kind: 'jellyfin', port: 8096, up: true, credentialState: 'missing-key' },
    { kind: 'dozzle', port: 8080, up: false, credentialState: 'not-required' },
  ];
  const docker = {
    counts: { total: 12, running: 9, stopped: 3, paused: 0, unhealthy: 0, healthy: 2 },
    info: { images: 10, volumes: 4, networks: 3 },
    events: [],
    containers: [
      { name: 'radarr', stack: 'media-stack', state: 'running', health: 'healthy' },
      { name: 'sonarr', stack: 'media-stack', state: 'running', health: 'unhealthy' },
    ],
  };
  const html = dashboardPage(detected, { now: [], arr: [] }, docker, 'csrf-token');

  assert.match(html, /class="panel dash-environment"/);
  assert.match(html, /id="ribbon"/);
  assert.match(html, /data-count="running"/);
  assert.match(html, /data-count="total"/);
  assert.match(html, /href="\/containers\?state=running"/);
  assert.equal((html.match(/class="panel dash-metric"/g) || []).length, 5);
  assert.match(html, /Container CPU/);
  assert.match(html, /Container memory/);
  assert.match(html, /Temperatures/);
  assert.match(html, /100% is one core busy/);
  assert.match(html, /Phone setup/);
  assert.match(html, /included in scan/);
  assert.match(html, /CPU and memory history/);
  assert.match(html, /data-grid="services"/);
  assert.match(html, /media-stack/);
  assert.match(html, /2 containers/);
  assert.match(html, /1 unhealthy/);
  assert.match(html, /topics: \['counts','events','updates'\]/);
  assert.match(html, /Storage footprint/);
  assert.match(html, /id="mobile-menu"[^>]*aria-controls="side-menu"/);
  assert.match(html, /id="side-scrim"/);
  assert.match(html, /side\.classList\.toggle\('menu-open'/);
  assert.doesNotMatch(html, />Host load<|>Disk use<|disk \d+%/);
  assert.doesNotMatch(html, /Your stack|Keys ready|Add key|dashboard-sentinel-secret/iu);
  assert.doesNotMatch(html, /qme-health|qm-environment/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('reports starting health checks', () => {
  const html = dashboardPage([], { now: [], arr: [] }, {
    counts: { total: 1, running: 1, stopped: 0, paused: 0, unhealthy: 0, healthy: 0, starting: 1 },
    info: { images: 1, volumes: 0, networks: 1 },
    events: [],
  }, 'csrf-token');
  assert.match(html, /id="rib-health"><span class="state warn"><i><\/i>1 health check starting<\/span>/);
  assert.doesNotMatch(html, /id="rib-health"><span class="state off"/);
});

test('renders specific credential guidance for pairing', () => {
  const detected = [
    { instanceId: 'radarr-one', kind: 'radarr', name: 'Radarr', port: 7878, apiKey: 'included-secret' },
    { instanceId: 'ha-one', kind: 'homeassistant', name: 'Home Assistant', port: 8123 },
    { instanceId: 'portainer-one', kind: 'portainer', name: 'Portainer', port: 9443 },
    { instanceId: 'dockhand-one', kind: 'dockhand', name: 'Dockhand', port: 3000 },
  ];
  const draft = {
    services: detected.map((service) => ({
      instanceId: service.instanceId,
      included: true,
      baseUrl: `https://nas.example.test:${service.port}`,
      remoteBaseUrl: '',
    })),
    edgeAccess: {},
  };
  const html = pairPage({ stage: 'configure', detected, draft, issues: [], csrf: 'csrf-token', mintEnabledKinds: [] });

  assert.match(html, /Transfer readiness/);
  assert.match(html, /Needs service key/);
  assert.match(html, /Long-Lived Access Token/);
  assert.match(html, /Open token settings/);
  assert.match(html, /Create an API key in Portainer, then paste it here/);
  assert.match(html, /Create or copy the API key in Dockhand/);
  assert.equal((html.match(/data-manual-key type=/g) || []).length, 3);
  assert.equal((html.match(/data-save-key>/g) || []).length, 3);
  assert.match(html, /data-manual-key type="password" maxlength="16384"/);
  assert.match(html, /fetch\('\/pair\/keys\/manual'/);
  assert.match(html, /setChip\(row, 'included'\)/);
  assert.match(html, /setInterval\(function \(\) \{ if \(!document.hidden\) poll\(\); \}, 5000\)/);
  assert.match(html, /data-pair-body hidden/);
  assert.match(html, /id="pair-expand"[^>]*>Review all routes/);
  assert.match(html, /data-route-summary/);
  assert.match(html, /addEventListener\('input', function \(\) \{ syncPairRouteSummary\(row\); \}\)/);
  assert.doesNotMatch(html, /Address presets|pair-preset|preset-host/, 'the confusing address-presets card is gone');
  assert.doesNotMatch(html, /Finish on phone|add it on the phone|finished right here or on the phone|requests it after the scan/iu);
  assert.doesNotMatch(html, /included-secret/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('shows create and paste options only for enabled mint kinds', () => {
  const detected = [
    { instanceId: 'portainer-one', kind: 'portainer', name: 'Portainer', port: 9443 },
    { instanceId: 'technitium-one', kind: 'technitium', name: 'Technitium', port: 5380 },
  ];
  const draft = { services: detected.map((s) => ({ instanceId: s.instanceId, included: true, baseUrl: '', remoteBaseUrl: '' })), edgeAccess: {} };
  const html = pairPage({ stage: 'configure', detected, draft, issues: [], csrf: 'csrf-token', mintEnabledKinds: ['portainer'] });
  const rowOf = (id) => html.slice(html.indexOf(`data-instance="${id}"`), html.indexOf('</section>', html.indexOf(`data-instance="${id}"`)));
  const portainer = rowOf('portainer-one');
  assert.match(portainer, /data-mint-btn>Create key for me/, 'the enabled kind shows a create button');
  assert.match(portainer, /data-manual-key/, 'and the paste-your-own field alongside it');
  assert.match(portainer, /Review how the sign-in and key are handled/);
  assert.doesNotMatch(portainer, /Create an API key in Portainer, then paste it here/, 'the enabled kind shows the creation flow');
  const technitium = rowOf('technitium-one');
  assert.doesNotMatch(technitium, /data-mint-btn/, 'a paused kind offers no create button');
  assert.match(technitium, /Create an API key in Technitium, then paste it here/);
});

test('describes key handling before password entry', () => {
  const runtime = appRuntime();
  assert.match(runtime, /Protections already in place/);
  assert.match(runtime, /Owner protected/);
  assert.match(runtime, /A page security token and an attempt limit protect this action/);
  assert.match(runtime, /Destination locked/);
  assert.match(runtime, /public HTTP is refused and the request connects to the resolved address/);
  assert.match(runtime, /Redirects are refused, every step has a deadline and response size is capped/);
  assert.match(runtime, /The created key is encrypted at rest and bound to this service/);
  assert.match(runtime, /Remaining connection risk/);
  assert.match(runtime, /This Companion page uses HTTP, so the details are not encrypted between this browser and Companion/);
  assert.match(runtime, /also uses HTTP, so the details are not encrypted between Companion/);
  assert.match(runtime, /The token has the same permissions as the/);
  assert.match(runtime, /The new key can access the whole/);
  assert.match(runtime, /A private self-signed HTTPS certificate is currently accepted without a saved fingerprint check/);
  assert.match(runtime, /I understand that my sign-in details will cross an unencrypted HTTP connection/);
  assert.match(runtime, /function mclear\(\) \{\s*muser\.value = '';\s*mpass\.value = '';\s*mconsent\.checked = false;/);
  assert.match(runtime, /\.catch\(function \(\) \{[\s\S]*?mpass\.value = '';/, 'a failed request clears the password field');
  assert.doesNotMatch(runtime, /Sent only to the selected service for this request and not retained|How your sign-in is handled/);
});

test('renders next steps for deferred pairing credentials', () => {
  assert.deepEqual(selectedPairReadiness(['included', 'not-required']), {
    ready: true,
    line: 'Everything selected is ready',
  });
  assert.deepEqual(selectedPairReadiness(['missing-key']), {
    ready: false,
    line: 'Watching for 1 service key',
  });
  assert.deepEqual(selectedPairReadiness(['sign-in', 'key-and-secret']), {
    ready: false,
    line: '2 selected services need setup after pairing',
  });
  assert.deepEqual(selectedPairReadiness(['missing-key', 'sign-in']), {
    ready: false,
    line: '2 selected services need credentials',
  });

  const detected = [
    { instanceId: 'plex-one', kind: 'plex', name: 'Plex', port: 32400 },
    { instanceId: 'komodo-one', kind: 'komodo', name: 'Komodo', port: 9120 },
  ];
  const html = pairPage({
    stage: 'configure',
    detected,
    draft: {
      services: detected.map((service) => ({
        instanceId: service.instanceId,
        included: true,
        baseUrl: `http://nas.example.test:${service.port}`,
        remoteBaseUrl: '',
      })),
      edgeAccess: {},
    },
    issues: [],
    csrf: 'csrf-token',
    mintEnabledKinds: [],
  });

  assert.match(html, /class="pair-readiness" id="pair-readiness"/);
  assert.match(html, /id="pair-ready-line">2 selected services need setup after pairing/);
  assert.match(html, /data-kind="plex" data-cred-state="sign-in"[\s\S]*?data-next-step[\s\S]*?complete its sign-in/);
  assert.match(html, /data-kind="komodo" data-cred-state="key-and-secret"[\s\S]*?create an API key plus API secret[\s\S]*?add both in Quartermaster/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('route summaries project the current fields on a direct field edit', () => {
  const localLine = { textContent: '' };
  const awayLine = { textContent: '' };
  const base = { value: ' http://nas.local:7878 ' };
  const remote = { value: ' https://radarr.example.test/media ' };
  const summary = {
    querySelector(selector) {
      if (selector === 'span') return localLine;
      if (selector === 'small') return awayLine;
      return null;
    },
  };
  const row = {
    querySelector(selector) {
      if (selector === '[data-route-summary]') return summary;
      if (selector === '.pair-base') return base;
      if (selector === '.pair-remote') return remote;
      return null;
    },
  };

  syncPairRouteSummary(row);
  assert.equal(localLine.textContent, 'http://nas.local:7878');
  assert.equal(awayLine.textContent, 'Away: https://radarr.example.test/media');
  remote.value = '';
  syncPairRouteSummary(row);
  assert.equal(awayLine.textContent, 'Home route only');
});

test('shared grid keyboard handling leaves nested controls alone', () => {
  const row = { contains: (node) => node === control };
  const control = {};
  const nestedControl = { closest: () => control };
  const plainCell = { closest: () => row };

  assert.equal(gridKeyStartsInControl(nestedControl, row), true);
  assert.equal(gridKeyStartsInControl(plainCell, row), false);

  const runtime = appRuntime();
  assert.match(runtime, /if \(gridKeyStartsInControl\(e\.target, r\)\) return;/);
  assert.match(runtime, /e\.key === 'Enter' \|\| e\.key === ' '/);
  assert.ok(compileInlineScripts(runtime) >= 1);
});

test('Marketplace read-only actions remain local', () => {
  const html = cataloguePage([
    { kind: 'radarr', apiKey: 'market-sentinel-secret', url: 'https://private.example.test' },
  ], false, 'csrf-token');
  const radarr = marketplaceCard(html, 'radarr');
  const prowlarr = marketplaceCard(html, 'prowlarr');

  assert.equal((html.match(/<article class="market-card"/g) || []).length, MARKETPLACE_ENTRIES.length);
  assert.equal((html.match(/class="market-project"/g) || []).length, MARKETPLACE_ENTRIES.length);
  assert.match(html, /id="market-grid" class="market-grid"|class="market-grid" id="market-grid"/);
  assert.doesNotMatch(html, /market-group-head|Connection support|Connection guide/);
  for (const entry of MARKETPLACE_ENTRIES) {
    const card = marketplaceCard(html, entry.kind);
    assert.match(card, new RegExp(`href="${entry.upstreamUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`), entry.kind);
    assert.match(card, /<button class="market-card-open market-open[^>]*>[\s\S]*?<\/button><a class="market-project"/, `${entry.kind} keeps Project outside its details button`);
  }
  assert.match(html, new RegExp(`${MARKETPLACE_ENTRIES.length} shown`));
  assert.match(radarr, /Ready for scan/);
  assert.match(radarr, /Review setup/);
  assert.doesNotMatch(radarr, /Deploy|Reviewed/u);
  assert.match(prowlarr, /Preview only/);
  assert.match(prowlarr, /Review starter/);
  assert.match(html, /id="market-copy"/);
  assert.match(html, /id="market-download"/);
  assert.match(html, /id="market-upstream"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /https:\/\/github\.com\/moghtech\/komodo/);
  assert.match(html, /upstream\.hidden=!entry\.upstreamUrl/);
  assert.match(html, /Read-only Docker mode/);
  assert.match(html, new RegExp(deployableKinds().length + ' starters'));
  assert.doesNotMatch(html, /\/stacks\/deploy|id="market-deploy"|market-sentinel-secret|private\.example\.test/);
  assert.match(composeStarter('radarr'), /^services:\n/);
  assert.equal(composeStarter('proxmox'), null);
  assert.match(composeStarter('prowlarr'), /^services:\n/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('distinguishes reviewed and generated starters', () => {
  const html = cataloguePage([], true, 'csrf-token');
  const reviewed = marketplaceCard(html, 'prowlarr');
  const generated = marketplaceCard(html, 'radarr');

  assert.match(reviewed, /Reviewed starter/);
  assert.match(reviewed, /Review and deploy/);
  assert.match(generated, /Generated starting point/);
  assert.match(generated, /Review Compose/);
  assert.doesNotMatch(generated, /Reviewed|>Deploy</u);
  assert.match(html, /id="market-deploy"/);
  assert.match(html, /\/stacks\/deploy/);
  assert.match(html, /socket proxy can still refuse/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('disables Marketplace deployment when Docker is unavailable', () => {
  const html = cataloguePage(null, true, 'csrf-token');
  const reviewed = marketplaceCard(html, 'prowlarr');
  const generated = marketplaceCard(html, 'radarr');

  assert.match(html, /Docker is unavailable/);
  assert.match(reviewed, /Detection unavailable/);
  assert.match(reviewed, /Review Compose/);
  assert.match(generated, /Detection unavailable/);
  assert.doesNotMatch(reviewed + generated, /Review and deploy|>Deploy</u);
  assert.doesNotMatch(html, /id="market-deploy"|\/stacks\/deploy/);
  assert.match(html, /"detectionKnown":false/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('renders detected service pairing without duplicate deployment', () => {
  const html = cataloguePage([
    { kind: 'prowlarr', credentialState: 'included', apiKey: 'presentation-secret' },
    { kind: 'radarr', credentialState: 'missing-key' },
  ], true, 'csrf-token');
  const ready = marketplaceCard(html, 'prowlarr');
  const missing = marketplaceCard(html, 'radarr');

  assert.match(ready, /Ready for scan/);
  assert.match(ready, /Review setup/);
  assert.doesNotMatch(ready, /Review and deploy|>Deploy</u);
  assert.match(missing, /Needs a key/);
  assert.match(missing, /Resolve in setup/);
  assert.doesNotMatch(missing, /Review and deploy|>Deploy</u);
  assert.match(html, /This service and its detected API key can be included in the next encrypted transfer/);
  assert.match(html, /Companion has not found a transferable API key yet/);
  assert.doesNotMatch(html, /presentation-secret/);
  assert.ok(compileInlineScripts(html) >= 3);
});

const SOURCE_FIXTURES = [{
  id: 'aabbccdd00112233',
  name: 'Community apps',
  url: 'https://templates.example.com/v2.json',
  addedAt: 1755000000000,
  fetchedAt: 1755003600000,
  fetchError: null,
  entries: [
    { type: 1, title: 'Uptime Kuma', name: 'uptime-kuma', description: 'Self-hosted status monitoring.', categories: ['Monitoring'], image: 'louislam/uptime-kuma:1', ports: ['3001:3001'], volumes: [{ container: '/app/data', bind: '', readonly: false }], env: [], restartPolicy: 'unless-stopped' },
    { type: 3, title: 'Immich stack', name: 'immich', description: 'Photo library stack.', categories: ['Photos'], repository: { url: 'https://github.com/example/templates', stackfile: 'stacks/immich/docker-compose.yml' }, yaml: 'services:\n  immich:\n    image: ghcr.io/immich-app/immich-server:v1.99.0\n' },
  ],
}];

test('renders semantic Marketplace tabs and unreviewed entries', () => {
  const html = cataloguePage([], true, 'csrf-token', SOURCE_FIXTURES, 'catalogue');
  const source = marketplaceCard(html, 'src-0-0');
  const stackSource = marketplaceCard(html, 'src-0-1');
  const reviewed = marketplaceCard(html, 'prowlarr');
  const generated = marketplaceCard(html, 'radarr');
  assert.match(html, /id="mseg" role="tablist"/);
  assert.match(html, new RegExp(`id="market-count"[^>]*>${MARKETPLACE_ENTRIES.length + 2} shown<\\/span>`));
  assert.match(html, new RegExp(`id="market-secondary-count"[^>]*>${deployableKinds().length} starters<\\/span>`));
  assert.match(html, /role="tab" aria-controls="market-tab-cat" aria-selected="true"/);
  assert.match(html, /role="tabpanel" aria-labelledby="market-tab-button-cat"/);
  assert.match(html, /data-t="catalogue" class="on"/);
  assert.match(html, /id="market-tab-src" role="tabpanel"[^>]* hidden/);
  assert.equal((html.match(/<article class="market-card"/g) || []).length, MARKETPLACE_ENTRIES.length + 2);
  assert.match(source, /Uptime Kuma/);
  assert.match(source, /Community, unreviewed/);
  assert.match(source, /class="logo generic template"/);
  assert.doesNotMatch(source, />UP<\/div>/);
  assert.match(source, /Review template/);
  assert.match(source, /href="https:\/\/templates\.example\.com\/v2\.json"[^>]*>[^<]*<svg[\s\S]*?Source<\/a>/);
  assert.match(stackSource, /href="https:\/\/github\.com\/example\/templates"[^>]*>[\s\S]*?Project<\/a>/);
  assert.doesNotMatch(source, /Reviewed starter|Review and deploy|>Deploy</u);
  assert.match(html, /From Community apps · not reviewed by Quartermaster/);
  assert.match(reviewed, /Reviewed starter/);
  assert.match(generated, /Generated starting point/);
  assert.doesNotMatch(generated, /Reviewed/u);
  assert.match(html, /louislam\/uptime-kuma:1/);
  assert.match(html, /immich-server:v1\.99\.0/);
  assert.match(html, /https:\/\/templates\.example\.com\/v2\.json/);
  assert.match(html, /class="btn src-refresh"/);
  assert.match(html, /class="actbtn halt src-remove"/);
  assert.match(html, /\/settings\/templates\/add/);
  assert.match(html, /id="market-lint"/);
  assert.match(html, /\/api\/compose\/validate/);
  assert.match(html, /id="market-source"[^>]*aria-label="Filter Marketplace source"/);
  assert.match(html, /class="btn market-clear"/);
  assert.doesNotMatch(html, /market-group-head/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('identity marks and semantic colours stay solid', () => {
  const fallback = badge('dockhand', 'Dockhand');
  const product = badge('', 'qm-companion');
  assert.match(fallback, /class="logo generic"/);
  assert.match(fallback, /--logo-bg:#4258D6/);
  assert.match(fallback, /<svg/);
  assert.doesNotMatch(fallback, /color-mix|>DO<\/div>/);
  assert.match(product, /class="logo img product"/);
  assert.match(I.stack, /class="fill-icon"/);
  assert.match(I.stack, /<rect/);
  assert.doesNotMatch(I.stack, /m12 2 9 5/);
  assert.doesNotMatch(styles, /(?:linear|radial|conic)-gradient\(/);
  assert.match(styles, /\.badge\.ok \{ background: var\(--ok\); color: #FFF; \}/);
  assert.match(styles, /\.badge\.warn \{ background: var\(--warn-mark\); color: #1B1607; \}/);
  assert.match(styles, /\.badge\.bad, \.badge\.err \{ background: var\(--bad\); color: #FFF; \}/);
  assert.match(styles, /\.badge\.info, \.badge\.viol \{ background: var\(--accent\); color: #FFF; \}/);
});

test('empty Sources tab reports its empty state', () => {
  const html = cataloguePage([], false, 'csrf-token', [], 'sources');
  assert.match(html, /data-t="sources" class="on"/);
  assert.match(html, /id="market-tab-cat" role="tabpanel"[^>]* hidden/);
  assert.match(html, /id="market-count"[^>]*>0 sources<\/span>/);
  assert.match(html, /id="market-secondary-count"[^>]*>0 entries<\/span>/);
  assert.match(html, /setHeader\(src\)/);
  assert.match(html, /No template sources yet/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('the Sources header reports source facts instead of catalogue facts', () => {
  const html = cataloguePage([], false, 'csrf-token', SOURCE_FIXTURES, 'sources');
  assert.match(html, /id="market-count"[^>]*>1 source<\/span>/);
  assert.match(html, /id="market-secondary-count"[^>]*>2 entries<\/span>/);
  assert.doesNotMatch(html, /id="market-count"[^>]*>[^<]*shown<\/span>/);
  assert.match(html, /count\.textContent=src\?plural\(sourceCount,'source','sources'\):catalogueShown\+' shown'/);
  assert.match(html, /secondaryCount\.textContent=src\?plural\(sourceEntryCount,'entry','entries'\):/);
});

test('a failed source fetch reads as a dot and a word, not stale entries', () => {
  const html = cataloguePage([], false, 'csrf-token', [{
    ...SOURCE_FIXTURES[0], fetchError: 'the server answered 500', entries: [],
  }], 'sources');
  assert.match(html, /<span class="state bad" title="the server answered 500"><i><\/i>Fetch failed<\/span>/);
});

test('stack editor displays the findings panel below YAML', () => {
  const html = stacksPage([], true, 'csrf-token', []);
  assert.match(html, /id="sed-lint"/);
  assert.match(html, /\/api\/compose\/validate/);
  assert.match(html, /errors block deployment/);
});

const CONTAINER_FIXTURES = [
  { id: 'a'.repeat(12), name: 'running-app', image: 'example/app:latest', state: 'running', status: 'Up 1 minute', health: '', uptime: 'Up 1 minute', ports: ['80:80', '443:443', '9000:9000'], ip: '172.20.0.2', stack: 'web', kind: '', labels: { 'traefik.http.routers.app.rule': 'Host(`app.example.com`)' } },
  { id: 'b'.repeat(12), name: 'paused-app', image: 'example/app:latest', state: 'paused', status: 'Up 1 minute (Paused)', health: '', uptime: '', ports: [], ip: '', stack: '', kind: '' },
  { id: 'c'.repeat(12), name: 'created-app', image: 'example/app:latest', state: 'created', status: 'Created', health: '', uptime: '', ports: [], ip: '', stack: '', kind: '' },
  { id: 'd'.repeat(12), name: 'dead-app', image: 'example/app:latest', state: 'dead', status: 'Dead', health: '', uptime: '', ports: [], ip: '', stack: '', kind: '' },
  { id: 'e'.repeat(12), name: 'qm-companion', image: 'qm_companion-companion', state: 'running', status: 'Up 2 hours', health: '', uptime: 'Up 2 hours', ports: ['8787:8787'], ip: '172.20.0.8', stack: 'qm_companion', kind: '', protected: true },
];

test('renders container lifecycle and bulk controls', () => {
  const html = containersPage(CONTAINER_FIXTURES, true, 'csrf-token');

  assert.match(html, /2 inactive/);
  assert.match(html, /<option value="inactive">Inactive<\/option>/);
  assert.match(html, /data-action="stop"/);
  assert.match(html, /data-action="unpause"/);
  assert.match(html, /data-action="start"/);
  assert.match(html, /class="bulkrail hidden"/);
  assert.match(html, /data-verb="pause"/);
  assert.match(html, /data-verb="delete"/);
  assert.match(html, /id="selall"/);
  assert.match(html, /data-name="qm-companion"[\s\S]*?data-protected="1"/);
  assert.match(html, /Protected control-plane container/);
  assert.equal((html.match(/class="rowsel"/g) || []).length, CONTAINER_FIXTURES.length - 1, 'protected row is not selectable');
  const protectedAt = html.indexOf('data-name="qm-companion"');
  const protectedTail = html.slice(protectedAt, html.indexOf('<div class="empty hidden"', protectedAt));
  assert.doesNotMatch(protectedTail, /data-action=|ct-update/);
  assert.match(html, /id="detail"[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(html, /panel\.removeAttribute\('inert'\)/);
  assert.match(html, /panel\.setAttribute\('inert', ''\)/);
  assert.match(html, /id="d-guard"/);
  assert.match(html, /dr\.classList\.toggle\('hidden', protectedRow \|\| missing\)/);
  assert.match(html, /Health not reported/);
  assert.match(html, /sv === 'inactive'.*state !== 'running'.*state !== 'paused'/s);
  assert.match(html, /id="updall"[^>]*><i class="updot">/);
  assert.match(html, /id="upddis"/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('omits container write controls in read-only mode', () => {
  const html = containersPage(CONTAINER_FIXTURES, false, 'csrf-token');
  assert.doesNotMatch(html, /rowsel|selall|bulkv|data-action=|id="updall"|id="cprune"/);
  assert.match(html, /Read-only mode/);
  assert.match(html, /\/console\?id=/);
  assert.match(html, /class="upflag hidden"/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('renders shell controls only with Docker control', () => {
  const control = consolePage(CONTAINER_FIXTURES, 'a'.repeat(12), true, 'csrf-token', true);
  assert.match(control, /class="loglayout"/);
  assert.match(control, /id="logpane"/);
  assert.match(control, /href="\/console\?id=/);
  assert.match(styles, /\.logs \.lvl-err \{ color: #E25A50/);
  assert.match(control, /id="loglevels"/);
  assert.match(control, /id="logtimes"/);
  assert.match(control, /id="logmatch"/);
  assert.match(control, /id="shelltoggle"/);
  assert.match(control, /id="shellpane"/);
  assert.match(control, /id="termin"/);
  assert.ok(compileInlineScripts(control) >= 3);

  const protectedSelection = consolePage(CONTAINER_FIXTURES, 'e'.repeat(12), true, 'csrf-token', true);
  assert.match(protectedSelection, /id="shelltoggle"[^>]* hidden/);
  assert.match(protectedSelection, /function protectedNow\(id\)/);
  assert.match(protectedSelection, /if \(on && protectedNow\(sel\)\) on = false/);

  const readOnly = consolePage(CONTAINER_FIXTURES, 'a'.repeat(12), false, 'csrf-token');
  assert.match(readOnly, /id="logpane"/);
  assert.doesNotMatch(readOnly, /id="shellpane"|id="shelltoggle"|id="termin"/);
  assert.ok(compileInlineScripts(readOnly) >= 3);
});

test('Management and shell controls remain separate', () => {
  const managedContainers = containersPage(CONTAINER_FIXTURES, true, 'csrf-token', false);
  assert.match(managedContainers, /data-action="stop"/);
  assert.doesNotMatch(managedContainers, /href="\/console\?id=[^"]*&shell=1"/);

  const shellContainers = containersPage(CONTAINER_FIXTURES, true, 'csrf-token', true);
  assert.match(shellContainers, /href="\/console\?id=[^"]*&shell=1"/);

  const managedConsole = consolePage(CONTAINER_FIXTURES, 'a'.repeat(12), true, 'csrf-token', false);
  assert.match(managedConsole, /id="logpane"/);
  assert.doesNotMatch(managedConsole, /id="shellpane"|id="shelltoggle"|id="termin"/);

  const shellConsole = consolePage(CONTAINER_FIXTURES, 'a'.repeat(12), true, 'csrf-token', true);
  assert.match(shellConsole, /id="shelltoggle"/);
  assert.match(shellConsole, /configured user and privileges/);
  assert.doesNotMatch(shellConsole, /Running as root inside/i);

  const detected = [{ instanceId: 'sonarr-one', kind: 'sonarr', name: 'Sonarr', port: 8989 }];
  const pairModel = {
    stage: 'configure',
    detected,
    draft: { services: [{ instanceId: 'sonarr-one', included: true, baseUrl: 'http://nas.local:8989', remoteBaseUrl: '' }], edgeAccess: {} },
    issues: [], csrf: 'csrf-token', mintEnabledKinds: [],
  };
  const managedPair = pairPage({ ...pairModel, canShell: false });
  assert.doesNotMatch(managedPair, /<button[^>]*data-read/);
  const shellPair = pairPage({ ...pairModel, canShell: true });
  assert.match(shellPair, /<button[^>]*data-read/);

  for (const page of [managedContainers, shellContainers, managedConsole, shellConsole, managedPair, shellPair]) {
    assert.ok(compileInlineScripts(page) >= 3);
  }
});

function cronRow(html, id) {
  const start = html.indexOf(`data-jid="${id}"`);
  assert.notEqual(start, -1, `Cron row ${id} exists`);
  const end = html.indexOf('<div class="cron-x', start);
  assert.ok(end > start, `Cron row ${id} is complete`);
  return html.slice(start, end);
}

const CRON_FIXTURES = [
  { id: 'updates-check', name: 'Check for image updates', does: 'Refreshes registry digests.', action: 'updates.check', schedule: { type: 'daily', hour: 5, minute: 0 }, enabled: false, history: [] },
  { id: 'prune-images', name: 'Prune dangling images', does: 'Removes dangling images.', action: 'images', schedule: { type: 'weekly', day: 0, hour: 3, minute: 0 }, enabled: false, history: [] },
  { id: 'custom-manage', kind: 'custom', name: 'Tidy images', action: { type: 'prune', what: 'images' }, schedule: { type: 'daily', hour: 2, minute: 0 }, enabled: false, history: [] },
  { id: 'custom-exec', kind: 'custom', name: 'Back up config', action: { type: 'exec', ref: 'a'.repeat(12), cmd: 'backup-now' }, schedule: { type: 'daily', hour: 1, minute: 0 }, enabled: false, history: [{ at: 1, trigger: 'manual', ms: 4, ok: true, note: 'done' }] },
  { id: 'custom-exec-on', kind: 'custom', name: 'Existing command', action: { type: 'exec', ref: 'a'.repeat(12), cmd: 'existing-command' }, schedule: { type: 'daily', hour: 1, minute: 30 }, enabled: true, history: [] },
];

test('Cron actions follow the active Docker access mode', () => {
  const readOnly = cronPage(CRON_FIXTURES, CONTAINER_FIXTURES, false, 'csrf-token', '', false);
  const readUpdate = cronRow(readOnly, 'updates-check');
  const readPrune = cronRow(readOnly, 'prune-images');
  const readCustom = cronRow(readOnly, 'custom-manage');
  assert.doesNotMatch(readOnly, /id="newjob"/);
  assert.match(readOnly, /Current mode: Read only/);
  assert.match(readUpdate, /action="\/cron\/run"/);
  assert.match(readUpdate, /action="\/cron\/toggle"/);
  assert.doesNotMatch(readPrune, /action="\/cron\/(run|toggle)"/);
  assert.match(readPrune, /aria-label="Edit schedule"/);
  assert.match(readPrune, /aria-label="Management mode required"/);
  assert.doesNotMatch(readCustom, /action="\/cron\/(run|toggle)"/);
  assert.match(readCustom, /action="\/cron\/delete"/);
  assert.match(readCustom, /aria-label="Edit schedule"/);

  const management = cronPage(CRON_FIXTURES, CONTAINER_FIXTURES, true, 'csrf-token', '', false);
  const managePrune = cronRow(management, 'prune-images');
  const manageCustom = cronRow(management, 'custom-manage');
  const lockedExec = cronRow(management, 'custom-exec');
  const enabledExec = cronRow(management, 'custom-exec-on');
  assert.match(management, /id="newjob"/);
  assert.match(management, /Current mode: Management/);
  assert.match(management, /<option value="exec" disabled>Run a command in a container \(shell mode required\)<\/option>/);
  assert.match(managePrune, /action="\/cron\/run"/);
  assert.match(managePrune, /action="\/cron\/toggle"/);
  assert.match(manageCustom, /aria-label="Edit job"/);
  assert.doesNotMatch(lockedExec, /action="\/cron\/(run|toggle)"/);
  assert.match(lockedExec, /aria-label="Edit schedule"/);
  assert.match(lockedExec, /action="\/cron\/delete"/);
  assert.match(lockedExec, /aria-label="Management \+ shell mode required"/);
  assert.doesNotMatch(enabledExec, /action="\/cron\/run"/);
  assert.match(enabledExec, /action="\/cron\/toggle"[\s\S]*?name="enabled" value="false"/);
  assert.doesNotMatch(enabledExec, /name="enabled" value="true"/);
  assert.match(management, /scheduleOnly \? '\/cron\/schedule' : '\/cron\/edit'/);
  assert.match(management, /Only its schedule can be changed here/);

  const shellMode = cronPage(CRON_FIXTURES, CONTAINER_FIXTURES, true, 'csrf-token', '', true);
  const shellExec = cronRow(shellMode, 'custom-exec');
  assert.match(shellMode, /Current mode: Management \+ shell/);
  assert.match(shellMode, /<option value="exec">Run a command in a container<\/option>/);
  assert.match(shellExec, /action="\/cron\/run"/);
  assert.match(shellExec, /action="\/cron\/toggle"/);
  assert.match(shellExec, /aria-label="Edit job"/);
  assert.doesNotMatch(shellExec, /mode required/);
  assert.match(shellMode, /configured user and privileges/);
  assert.doesNotMatch(shellMode, /Runs as root inside/i);

  for (const page of [readOnly, management, shellMode]) assert.ok(compileInlineScripts(page) >= 3);
});

test('Settings separates Management and shell status', () => {
  const html = settingsPage({
    dockerHost: 'tcp://socket-proxy:2375', bind: '0.0.0.0', port: 8787,
    trustProxy: false, cookieSecure: false, qmHost: 'nas.local', qmRemoteHost: '', stackDir: '/stack',
  }, true, 'csrf-token', {
    theme: 'dark', clock: '24h', dateFormat: 'dd.mm.yyyy', confirmActions: true,
    logTail: '200', activityRange: '24',
  }, 'docker', {
    mode: 'manage', label: 'Management', ceiling: 'shell', ceilingLabel: 'Management + shell',
    canManage: true, canShell: false,
  });

  assert.match(html, /<span>Active mode<small>[^<]*<\/small><\/span><b>Management<\/b>/);
  assert.match(html, /Management actions <span class="badge ok">[\s\S]*?On<\/span>/);
  assert.match(html, /Container shell <span class="badge line">[\s\S]*?Off<\/span>/);
  assert.match(html, /configured user and privileges/);
  assert.doesNotMatch(html, /run as root inside/i);
  assert.ok(compileInlineScripts(html) >= 3);
});

const { gridColumns, gridTemplate, gridHeader, gridOpen } = await import('../src/ui/columns.js');

function trackCount(template) {
  let depth = 0;
  let tracks = 0;
  let inToken = false;
  for (const ch of template.trim()) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ' ' && depth === 0) { inToken = false; continue; }
    if (!inToken) { tracks += 1; inToken = true; }
  }
  return tracks;
}

test('aligns container headers and rows with registered columns', () => {
  const cases = [{ control: true }, { control: false }];
  for (const { control } of cases) {
    const tracks = trackCount(gridTemplate('containers', { control }));
    assert.equal(tracks, gridColumns('containers', { control }).length, 'template tracks match the registry');
    assert.equal(tracks, control ? 16 : 15);
    const html = containersPage(CONTAINER_FIXTURES, control, 'csrf-token');
    const headerCells = (html.match(/class="hc[ "]/g) || []).length;
    assert.equal(headerCells, tracks, `header cells match tracks with control ${control}`);
    const rowCells = (html.match(/class="td[ "]/g) || []).length;
    assert.equal(rowCells, tracks * CONTAINER_FIXTURES.length, `row cells match tracks with control ${control}`);
  }
});

test('grids expose table semantics, sorting, and resizing', () => {
  const open = gridOpen('containers', { control: true });
  const header = gridHeader('containers', { control: true, rowClass: 't-ctr' });
  const runtime = appRuntime();

  assert.match(open, /role="table"/);
  assert.match(open, /aria-label="Containers table"/);
  assert.match(open, /aria-colcount="16"/);
  assert.match(header, /class="tr t-ctr th" role="row"/);
  assert.equal((header.match(/role="columnheader"/g) || []).length, 16);
  assert.equal((header.match(/aria-sort="none"/g) || []).length, gridColumns('containers', { control: true }).filter((c) => c.sort).length);
  assert.match(runtime, /r\.setAttribute\('role', 'row'\)/);
  assert.match(runtime, /td\.setAttribute\('role', 'cell'\)/);
  assert.match(runtime, /hc\.setAttribute\('aria-sort', 'none'\)/);
  assert.match(runtime, /p\.sort\.dir === 'desc' \? 'descending' : 'ascending'/);
  assert.match(runtime, /grip\.setAttribute\('role', 'separator'\)/);
  assert.match(runtime, /grip\.tabIndex = 0/);
  assert.match(runtime, /e\.key !== 'ArrowLeft' && e\.key !== 'ArrowRight' && e\.key !== 'Home'/);
  assert.match(runtime, /p2\.widths\[hc\.dataset\.col\] = w/);
});

test('renders slide-over sections without server-held values', () => {
  const html = containersPage(CONTAINER_FIXTURES, true, 'csrf-token');
  const at = (needle) => html.indexOf(needle);
  for (const part of ['id="d-envs"', 'id="d-mounts"', 'class="d-adv"', 'id="d-labels"', 'id="d-limits"']) {
    assert.ok(at(part) >= 0, `${part} renders`);
  }
  assert.ok(at('id="d-envs"') < at('id="d-mounts"'));
  assert.ok(at('id="d-mounts"') < at('class="d-adv"'));
  assert.ok(at('class="d-adv"') < at('id="d-labels"'));
  assert.ok(at('id="d-labels"') < at('id="d-limits"'));
  assert.match(html, /\/api\/containers\/inspect\?id=/);
  assert.match(html, /Not sent to this page\. Revealing this value will need re-authentication/);
  assert.match(html, /server-held/);
  assert.doesNotMatch(html, /KEY\|TOKEN\|SECRET\|PASSWORD\|PASS/);
  assert.doesNotMatch(html, /\\u2022\\u2022\\u2022\\u2022/);
  const readOnly = containersPage(CONTAINER_FIXTURES, false, 'csrf-token');
  assert.match(readOnly, /id="d-envs"/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('endpoint chips cap at two ports and carry the reverse-proxy route', () => {
  const html = containersPage(CONTAINER_FIXTURES, true, 'csrf-token');
  assert.match(html, /80:80/);
  assert.match(html, /443:443/);
  assert.match(html, /title="9000:9000">\+1</);
  assert.match(html, /href="https:\/\/app\.example\.com"[^>]*rel="noopener"/);
  assert.match(html, /href="\/stacks#web"/, 'the stack pill links to its anchor');
});

test('known containers link to curated upstream projects', () => {
  const html = containersPage([
    { ...CONTAINER_FIXTURES[0], name: 'komodo-core', kind: 'komodo', image: 'ghcr.io/moghtech/komodo-core:2' },
    { ...CONTAINER_FIXTURES[1], name: 'private-app', kind: '', image: 'registry.internal/private/app:1' },
    { ...CONTAINER_FIXTURES[2], name: 'radarr', kind: 'radarr', image: 'lscr.io/linuxserver/radarr:latest' },
  ], false, 'csrf-token');
  assert.match(html, /data-name="komodo-core"[^>]*data-upstream="https:\/\/github\.com\/moghtech\/komodo"/);
  assert.match(html, /href="https:\/\/github\.com\/moghtech\/komodo"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /id="d-upstream"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /upstreamRow\.hidden = !row\.dataset\.upstream/);
  assert.match(html, /data-name="private-app"[^>]*data-upstream=""/);
  assert.match(html, /data-name="radarr"[^>]*data-upstream="https:\/\/github\.com\/Radarr\/Radarr"/);
  assert.doesNotMatch(html, /registry\.internal[^<]*<svg/);
});

test('route label parser rejects malformed values', () => {
  assert.equal(publicUrlFromLabels({ 'qm.url': 'https://films.example.com/radarr' }), 'https://films.example.com/radarr');
  assert.equal(publicUrlFromLabels({ 'qm.url': 'javascript:alert(1)' }), null);
  assert.equal(publicUrlFromLabels({ 'qm.url': 'https://user:pw@example.com' }), null);
  assert.equal(publicUrlFromLabels({ 'qm.url': 'https://example.com/radarr?token=do-not-render' }), null);
  assert.equal(publicUrlFromLabels({ 'qm.url': 'https://example.com/radarr#private' }), null);
  assert.equal(publicUrlFromLabels({ 'traefik.http.routers.radarr.rule': 'Host(`radarr.example.com`) && PathPrefix(`/x`)' }), 'https://radarr.example.com');
  assert.equal(publicUrlFromLabels({ 'traefik.http.routers.radarr.rule': 'Host(`not a hostname !!`)' }), null);
  assert.equal(publicUrlFromLabels({ caddy: 'films.example.com' }), 'https://films.example.com');
  assert.equal(publicUrlFromLabels({ caddy_0: 'https://films.example.com:8443/path' }), 'https://films.example.com');
  assert.equal(publicUrlFromLabels({ caddy: '*.example.com' }), null);
  assert.equal(publicUrlFromLabels({}), null);
  assert.equal(publicUrlFromLabels(null), null);
  assert.equal(publicUrlFromLabels({ 'qm.url': 12 }), null);
});

test('qm.url labels exclude query and fragment data', () => {
  const html = containersPage([{
    ...CONTAINER_FIXTURES[0],
    labels: { 'qm.url': 'https://app.example.com/radarr?token=do-not-render#private' },
  }], false, 'csrf-token');
  assert.doesNotMatch(html, /do-not-render|#private/);
});

const STACK_FIXTURES = [
  {
    name: 'media-stack', running: 1, total: 1, unhealthy: 0, networks: 1, volumes: 1,
    ids: ['a'.repeat(12)], configFiles: '',
    services: [{ id: 'a'.repeat(12), name: 'app', kind: '', image: 'example/app:latest', state: 'running', health: '', ports: ['8080:8080'], ip: '172.20.0.2', uptime: '6 days' }],
  },
  {
    name: 'loose-stack', running: 0, total: 1, unhealthy: 0, networks: 1, volumes: 0,
    ids: ['b'.repeat(12)], configFiles: '',
    services: [{ id: 'b'.repeat(12), name: 'loose', kind: '', image: 'example/loose:latest', state: 'exited', health: '', ports: [], ip: '', uptime: '' }],
  },
];

test('stack metrics poll without a host Live label', () => {
  const html = stacksPage(STACK_FIXTURES, true, 'csrf-token', ['media-stack']);

  assert.doesNotMatch(html, /class="livemark"/);
  assert.match(html, /class="badge mono port portlink"/);
  assert.match(html, /href="http:\/\/192\.168\.1\.20:8080" target="_blank" rel="noopener"/);
  assert.match(html, /pollStats\(\); setInterval\(pollStats, 5000\)/);
  assert.match(html, /answer\.missing \? ' partial'/);
  assert.match(html, /d\.unavailable \? 'Live container use, '/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('does not show enablement steps for other mobile listener failures', async () => {
  const { devicesPage } = await import('../src/ui/pages/devices.js');
  const misconfigured = devicesPage(
    {
      plane: { ok: false, reason: 'QM_ADVERTISED_ORIGIN port 9999 does not match the listener port 8788; the advertised origin must be the address phones reach.' },
      enrolments: [], devices: [], identity: null, secure: false,
    },
    'csrf-token', null, null, null,
  );
  assert.doesNotMatch(misconfigured, /Publish port 8788|MOBILE_API_ENABLED=true|docker-compose\.mobile\.yml/);
});

test('preserves unknown resource counts and confirmation', () => {
  const unknown = [{
    name: 'media-stack', running: 1, total: 1, unhealthy: 0, networks: null, volumes: null,
    ids: ['a'.repeat(12)], configFiles: '',
    services: [{ id: 'a'.repeat(12), name: 'app', kind: '', image: 'example/app:latest', state: 'running', health: '', ports: [], ip: '', uptime: '3 days' }],
  }];
  const html = stacksPage(unknown, true, 'csrf-token', []);

  assert.match(html, /net unknown/);
  assert.match(html, /vol unknown/);
  assert.doesNotMatch(html, />0 net</);
  assert.doesNotMatch(html, />0 vol</);
  assert.doesNotMatch(html, /NaN/, 'nor arithmetic on a null');

  assert.match(html, /data-volumes=""/);
  assert.match(html, /volRaw === '' \|\| volRaw === undefined \? null : Number\(volRaw\)/);
  assert.match(html, /\(volumes === null \|\| volumes > 0\) \? name : undefined/, 'unknown takes the typed gate');
  assert.match(html, /Volume ownership could not be determined/);

  const known = [{ ...unknown[0], networks: 0, volumes: 0 }];
  const knownHtml = stacksPage(known, true, 'csrf-token', []);
  assert.match(knownHtml, /data-volumes="0"/);
  assert.match(knownHtml, /0 net/);
});

test('stack service meters render visible indicators', () => {
  for (const cls of ['m-cpu', 'm-mem', 'm-net', 'm-dsk']) {
    assert.match(styles, new RegExp(`\\.${cls} \\.m-bar i \\{[^}]*background:`), `${cls} paints its fill`);
  }
  assert.match(styles, /\.m-cpu \.m-bar i \{ background: var\(--accent\); \}/);
  assert.match(styles, /\.m-mem \.m-bar i \{ background: var\(--teal\); \}/);
  for (const status of ['--ok', '--warn', '--bad']) {
    for (const cls of ['m-net', 'm-dsk']) {
      assert.doesNotMatch(
        styles,
        new RegExp(`\\.${cls} \\.m-bar i \\{[^}]*var\\(${status}`),
        `${cls} does not dress a ranking as a status`,
      );
    }
  }
});

test('running stack services include uptime', () => {
  const html = stacksPage(STACK_FIXTURES, true, 'csrf-token', ['media-stack']);
  const running = STACK_FIXTURES.flatMap((s) => s.services).filter((s) => s.state === 'running' && s.uptime);
  for (const svc of running) {
    assert.match(html, new RegExp(`class="svc-age">${svc.uptime}<`), `${svc.name} shows its age`);
  }
  const stopped = STACK_FIXTURES.flatMap((s) => s.services).filter((s) => s.state !== 'running');
  assert.equal(
    (html.match(/class="svc-age"/g) || []).length,
    running.length,
    `only the ${running.length} running services carry an age, not the ${stopped.length} stopped`,
  );
});

test('stack service cards report outdated images', () => {
  const html = stacksPage(STACK_FIXTURES, true, 'csrf-token', ['media-stack']);

  for (const stack of STACK_FIXTURES) {
    for (const svc of stack.services) {
      assert.match(
        html,
        new RegExp(`class="svccard[^"]*" data-img="${svc.image.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}"`),
        `${svc.name} carries its image ref`,
      );
    }
  }
  const markers = html.match(/class="svc-upd hidden"/g) || [];
  const services = STACK_FIXTURES.reduce((n, s) => n + s.services.length, 0);
  assert.equal(markers.length, services, 'every service card has its own update marker');

  assert.match(html, /answer\.status === 'update' && !answer\.dismissed/);
  assert.match(html, /querySelectorAll\('\.svccard'\)/);
  assert.match(styles, /\.svc-upd \{/, 'the marker is styled');
  assert.match(styles, /\.svccard\.has-update/);
});

test('renders stack rows in the shared control grid', () => {
  const html = stacksPage(STACK_FIXTURES, true, 'csrf-token', ['media-stack']);
  const tracks = trackCount(gridTemplate('stacks'));
  assert.equal(tracks, gridColumns('stacks').length, 'stack template tracks match the registry');
  assert.equal(tracks, 10);
  assert.equal((html.match(/class="hc[ "]/g) || []).length, tracks, 'stack header cells match the registry');
  assert.equal((html.match(/class="td[ "]/g) || []).length, tracks * STACK_FIXTURES.length, 'stack row cells match the registry');
  assert.match(html, /data-grid="stacks"/);
  assert.match(html, /data-col="stack" data-fixed="1"/, 'stack identity stays pinned in saved layouts');
  assert.match(html, /id="stack-state"/);
  assert.match(html, /id="stack-source"/);
  assert.match(html, /data-grid-gear/);
  assert.match(styles, /\.stack-grid > \.tr\.t-stack/);
  assert.match(html, /<span class="state ok"><i><\/i>Running<\/span>/);
  assert.match(html, /<span class="state off"><i><\/i>Stopped<\/span>/);
  assert.match(html, /class="state off stack-update"><i><\/i><span>Not checked<\/span>/);
  for (const verb of ['start', 'restart', 'stop', 'redeploy', 'remove']) {
    assert.match(html, new RegExp(`class="btn sv[^"]*" data-verb="${verb}"`), `verb ${verb} renders`);
  }
  assert.equal((html.match(/class="stack-commandbar"/g) || []).length, STACK_FIXTURES.length);
  assert.doesNotMatch(html, /class="stack-verbs"|class="actbtn [^"]*svq/);
  assert.match(html, /Managed<\/span>/);
  assert.match(html, /Observed<\/span>/);
  assert.match(html, /class="btn stack-adopt" data-stack="loose-stack"/);
  for (const answer of ['Not checked', ' update', ' unknown', ' dismissed', 'Current']) assert.match(html, new RegExp(answer));
  assert.ok(compileInlineScripts(html) >= 3);
});

test('read-only stacks omit Docker actions', () => {
  const html = stacksPage(STACK_FIXTURES, false, 'csrf-token', []);
  assert.doesNotMatch(html, /class="btn sv|data-verb="|id="sed-redeploy"/);
  assert.match(html, /class="btn stack-adopt"/);
  assert.match(html, /id="sed-save"/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('protected stacks show their shield and no Docker controls', () => {
  const protectedStack = [{
    ...STACK_FIXTURES[0],
    name: 'qm_companion',
    services: STACK_FIXTURES[0].services.map((service) => ({ ...service, protected: true })),
  }];
  const html = stacksPage(protectedStack, true, 'csrf-token', ['qm_companion']);
  assert.match(html, /data-protected="1"/);
  assert.match(html, /Protected control plane/);
  assert.doesNotMatch(html, /class="btn sv|data-verb=/);
  assert.match(html, /!managed \|\| sedProtected/);
  assert.match(styles, /\.mode-note \{[^}]*white-space: nowrap/);
  assert.match(styles, /\.mode-note svg \{ width: 14px; height: 14px; flex: 0 0 14px/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('dirty Compose edits ask before close or navigation', () => {
  const html = stacksPage(STACK_FIXTURES, true, 'csrf-token', ['media-stack']);
  assert.match(html, /sedYaml\.addEventListener\('input', function \(\) \{ sedDirty = true/);
  assert.match(html, /title: 'Discard Compose changes\?'/);
  assert.match(html, /confirmLabel: 'Discard changes'/);
  assert.match(html, /window\.addEventListener\('beforeunload'/);
  assert.match(html, /if \(!sedDirty\) \{ closeEditorNow\(\); return; \}/);
  assert.ok(compileInlineScripts(html) >= 3);
});
