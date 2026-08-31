import { readFileSync } from 'node:fs';

import { escapeHtml } from '../../http.js';
import { dockerAccessState, dockerModeRank } from '../../docker-access.js';
import { tag } from '../bits.js';
import { board, shell } from '../chrome.js';

// Read the displayed version from package.json.
let VERSION = '';
try {
  VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || '';
} catch {
  /* The about card handles a missing manifest. */
}

export function settingsPage(cfg, dockerOk, csrf, prefs, tab, dockerAccess = dockerAccessState()) {
  tab = ['general', 'docker', 'access', 'about'].includes(tab) ? tab : 'general';
  // Render machine values in monospace and prose values in the default face.
  const row = (k, v, note, mono) => `<div class="kv"><span>${escapeHtml(k)}${note ? `<small>${escapeHtml(note)}</small>` : ''}</span><b${mono ? ' class="mono"' : ''}>${escapeHtml(v)}</b></div>`;
  const kv = (k, v, note) => row(k, v, note, false);
  const kvm = (k, v, note) => row(k, v, note, true);
  // Unset addresses use plain text.
  const kvAddr = (k, v, note) => (v ? kvm(k, v, note) : kv(k, 'not set', note));
  const state = (k, on, onText, offText, note) =>
    `<div class="kv"><span>${escapeHtml(k)} ${on ? tag('ok', onText, 'check') : tag('line', offText, 'slash')}${note ? `<small>${escapeHtml(note)}</small>` : ''}</span></div>`;
  const card = (title, inner) => `<div class="setcard"><div class="sec-h">${title}</div>${inner}</div>`;
  const tabs = ['general', 'docker', 'access', 'about'].map((t) =>
    `<a class="logtab ${t === tab ? 'on' : ''}" href="/settings?tab=${t}">${t[0].toUpperCase()}${t.slice(1)}</a>`).join('');
  const sel = (name, value, opts) => `<select name="${name}" class="tbar-sel" style="height:30px">${opts.map(([v, l]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

  const general = `
    <form method="post" action="/settings/prefs">
    <div class="setgrid">
      ${card('Appearance', `
      <div class="kv"><span>Default theme<small>Used when a browser has no saved preference.</small></span><span style="flex:none">${sel('theme', prefs.theme, [['dark', 'Dark'], ['light', 'Light']])}</span></div>
      <div class="kv"><span>Clock</span><span style="flex:none">${sel('clock', prefs.clock, [['24h', '24-hour'], ['12h', '12-hour']])}</span></div>
      <div class="kv"><span>Dates</span><span style="flex:none">${sel('dateFormat', prefs.dateFormat, [['dd.mm.yyyy', 'DD.MM.YYYY'], ['yyyy-mm-dd', 'YYYY-MM-DD']])}</span></div>`)}
      ${card('Behaviour', `
      <div class="kv"><span>Confirm actions<small>Ask before stop and restart.</small></span><span style="flex:none">${sel('confirmActions', String(prefs.confirmActions), [['true', 'Ask first'], ['false', 'Just do it']])}</span></div>
      <div class="kv"><span>Logs default</span><span style="flex:none">${sel('logTail', prefs.logTail, [['200', 'Last 200'], ['500', 'Last 500'], ['1000', 'Last 1000'], ['2000', 'Last 2000']])}</span></div>
      <div class="kv"><span>Activity window</span><span style="flex:none">${sel('activityRange', prefs.activityRange, [['1', 'Last hour'], ['6', 'Last 6 hours'], ['24', 'Last day'], ['72', 'Last 3 days']])}</span></div>
      <div class="kv"><span></span><span style="flex:none"><input type="hidden" name="csrf" value="${escapeHtml(csrf || '')}"><button class="btn primary" type="submit">Save preferences</button></span></div>`)}
    </div>
    </form>`;

  // TCP Docker hosts do not use a local socket mount.
  const socketPath = String(cfg.dockerHost || '').replace(/^unix:\/\//, '');
  const socketNote = dockerOk
    ? ''
    : socketPath.startsWith('tcp://')
      ? `DOCKER_HOST points at ${socketPath}: start the proxy there. Nothing on this container is missing a mount.`
      : `Add - ${socketPath}:${socketPath}:ro under volumes: on the companion service in your compose file, then recreate it.`;

  // Only link to the access dialog when another mode is available.
  const modeNote = dockerModeRank(dockerAccess.ceiling) > 0 ? 'Change it from Docker access in the navigation.' : '';
  // Choose the Compose overlay that changes the installed access ceiling.
  const NEXT = {
    read: { overlay: 'docker-compose.management.yml', move: 'raise it to Management' },
    manage: { overlay: 'docker-compose.shell.yml', move: 'raise it to Management + shell' },
    shell: { overlay: '', move: 'drop it back to Read only' },
  };
  const next = NEXT[dockerAccess.ceiling] || NEXT.read;
  const recreate = `docker compose -f docker-compose.example.yml${next.overlay ? ` -f ${next.overlay}` : ''} up -d --build`;
  const keepList = next.overlay
    ? 'Keep every other -f file this install already starts with, in the same order.'
    : 'Drop only the access overlay and keep every other -f file this install starts with, in the same order.';
  const change = `To ${next.move}, recreate with ${recreate}. ${keepList}`;
  const ceilingNote = dockerAccess.explicitCeiling
    ? `DOCKER_ACCESS_MAX: ${dockerAccess.ceiling} on the companion service sets this, together with the socket-proxy switches in the matching overlay. ${change}`
    : dockerModeRank(dockerAccess.ceiling) > 0
      ? `DOCKER_ACCESS_MAX is not in this config: the legacy DOCKER_CONTROL: true is what sets this ceiling. ${change}`
      : `Neither DOCKER_ACCESS_MAX nor DOCKER_CONTROL is in this config, so Read only is the ceiling. ${change}`;

  const docker = `<div class="setgrid">
      ${card('Docker', `
      ${state('Socket reachable', dockerOk, 'Yes', 'No', socketNote)}
      ${kv('Active mode', dockerAccess.label, modeNote)}
      ${kv('Installed maximum', dockerAccess.ceilingLabel, ceilingNote)}
      ${state('Management actions', dockerAccess.canManage, 'On', 'Off', 'Lifecycle, deploy, update, remove and prune. Docker writes are host-root-equivalent.')}
      ${state('Container shell', dockerAccess.canShell, 'On', 'Off', "Shell, scheduled commands and container key reads use the selected container's configured user and privileges.")}
      ${kvm('Socket', cfg.dockerHost, 'DOCKER_HOST \u00b7 the shipped Compose profiles route this through a socket proxy.')}`)}
    </div>`;

  const access = `<div class="setgrid">
      ${card('Access', `
      ${kvm('Bind address', cfg.bind, cfg.bind === '127.0.0.1' ? 'Local only. Use 0.0.0.0 to reach it from the network.' : 'Reachable from your network.')}
      ${kvm('Port', String(cfg.port))}
      ${state('Behind a reverse proxy', cfg.trustProxy, 'Yes', 'No', 'Client IPs always come from the socket, never a forwarded header.')}
      ${state('Secure cookies', cfg.cookieSecure, 'On', 'Off', 'Switch on when you serve the panel over HTTPS.')}`)}
      ${card('Your stack', `
      ${kvAddr('Server address', cfg.qmHost, 'QM_HOST \u00b7 the address the phone uses at home')}
      ${kvAddr('Away preset', cfg.qmRemoteHost, 'QM_REMOTE_HOST \u00b7 starting point on the pairing page')}
      ${kvm('Config mount', cfg.stackDir, 'QM_STACK \u00b7 read-only mount the companion reads keys from')}`)}
    </div>`;

  const about = `<div class="setgrid">
      ${card('Security posture', `
      ${kv('API keys', 'encrypted at rest', 'AES-256-GCM. They are never sent to this browser.')}
      ${kv('Password', 'scrypt hashed', 'Login and two-factor attempts are rate-limited by direct network peer.')}
      ${kv('Writes', 'CSRF token + same-origin', 'A cross-site request cannot act on your behalf.')}
      ${kv('Setup', 'closed', 'The first-run page is disabled after an owner exists.')}`)}
      ${card('About', `
      ${kvm('Quartermaster Companion', VERSION ? `v${VERSION}` : 'Not available')}
      ${kv('Talks to', 'your services + image registries', 'No telemetry or hosted account. Update checks contact public registry and token endpoints.')}`)}
    </div>`;

  const body = { general, docker, access, about }[tab];
  return shell('settings', csrf || null, null, `
    ${board('settings', 'Settings', '', null)}
    <p class="sub">Preferences and the active Docker mode apply everywhere. The installed Docker maximum and network access still come from the container environment.</p>
    <div class="logtabs">${tabs}</div>
    ${body}`);
}
