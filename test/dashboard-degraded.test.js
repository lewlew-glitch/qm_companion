import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-dash-'));
process.env.SECRET_KEY = 'ab'.repeat(32);
process.env.QM_HOST = 'nas.local';
process.env.DATA_DIR = dataDir;
process.env.QM_STACK = '/mnt/user/appdata';
process.env.DOCKER_ACCESS_MAX = 'read';

const { dashboardPage } = await import('../src/ui/pages/dashboard.js');

const NO_LIVE = { now: [], arr: [] };
const COUNTS = { total: 12, running: 7, paused: 0, restarting: 0, unhealthy: 0, healthy: 0, starting: 0 };
const docker = (over = {}) => ({ counts: { ...COUNTS, ...(over.counts || {}) }, info: {}, events: [], containers: [], ...over.rest });

function svc(kind, over = {}) {
  return { kind, port: 7878, instanceId: `${kind}-1`, ...over };
}

function block(html, open, close = '</div>') {
  const at = html.indexOf(open);
  assert.notEqual(at, -1, `${open} is present`);
  return html.slice(at, html.indexOf(close, at) + close.length);
}

test('renders stopped and paused containers as neutral', () => {
  const html = dashboardPage([
    svc('radarr', { dockerState: 'exited', up: false, apiKey: 'k' }),
    svc('sonarr', { dockerState: 'paused', up: false, apiKey: 'k', port: 8989 }),
  ], NO_LIVE, docker(), 'csrf');

  assert.match(html, /data-state="not-running"/);
  assert.match(html, /<span class="state off"><i><\/i>Stopped<\/span>/);
  assert.match(html, /<span class="state off"><i><\/i>Paused<\/span>/);
  assert.doesNotMatch(html, /<span class="state bad"><i><\/i>Offline<\/span>/);
  assert.doesNotMatch(html, /svc-row is-offline/);
});

test('renders an unreachable running container as a warning', () => {
  const html = dashboardPage([svc('radarr', { dockerState: 'running', up: false, apiKey: 'k' })], NO_LIVE, docker(), 'csrf');
  assert.match(html, /data-state="unreachable"/);
  const row = block(html, '<div class="tr t-svc svc-row', '</div>\n    </div>');
  assert.match(row, /<span class="state warn"><i><\/i>Unreachable<\/span>/);
  assert.doesNotMatch(row, /state bad/);
});

test('each detected service maps to one availability count', () => {
  const detected = [
    svc('radarr', { dockerState: 'running', up: true, apiKey: 'k' }),
    svc('sonarr', { dockerState: 'running', up: false, apiKey: 'k', port: 8989 }),
    svc('lidarr', { dockerState: 'exited', up: false, apiKey: 'k', port: 8686 }),
    svc('jellyfin', { dockerState: 'running', port: 8096 }),
    svc('prowlarr', { up: true, apiKey: 'k', port: 9696 }),
  ];
  const facts = block(dashboardPage(detected, NO_LIVE, docker(), 'csrf'), '<div class="section-facts">');

  assert.match(facts, /1 reachable/);
  assert.match(facts, /1 unreachable/);
  assert.match(facts, /1 not running/);
  assert.match(facts, /2 not checked/);
  const availability = [...facts.matchAll(/<span[^>]*>(\d+) (reachable|unreachable|not running|not checked)</g)];
  const counted = availability.reduce((n, m) => n + Number(m[1]), 0);
  assert.equal(counted, detected.length, 'the availability figures account for every row');
});

test('removes the running-success tone when the count reaches zero', () => {
  const idle = dashboardPage([], NO_LIVE, docker({ counts: { running: 0 } }), 'csrf');
  const busy = dashboardPage([], NO_LIVE, docker(), 'csrf');

  assert.doesNotMatch(idle, /class="dm-value ok" data-count="running"/);
  assert.match(idle, /class="dm-value" data-count="running" data-tone="running">0</);
  assert.match(busy, /class="dm-value ok" data-count="running" data-tone="running">7</);
  assert.doesNotMatch(idle, /class="dm-icon ok" data-tone="running"/);
  assert.match(busy, /tone\('running',\(c\.running\|\|0\)>0\);/);
  assert.match(busy, /classList\.toggle\('ok'/);
});

test('reports the failed search without suggesting bare Compose', () => {
  const empty = block(dashboardPage([], NO_LIVE, docker(), 'csrf'), '<div class="empty first-run">', '</a></div>');

  assert.doesNotMatch(empty, /QM_HOST/);
  assert.doesNotMatch(empty, /mount service configs at <code class="mono">\/stack<\/code>/);
  assert.match(empty, /\/mnt\/user\/appdata/);
  assert.match(empty, /QM_STACK/);
  assert.match(empty, /-f<\/code> overlay/);
  assert.doesNotMatch(empty, />docker compose up -d</);
  assert.match(empty, /Docker returned 12 containers/, 'the Docker result count is reported');

  const noDocker = block(dashboardPage([], NO_LIVE, { counts: null, info: null, events: null, containers: null }, 'csrf'), '<div class="empty first-run">', '</a></div>');
  assert.match(noDocker, /Docker is unavailable/);
  assert.doesNotMatch(noDocker, /QM_HOST/);
});

test('phone setup excludes unavailable services', () => {
  const stopped = dashboardPage([
    svc('radarr', { dockerState: 'running', up: true, apiKey: 'k' }),
    svc('sonarr', { dockerState: 'exited', up: false, apiKey: 'k', port: 8989 }),
  ], NO_LIVE, docker(), 'csrf');
  const panel = block(stopped, '<section class="phone-setup', '</section>');

  assert.match(panel, /class="phone-setup action"/);
  assert.doesNotMatch(panel, /class="phone-setup ready"/);
  assert.doesNotMatch(panel, /Ready to create a setup code/);
  assert.match(panel, /1 service ready, 1 left out/);
  assert.match(panel, /Start it in Docker/);
  assert.match(panel, /<b>1<\/b> included in scan/, 'the stopped service is not counted as included');

  const ready = block(dashboardPage([svc('radarr', { dockerState: 'running', up: true, apiKey: 'k' })], NO_LIVE, docker(), 'csrf'), '<section class="phone-setup', '</section>');
  assert.match(ready, /class="phone-setup ready"/);
  assert.match(ready, /Ready to create a setup code/);
});

test('phone setup counts read as English at one', () => {
  const one = block(dashboardPage([svc('jellyfin', { dockerState: 'running', up: true, port: 8096 })], NO_LIVE, docker(), 'csrf'), '<section class="phone-setup', '</section>');
  assert.match(one, /1 service needs setup before the scan/);
  assert.match(one, /<b>1<\/b> needs setup/);
  assert.doesNotMatch(one, /1 services|1 need setup/);

  const conflicted = block(dashboardPage([svc('radarr', { dockerState: 'running', up: true, apiKey: 'k', credentialConflict: true })], NO_LIVE, docker(), 'csrf'), '<section class="phone-setup', '</section>');
  assert.match(conflicted, /1 credential conflict needs review/);
  assert.match(conflicted, /<b>1<\/b> conflict</);
  assert.doesNotMatch(conflicted, /<b>1<\/b> conflicts/);
});

test('media panel reports stopped containers before credential errors', () => {
  const html = dashboardPage([
    svc('radarr', { dockerState: 'running', up: true, apiKey: 'k' }),
    svc('sonarr', { dockerState: 'exited', up: false, apiKey: 'k', port: 8989 }),
  ], NO_LIVE, docker(), 'csrf');

  assert.doesNotMatch(html, /Queue and warnings need service access/);
  assert.match(html, /Sonarr is stopped, so it reports no queue and no warnings\. Start it in Docker/);
});

test('a container list that did not answer is reported, not silently dropped', () => {
  const html = dashboardPage([], NO_LIVE, { counts: { ...COUNTS }, info: {}, events: [], containers: null }, 'csrf');
  assert.match(html, /Docker did not return the container list, so stacks cannot be grouped/);
});

test('missing Docker counts produce an empty shell state', () => {
  const html = dashboardPage([], NO_LIVE, { counts: null, info: null, events: null, containers: null }, 'csrf');
  assert.doesNotMatch(html, /fallbackPoll: poll/);
  assert.match(html, /Container figures unavailable/);
});

test('Docker being unavailable names the address, the cause and the command', () => {
  const html = dashboardPage([], NO_LIVE, { counts: null, info: null, events: null, containers: null }, 'csrf');
  const connection = block(html, '<div class="de-connection">');

  assert.match(connection, /Docker unavailable/);
  assert.doesNotMatch(connection, /Service discovery and phone setup remain available\.<\/small>/);
  assert.match(connection, /No Docker socket at <code class="mono">\/var\/run\/docker\.sock<\/code>/);
  assert.match(connection, /- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
  assert.match(connection, /up -d companion/);
  assert.match(connection, /same <code class="mono">-f<\/code> overlays in the same order/);
  assert.doesNotMatch(connection, />docker compose up -d</);
});

test('host strip omits Live with and without Docker facts', () => {
  const dark = block(dashboardPage([], NO_LIVE, { counts: null, info: null, events: null, containers: null }, 'csrf'), '<div class="factstrip">');
  const lit = block(dashboardPage([], NO_LIVE, docker(), 'csrf'), '<div class="factstrip">');

  assert.doesNotMatch(dark, /livemark/);
  assert.doesNotMatch(lit, /livemark/);
});

test('non-running containers do not render links', () => {
  const html = dashboardPage([
    svc('radarr', { dockerState: 'exited', up: false, apiKey: 'k' }),
    svc('sonarr', { dockerState: 'running', up: false, apiKey: 'k', port: 8989 }),
  ], NO_LIVE, docker(), 'csrf');

  const stopped = block(html, '<div class="tr t-svc svc-row is-not-running', '</div>\n    </div>');
  assert.doesNotMatch(stopped, /<a class="service-route/);
  assert.match(stopped, /<span class="addr mono">http:\/\/nas\.local:7878<\/span>/);

  const unreachable = block(html, '<div class="tr t-svc svc-row is-unreachable', '</div>\n    </div>');
  assert.match(unreachable, /<a class="service-route mono" href="http:\/\/nas\.local:8989"/, 'the browser may reach what Companion cannot');
});

test('scan copy omits keys excluded from the scan', () => {
  const html = dashboardPage([
    svc('radarr', { dockerState: 'running', up: true, apiKey: 'k' }),
    svc('sonarr', { dockerState: 'exited', up: false, apiKey: 'k', port: 8989 }),
  ], NO_LIVE, docker(), 'csrf');

  const reachable = block(html, '<div class="tr t-svc svc-row is-online', '</div>\n    </div>');
  const stopped = block(html, '<div class="tr t-svc svc-row is-not-running', '</div>\n    </div>');
  assert.match(reachable, /Included in scan/);
  assert.doesNotMatch(stopped, /Included in scan/, 'the hand-over leaves a stopped service behind');
  assert.match(stopped, /Key held back/);
  assert.match(stopped, /data-pairing="included"/);
});

process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));
