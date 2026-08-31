import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-companion-empty-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = 'nas.local';
process.env.DATA_DIR = dataDir;

const { containersPage } = await import('../src/ui/pages/containers.js');
const { imagesPage } = await import('../src/ui/pages/images.js');
const { volumesPage } = await import('../src/ui/pages/volumes.js');
const { networksPage } = await import('../src/ui/pages/networks.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

function compileInlineScripts(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  return scripts.length;
}

const EMPTY_PAGES = [
  ['containers', () => containersPage([], true, 'csrf-token', true)],
  ['images', () => imagesPage([], new Set(), true, 'csrf-token', {})],
  ['volumes', () => volumesPage([], true, 'csrf-token', {})],
  ['networks', () => networksPage([], true, 'csrf-token')],
];

test('renders an empty state when a page has no rows', () => {
  for (const [name, render] of EMPTY_PAGES) {
    const html = render();
    assert.doesNotMatch(html.split('<script')[0], /role="columnheader"/, `${name} renders no header`);
    assert.doesNotMatch(html, /class="tr t-(ctr|img|vol|net) th"/, `${name} renders no header row`);
    assert.match(html, /<div class="empty">/, `${name} renders a zero-row branch`);
    const empty = /<div class="empty">([\s\S]*?)<\/div>/.exec(html)[1];
    assert.doesNotMatch(empty, /matches that filter/, `${name} does not blame a filter`);
    assert.ok(compileInlineScripts(html) >= 1, `${name} scripts compile`);
  }
});

test('renders recovery commands for zero-row pages', () => {
  const containers = /<div class="empty">([\s\S]*?)<\/div>/.exec(containersPage([], true, 'c'))[1];
  assert.match(containers, /docker compose -f docker-compose\.example\.yml up -d/);
  assert.match(containers, /Repeat every <code class="mono">-f<\/code> file this install already starts with, in the same\s+order/);

  const images = /<div class="empty">([\s\S]*?)<\/div>/.exec(imagesPage([], new Set(), true, 'c', {}))[1];
  assert.match(images, /docker pull /);

  const volumes = /<div class="empty">([\s\S]*?)<\/div>/.exec(volumesPage([], true, 'c', {}))[1];
  assert.match(volumes, /<code class="mono">volumes:<\/code>/);
  assert.match(volumes, /docker compose -f docker-compose\.example\.yml up -d/);

  const networks = /<div class="empty">([\s\S]*?)<\/div>/.exec(networksPage([], true, 'c'))[1];
  assert.match(networks, /bridge/);
  assert.match(networks, /docker network ls/);
});

test('hides destructive and create actions for an empty list', () => {
  for (const [name, render] of EMPTY_PAGES) {
    const html = render();
    assert.doesNotMatch(html, /id="cprune"|id="prunebtn"|id="pruneallbtn"|id="volprune"|id="netprune"/, `${name} offers no Prune`);
    assert.doesNotMatch(html, /id="pullbtn"|id="netcreate"/, `${name} offers no Pull or Create`);
    assert.doesNotMatch(html, /id="updall"|id="upddis"|class="bulkrail/, `${name} offers no bulk update`);
  }
});

test('distinguishes filter and empty-page messages', () => {
  const containers = containersPage([{ id: 'a'.repeat(12), name: 'app', image: 'x/app:1', state: 'running', status: 'Up', health: '', uptime: 'Up 1 minute', ports: [], ip: '', stack: '', kind: '' }], true, 'c');
  assert.match(containers, /\(term \|\| sv\)\s*\?\s*'Nothing matches that filter\.'\s*:\s*'No containers left on this page/);
  assert.match(containers, /st\.addEventListener\('change', apply\);[\s\S]{0,400}?\n\s*apply\(\);/);

  const images = imagesPage([{ id: 'i1', tags: ['x/app:1'], tagList: [], size: 1, created: 1, fullId: 'sha256:1' }], new Set(), true, 'c', {});
  assert.match(images, /e\.textContent = t\s*\?\s*'Nothing matches that filter\.'\s*:\s*'No images left on this page/);
  assert.match(images, /q\.addEventListener\('input', apply\);[\s\S]{0,200}?\n\s*apply\(\);/);

  const volumes = volumesPage([{ name: 'v1', driver: 'local', created: 0, mountpoint: '/x', stack: '' }], true, 'c', {});
  assert.match(volumes, /empty\.textContent = term[\s\S]{0,200}?'No volumes left on this page/);
  assert.match(volumes, /if \(q\) q\.addEventListener\('input', apply\);[\s\S]{0,200}?\n\s*apply\(\);/);

  const networks = networksPage([{ name: 'bridge', driver: 'bridge', scope: 'local', containers: 0, containerNames: [] }], true, 'c');
  assert.match(networks, /var filtered = !!\(term \|\| want \|\| sc\);/);
  assert.match(networks, /'No networks left on this page/);
  assert.match(networks, /sf\.addEventListener\('change', apply\);[\s\S]{0,400}?\n\s*apply\(\);/);
});

const CONTAINER_ROWS = [
  { id: 'a'.repeat(12), name: 'running-app', image: 'x/app:1', state: 'running', status: 'Up 1 minute', health: '', uptime: 'Up 1 minute', ports: [], ip: '', stack: '', kind: '' },
  { id: 'b'.repeat(12), name: 'looper', image: 'x/loop:1', state: 'restarting', status: 'Restarting (1) 2 seconds ago', health: '', uptime: '', ports: [], ip: '', stack: '', kind: '' },
  { id: 'c'.repeat(12), name: 'stopped-app', image: 'x/st:1', state: 'exited', status: 'Exited (0)', health: '', uptime: '', ports: [], ip: '', stack: '', kind: '' },
  { id: 'e'.repeat(12), name: 'qm-companion', image: 'qm_companion-companion', state: 'running', status: 'Up 2 hours', health: '', uptime: 'Up 2 hours', ports: [], ip: '', stack: '', kind: '', protected: true },
];

test('renders restarting containers as active', () => {
  const html = containersPage(CONTAINER_ROWS, true, 'csrf-token');
  const line = /<span class="hint fleet-line">([\s\S]*?)<\/span>/.exec(html)[1];
  assert.match(line, /2 running/);
  assert.match(line, /1 inactive/);
  assert.match(line, /1 restarting/);
  const at = html.indexOf('data-col="restarts"', html.indexOf('data-name="looper"'));
  const cell = html.slice(at, html.indexOf('</div>', at));
  assert.doesNotMatch(cell, /<span class="faint">-<\/span>/);
  assert.match(cell, /href="\/console\?id=bbbbbbbbbbbb"/);
  assert.match(cell, /Looping/);
  assert.match(cell, /Restart counts are read alongside container stats/);
  const stoppedAt = html.indexOf('data-col="restarts"', html.indexOf('data-name="stopped-app"'));
  assert.match(html.slice(stoppedAt, stoppedAt + 120), /<span class="faint">-<\/span>/);
});

test('clears stale container CPU data when metrics are unavailable', () => {
  const html = containersPage(CONTAINER_ROWS, true, 'csrf-token');
  assert.match(html, /METRIC_WORD\[row\.dataset\.state\] \|\| 'Not running'/);
  assert.match(html, /restarting: 'None while it restarts'/);
  assert.match(html, /paused: 'None while paused'/);
  assert.match(html, /d-cpu'\)\.textContent = word/);
  assert.match(html, /d-mem'\)\.textContent = word/);
});

test('renders inspect failure and hides unavailable actions', () => {
  const html = containersPage(CONTAINER_ROWS, true, 'csrf-token');
  assert.doesNotMatch(html, /dNote\(envs, 'Unavailable'\)/);
  assert.match(html, /throw new Error\(String\(r\.status\)\)/);
  assert.match(html, /Container not found\. Reload the page for the current list/);
  assert.match(html, /dNote\(limits, gone \? 'Not read: the container is gone\.' : 'Not read\.'\)/);
  assert.match(html, /if \(why === '404'\) \{ goneIds\[id\] = 1; syncDetail\(\); \}/);
  assert.match(html, /dr\.classList\.toggle\('hidden', protectedRow \|\| missing\)/);
  assert.match(html, /id="d-gone"/);
  assert.ok(compileInlineScripts(html) >= 3);
});

test('renders image update guidance and dismissal', () => {
  const html = containersPage(CONTAINER_ROWS, true, 'csrf-token');
  assert.match(html, /updcluster\.classList\.toggle\('hidden', pending\.length === 0 && dismissable\.length === 0\)/);
  assert.match(html, /if \(updall\) updall\.classList\.toggle\('hidden', pending\.length === 0\)/);
  assert.match(html, /id="updself"/);
  assert.match(html, /the panel, so it will not update/);
  assert.match(html, /docker compose -f docker-compose\.example\.yml up -d --build --pull always/);
});

test('hides destructive actions after a page becomes empty', () => {
  const containers = containersPage(CONTAINER_ROWS, true, 'c');
  assert.match(containers, /prune\.classList\.toggle\('hidden', total === 0\)/);

  const volumes = volumesPage([{ name: 'v1', driver: 'local', created: 0, mountpoint: '/x', stack: '' }], true, 'c', {});
  assert.match(volumes, /getElementById\('volprune'\)[\s\S]{0,120}?classList\.toggle\('hidden', total === 0\)/);

  const images = imagesPage([{ id: 'i1', tags: ['x/app:1'], tagList: [], size: 1, created: 1, fullId: 'sha256:1' }], new Set(), true, 'c', {});
  assert.match(images, /prunable\(total > 0\)/);
  assert.match(images, /\['prunebtn', 'pruneallbtn'\][\s\S]{0,200}?classList\.toggle\('hidden', left === 0\)/);
});
