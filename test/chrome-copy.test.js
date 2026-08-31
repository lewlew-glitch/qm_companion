import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-chrome-copy-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = 'nas.local';
process.env.DATA_DIR = dataDir;
process.env.DOCKER_ACCESS_MAX = 'read';

const { settingsPage } = await import('../src/ui/pages/settings.js');
const { shell } = await import('../src/ui/chrome.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

const CHROME = new URL('../src/ui/chrome.js', import.meta.url).href;

function renderEmptyStates(dockerHost) {
  const script = `
const { proxyBlocked, noSocket } = await import(${JSON.stringify(CHROME)});
process.stdout.write(JSON.stringify({
  blocked: proxyBlocked('containers', 'box', 'Containers', 'CONTAINERS', 'csrf-token'),
  gone: noSocket('containers', 'box', 'Containers', 'csrf-token'),
}));`;
  const home = mkdtempSync(join(tmpdir(), 'qm-chrome-copy-child-'));
  try {
    const env = { ...process.env, DATA_DIR: home };
    if (dockerHost === null) delete env.DOCKER_HOST;
    else env.DOCKER_HOST = dockerHost;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function emptyOf(html) {
  const match = html.match(/<div class="empty">([\s\S]*?)<\/div>/);
  assert.ok(match, 'the page is an empty state');
  return match[1];
}

function accessState(over) {
  return {
    mode: 'read', label: 'Read only', shortLabel: 'Read only',
    ceiling: 'read', ceilingLabel: 'Read only', explicitCeiling: true,
    canManage: false, canShell: false, ...over,
  };
}

const CFG = {
  dockerHost: 'tcp://socket-proxy:2375', bind: '0.0.0.0', port: 8787, trustProxy: false,
  cookieSecure: false, qmHost: 'nas.local', qmRemoteHost: '', stackDir: '/stack',
};
const PREFS = {
  theme: 'dark', clock: '24h', dateFormat: 'dd.mm.yyyy', confirmActions: true,
  logTail: '200', activityRange: '24',
};

function dockerTab(access) {
  return settingsPage(CFG, false, 'csrf-token', PREFS, 'docker', accessState(access));
}

function ceilingNote(html) {
  const match = html.match(/<span>Installed maximum<small>([\s\S]*?)<\/small><\/span>/);
  assert.ok(match);
  return match[1];
}

test('host strip omits Live', () => {
  assert.doesNotMatch(shell('containers', null, null, '<p>rows</p>'), /class="livemark"/);
  for (const host of ['tcp://socket-proxy:2375', '/var/run/docker.sock']) {
    const { blocked, gone } = renderEmptyStates(host);
    assert.doesNotMatch(blocked, /class="livemark"/, `proxyBlocked stays unmarked (${host})`);
    assert.doesNotMatch(gone, /class="livemark"/, `noSocket stays unmarked (${host})`);
  }
});

test('TCP DOCKER_HOST omits local socket-mount instructions', () => {
  const rendered = renderEmptyStates('tcp://socket-proxy:2375');
  const blocked = emptyOf(rendered.blocked);
  const gone = emptyOf(rendered.gone);

  assert.doesNotMatch(gone, /This lights up when the companion runs on your server with the socket mounted/);
  assert.match(gone, /tcp:\/\/socket-proxy:2375/, 'it names the address that is silent');
  assert.match(gone, /socket-proxy<\/code> service/, 'and the compose service behind it');
  assert.match(gone, /up -d --build socket-proxy/, 'and the command that starts it');

  assert.match(blocked, /CONTAINERS: 1/);
  assert.match(blocked, /socket-proxy<\/code> service/);
  assert.match(blocked, /docker compose -f docker-compose\.example\.yml up -d --build socket-proxy/);
});

test('a socket path names the volume line that is missing', () => {
  const gone = emptyOf(renderEmptyStates('/var/run/docker.sock').gone);
  assert.match(gone, /No Docker socket at/);
  assert.match(gone, /- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/, 'the exact volume line');
  assert.match(gone, /volumes:/);
  assert.match(gone, /up -d --build companion/);
  const bare = emptyOf(renderEmptyStates('tcp://127.0.0.1:1').gone);
  assert.doesNotMatch(bare, /service/);
  assert.match(bare, /127\.0\.0\.1:1/);
});

test('recovery text omits bare docker compose up -d', () => {
  for (const host of ['tcp://socket-proxy:2375', '/var/run/docker.sock', 'ssh://nas', null]) {
    const { blocked, gone } = renderEmptyStates(host);
    assert.doesNotMatch(blocked, /docker compose up -d/, `proxyBlocked (${host})`);
    assert.doesNotMatch(gone, /docker compose up -d/, `noSocket (${host})`);
  }
  assert.doesNotMatch(dockerTab(), /docker compose up -d/);
});

test('unavailable Docker mode reports file, value, and command', () => {
  const html = dockerTab();
  assert.doesNotMatch(html, /Requires the management install profile/);
  assert.doesNotMatch(html, /Requires the shell access install profile/);

  for (const [file, value] of [['docker-compose.management.yml', 'manage'], ['docker-compose.shell.yml', 'shell']]) {
    assert.match(html, new RegExp(file.replace(/\./g, '\\.')), `names ${file}`);
    assert.match(html, new RegExp(`DOCKER_ACCESS_MAX: ${value}`), `names the value for ${value}`);
    assert.match(
      html,
      new RegExp(`docker compose -f docker-compose\\.example\\.yml -f ${file.replace(/\./g, '\\.')} up -d`),
      `names the command for ${value}`,
    );
  }
  assert.match(html, /POST: 1/);
  assert.match(html, /EXEC: 1/);
  assert.match(html, /Keep every other <code class="mono">-f<\/code> file this install already starts with, in the same order\./);
});

test('unreachable Docker message identifies the configured host', () => {
  const proxied = dockerTab().match(/<span>Socket reachable [\s\S]*?<small>([\s\S]*?)<\/small>/);
  assert.ok(proxied);
  assert.doesNotMatch(proxied[1], /Mount the socket/);
  assert.match(proxied[1], /tcp:\/\/socket-proxy:2375/);

  const direct = settingsPage(
    { ...CFG, dockerHost: '/var/run/docker.sock' }, false, 'csrf-token', PREFS, 'docker', accessState(),
  ).match(/<span>Socket reachable [\s\S]*?<small>([\s\S]*?)<\/small>/);
  assert.match(direct[1], /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
});

test('installed maximum identifies the active switch', () => {
  const legacy = ceilingNote(dockerTab({
    mode: 'shell', label: 'Management + shell', shortLabel: 'Shell',
    ceiling: 'shell', ceilingLabel: 'Management + shell', explicitCeiling: false,
    canManage: true, canShell: true,
  }));
  assert.match(legacy, /DOCKER_ACCESS_MAX is not in this config/);
  assert.match(legacy, /DOCKER_CONTROL: true/);
  assert.doesNotMatch(legacy, /DOCKER_ACCESS_MAX and the matching socket-proxy profile set this ceiling/);
  assert.match(legacy, /docker compose -f docker-compose\.example\.yml up -d/, 'and how to move it');

  const bare = ceilingNote(dockerTab({ explicitCeiling: false }));
  assert.match(bare, /Neither DOCKER_ACCESS_MAX nor DOCKER_CONTROL is in this config/);
  assert.match(bare, /-f docker-compose\.management\.yml up -d/);

  const explicit = ceilingNote(dockerTab({
    mode: 'manage', label: 'Management', shortLabel: 'Manage',
    ceiling: 'manage', ceilingLabel: 'Management', explicitCeiling: true, canManage: true,
  }));
  assert.match(explicit, /DOCKER_ACCESS_MAX: manage on the companion service sets this/);
  assert.match(explicit, /-f docker-compose\.shell\.yml up -d/);
});

test('read-only ceiling omits an unusable access dialog', () => {
  const NAV = /Change it from Docker access in the navigation\./;
  assert.doesNotMatch(dockerTab({ mode: 'read', ceiling: 'read' }), NAV);
  assert.match(dockerTab({
    mode: 'manage', label: 'Management', shortLabel: 'Manage',
    ceiling: 'manage', ceilingLabel: 'Management', canManage: true,
  }), NAV);
});
