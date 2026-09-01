// Shared document frame, navigation, status strip and Docker empty states.

import { escapeHtml } from '../http.js';
import { config } from '../config.js';
import { mfaEnabled } from '../auth.js';
import { cachedInfo, cachedCounts } from '../docker.js';
import { dockerAccessState, dockerModeRank } from '../docker-access.js';
import { knownUpdateCount } from '../updates.js';
import { getPrefs } from '../store.js';
import { fmtBytes, I, jsafe, ESC_FN, FOCUS_FN, FAVICON, MARK, metaOf } from './bits.js';
import { themeBoot, appRuntime } from './runtime.js';

export function doc(title, csrf, body) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Companion</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="/assets/app.css">
${themeBoot()}
${csrf ? `<meta name="csrf" content="${escapeHtml(csrf)}">` : ''}
</head><body>${body}</body></html>`;
}

const TITLES = { dash: 'Dashboard', pair: 'Set up the app', devices: 'Devices', containers: 'Containers', console: 'Console', stacks: 'Stacks', images: 'Images', volumes: 'Volumes', networks: 'Networks', activity: 'Activity', cron: 'Cron jobs', catalogue: 'Marketplace', settings: 'Settings', profile: 'Profile' };
const PAGE_ICONS = { dash: 'grid', pair: 'link', devices: 'wifi', containers: 'box', console: 'term', stacks: 'stack', images: 'img', volumes: 'disk', networks: 'net', activity: 'pulse', cron: 'clock', catalogue: 'grid', settings: 'gear', profile: 'user' };

// Container recreation instructions must preserve the installation's ordered Compose file list.
const SAME_F_LIST = 'Repeat every <code class="mono">-f</code> file this install already starts with, in the same order.';
const KEEP_F_LIST = 'Keep every other <code class="mono">-f</code> file this install already starts with, in the same order.';

// Classify the configured Docker transport.
function dockerTransport() {
  const host = String(config.dockerHost || '');
  if (/^tcp:\/\//i.test(host)) {
    const authority = host.slice(6).split('/')[0];
    const name = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
    // Only a bare internal hostname can be used as a Compose service name.
    const service = /^[a-z][a-z0-9_-]*$/i.test(name) && name.toLowerCase() !== 'localhost' ? name : '';
    return { kind: 'proxy', host, service };
  }
  if (host.startsWith('unix://') || host.startsWith('/')) {
    return { kind: 'socket', host, path: host.replace(/^unix:\/\//, '') };
  }
  return { kind: 'unknown', host };
}

function code(text) {
  return `<code class="mono">${escapeHtml(text)}</code>`;
}

function fmtUp(sec) {
  if (sec >= 86400) return `${Math.floor(sec / 86400)}d`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h`;
  return `${Math.max(1, Math.floor(sec / 60))}m`;
}

// Host and Docker facts render once; only the clock updates client-side.
function factStrip(meta, access) {
  const sys = cachedInfo();
  const host = (sys && sys.name) || (meta && meta.host) || config.qmHost || 'localhost';
  const facts = [];
  if (sys) {
    if (sys.os) facts.push(escapeHtml(sys.os + (sys.arch ? ` ${sys.arch}` : '')));
    if (sys.version) facts.push(`docker ${escapeHtml(sys.version)}`);
    facts.push(String(config.dockerHost).startsWith('tcp:') ? 'proxy socket' : 'direct socket');
  }
  facts.push(access.label.toLowerCase());
  if (sys && sys.ncpu) facts.push(`${sys.ncpu} cores`);
  if (sys && sys.memTotal) facts.push(escapeHtml(fmtBytes(sys.memTotal)));
  if (sys && sys.uptimeSec) facts.push(`up ${fmtUp(sys.uptimeSec)}`);
  return `<div class="factstrip"><span class="fs-host">${escapeHtml(host)}</span><span class="fs-more">${facts.map((f) => ` \u00b7 ${f}`).join('')}</span><span class="fs-sep"> \u00b7 </span><b id="clk"></b><span class="grow"></span></div>`;
}

const MODE_INSTALL = {
  manage: { file: 'docker-compose.management.yml', proxy: () => code('POST: 1') },
  shell: { file: 'docker-compose.shell.yml', proxy: () => `${code('POST: 1')} and ${code('EXEC: 1')}` },
};

function dockerModeReason(mode) {
  const install = MODE_INSTALL[mode];
  if (!install) return 'This mode is above the installed maximum.';
  return `Not installed. ${code(install.file)} sets ${code(`DOCKER_ACCESS_MAX: ${mode}`)} on Companion and ${install.proxy()} on the socket proxy. Recreate both with ${code(`docker compose -f docker-compose.example.yml -f ${install.file} up -d --build`)}. ${KEEP_F_LIST}`;
}

function dockerModeOption(access, mode, title, description) {
  const available = dockerModeRank(mode) <= dockerModeRank(access.ceiling);
  const reason = available ? '' : dockerModeReason(mode);
  return `<label class="mode-choice${available ? '' : ' unavailable'}">
    <input type="radio" name="docker-mode" value="${mode}" ${access.mode === mode ? 'checked' : ''} ${available ? '' : 'disabled'}>
    <span class="mode-radio"></span><span class="mode-copy"><b>${title}</b><small>${description}</small>${reason ? `<em>${reason}</em>` : ''}</span>
  </label>`;
}

// `meta` remains in the public signature for existing call sites.
export function board(active, title, extra) {
  const icon = I[PAGE_ICONS[active]] || I.grid;
  return `<div class="board"><span class="board-icon">${icon}</span><h1>${title}</h1>${extra || ''}<span class="grow"></span></div>`;
}

export function shell(active, csrf, meta, body) {
  const nav = (href, ico, label, key, fig) =>
    `<a class="nav ${active === key ? 'on' : ''}" href="${href}">${I[ico]}${label}${fig || ''}</a>`;
  const group = (label) => `<div class="nav-group">${label}</div>`;
  const access = dockerAccessState();
  const hasMfa = mfaEnabled();
  const proxyBacked = String(config.dockerHost).startsWith('tcp:');
  const ceilingNote = !proxyBacked
    ? 'This install uses a direct Docker socket. Docker has no daemon-level read-only boundary here, so Companion alone enforces the installed maximum and current mode.'
    : access.ceiling === 'shell'
      ? 'The proxy remains write-capable underneath lower app modes. Lower modes lock Companion actions, but do not sandbox a compromised Companion process.'
      : access.ceiling === 'manage'
        ? 'The socket proxy permits Docker writes but blocks container exec.'
        : 'The socket proxy should keep POST and EXEC disabled for this profile.';

  // Show one cached count: unhealthy containers take precedence over available updates.
  const counts = cachedCounts();
  const updates = knownUpdateCount();
  // The containers page updates the available-updates figure in place.
  const fig = counts && counts.unhealthy
    ? `<span class="nav-fig bad" id="navfig" data-kind="bad"><i></i>${counts.unhealthy}</span>`
    : `<span class="nav-fig warn${updates ? '' : ' hidden'}" id="navfig" data-kind="warn"><i></i>${updates || 0}</span>`;

  return doc(TITLES[active] || 'Companion', csrf, `
<div class="app">
  <aside class="side">
    <div class="top-brand"><span class="mark">${MARK}</span><span class="wordmark"><b>Quartermaster</b><small>Companion</small></span></div>
    <button class="mobile-menu" id="mobile-menu" type="button" aria-expanded="false" aria-controls="side-menu"><span>${escapeHtml(TITLES[active] || 'Menu')}</span>${I.chev}</button>
    <button class="side-scrim" id="side-scrim" type="button" tabindex="-1" aria-label="Close navigation"></button>
    <div class="side-menu" id="side-menu" role="navigation" aria-label="Primary navigation">
      ${nav('/', 'grid', 'Dashboard', 'dash')}
      <button class="nav mode-nav" id="docker-mode-open" type="button" aria-haspopup="dialog" aria-controls="docker-mode-dialog" aria-expanded="false" aria-label="Docker access: ${escapeHtml(access.label)}">${I.shield}<span>Docker access</span><span class="mode-nav-value">${escapeHtml(access.shortLabel)}</span></button>
      ${group('Fleet')}
      ${nav('/containers', 'box', 'Containers', 'containers', fig)}
      ${nav('/stacks', 'stack', 'Stacks', 'stacks')}
      ${nav('/images', 'img', 'Images', 'images')}
      ${nav('/volumes', 'disk', 'Volumes', 'volumes')}
      ${nav('/networks', 'net', 'Networks', 'networks')}
      ${group('Observe')}
      ${nav('/console', 'list', 'Console', 'console')}
      ${nav('/activity', 'pulse', 'Activity', 'activity')}
      ${group('Extend')}
      ${nav('/catalogue', 'grid', 'Marketplace', 'catalogue')}
      ${nav('/cron', 'clock', 'Cron jobs', 'cron')}
      ${nav('/pair', 'link', 'Set up', 'pair')}
      ${nav('/devices', 'wifi', 'Devices', 'devices')}
      ${nav('/settings', 'gear', 'Settings', 'settings')}
      <div class="spacer"></div>
      <div class="foot">
        <a class="iconbtn" href="/profile" title="Profile" aria-label="Profile">${I.user}</a>
        <button class="signout" id="logout">${I.out}Sign out</button>
        <button class="iconbtn" id="themebtn" title="Theme" aria-label="Toggle theme">${I.moon}</button>
      </div>
    </div>
  </aside>
  <div class="main">
    ${factStrip(meta, access)}
    <div class="scroll">${body}</div>
  </div>
</div>
<div class="overlay" id="docker-mode-dialog" hidden>
  <form class="modal sm mode-modal" id="docker-mode-form" role="dialog" aria-modal="true" aria-labelledby="docker-mode-title" aria-describedby="docker-mode-intro">
    <div class="modal-h"><b id="docker-mode-title">Docker access</b><button class="iconbtn" id="docker-mode-x" type="button" aria-label="Close">${I.x}</button></div>
    <div class="modal-b">
      <p class="confirm-what" id="docker-mode-intro">This changes Docker access for this Companion, including every signed-in browser and scheduled job.</p>
      <fieldset class="mode-choices">
        <legend class="sr-only">Docker access mode</legend>
        ${dockerModeOption(access, 'read', 'Read only', 'View Docker status and logs. No Docker changes or container exec.')}
        ${dockerModeOption(access, 'manage', 'Management', 'Adds lifecycle, updates, deploy, remove and prune. Docker write access is host-root-equivalent.')}
        ${dockerModeOption(access, 'shell', 'Management + shell', "Adds the in-container shell and container key reads. Commands use the selected container's configured user and privileges.")}
      </fieldset>
      <div class="mode-ceiling"><b>Installed maximum: ${escapeHtml(access.ceilingLabel)}</b><span>${ceilingNote}</span></div>
      <div class="mode-stepup" id="docker-mode-stepup" hidden>
        <p>Raising access needs the owner credentials again.</p>
        <label for="docker-mode-password">Owner password</label>
        <input class="in" id="docker-mode-password" type="password" maxlength="256" autocomplete="current-password">
        ${hasMfa ? '<label for="docker-mode-code">Authenticator or recovery code</label><input class="in mono" id="docker-mode-code" type="text" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" maxlength="32">' : ''}
      </div>
      <p class="mode-impact" id="docker-mode-impact"></p>
      <div class="mode-status" id="docker-mode-status" role="status" aria-live="polite"></div>
    </div>
    <div class="modal-f"><button class="btn" id="docker-mode-cancel" type="button">Cancel</button><button class="btn primary" id="docker-mode-save" type="submit">Save mode</button></div>
  </form>
</div>
<div class="overlay" id="qmjump" hidden>
  <div class="modal sm jump" role="dialog" aria-modal="true" aria-label="Jump to">
    <div class="jump-in">${I.search}<input id="qmjump-q" type="text" placeholder="Jump to a container, stack or page…" autocomplete="off" spellcheck="false" aria-label="Jump to"></div>
    <div class="jump-list" id="qmjump-list"></div>
    <div class="jump-foot">Arrows to move · Enter to open · Esc to close</div>
  </div>
</div>
<script>
  (function () {
    ${FOCUS_FN}
    var trigger = document.getElementById('docker-mode-open');
    var overlay = document.getElementById('docker-mode-dialog');
    var form = document.getElementById('docker-mode-form');
    var closer = document.getElementById('docker-mode-x');
    var cancel = document.getElementById('docker-mode-cancel');
    var save = document.getElementById('docker-mode-save');
    var stepup = document.getElementById('docker-mode-stepup');
    var password = document.getElementById('docker-mode-password');
    var code = document.getElementById('docker-mode-code');
    var impact = document.getElementById('docker-mode-impact');
    var status = document.getElementById('docker-mode-status');
    var current = ${jsafe(access.mode)};
    var ranks = { read: 0, manage: 1, shell: 2 };
    var labels = { read: 'Read only', manage: 'Management', shell: 'Management + shell' };
    var modeTrap = qmFocusTrap(overlay);
    function selected() { var row = form.querySelector('input[name="docker-mode"]:checked'); return row ? row.value : current; }
    function paintMode() {
      var next = selected();
      var raising = ranks[next] > ranks[current];
      stepup.hidden = !raising;
      password.required = raising;
      if (code) code.required = raising;
      save.disabled = next === current;
      save.textContent = next === current ? 'Current mode' : ranks[next] < ranks[current] ? 'Lower to ' + labels[next] : 'Enable ' + labels[next];
      impact.textContent = ranks[next] < ranks[current]
        ? 'Lowering access applies to new actions immediately and turns off scheduled jobs that need more access. Work already running may finish.'
        : raising ? 'The new mode applies globally after your credentials are checked.' : '';
      status.textContent = '';
    }
    function openMode() {
      overlay.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      paintMode();
      modeTrap.open(trigger, form.querySelector('input[name="docker-mode"]:checked'));
    }
    function closeMode() {
      if (overlay.hidden) return;
      overlay.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      password.value = '';
      if (code) code.value = '';
      status.textContent = '';
      modeTrap.close();
    }
    trigger.addEventListener('click', openMode);
    closer.addEventListener('click', closeMode);
    cancel.addEventListener('click', closeMode);
    overlay.addEventListener('click', function (event) { if (event.target === overlay) closeMode(); });
    form.addEventListener('change', function (event) { if (event.target.name === 'docker-mode') paintMode(); });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var next = selected();
      if (next === current) return;
      var csrf = document.querySelector('meta[name=csrf]');
      save.disabled = true;
      status.textContent = 'Applying ' + labels[next] + '...';
      fetch('/settings/docker-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf ? csrf.content : '' },
        body: JSON.stringify({ mode: next, password: password.value, code: code ? code.value : '' })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) { return { ok: response.ok, data: data }; });
      }).then(function (result) {
        if (!result.ok) throw new Error(result.data.error || 'Docker access could not be changed.');
        location.reload();
      }).catch(function (error) {
        status.textContent = error.message || 'Docker access could not be changed.';
        password.value = '';
        if (code) code.value = '';
        save.disabled = false;
        if (stepup.hidden) save.focus();
        else password.focus();
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !overlay.hidden) { event.preventDefault(); closeMode(); }
    });
  })();
  (function () {
    ${FOCUS_FN}
    var side = document.querySelector('.side');
    var button = document.getElementById('mobile-menu');
    var scrim = document.getElementById('side-scrim');
    if (!side || !button || !scrim) return;
    var navTrap = qmFocusTrap(side);
    function setOpen(open, restore) {
      var wasOpen = side.classList.contains('menu-open');
      var opener = document.activeElement;
      side.classList.toggle('menu-open', open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !wasOpen) navTrap.open(opener, side.querySelector('.side-menu .nav.on') || side.querySelector('.side-menu .nav'));
      else if (!open && wasOpen) navTrap.close(restore);
    }
    button.addEventListener('click', function () { setOpen(!side.classList.contains('menu-open')); });
    scrim.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && side.classList.contains('menu-open')) { event.preventDefault(); setOpen(false); }
    });
    window.addEventListener('resize', function () { if (window.innerWidth > 860) setOpen(false, false); });
  })();
  document.getElementById('logout').addEventListener('click', async () => {
    const csrf = document.querySelector('meta[name=csrf]');
    await fetch('/logout', { method: 'POST', headers: csrf ? { 'x-csrf-token': csrf.content } : {} });
    location.href = '/login';
  });
  (function () {
    var el = document.getElementById('clk');
    if (!el) return;
    function tick() { el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: ${getPrefs().clock === '12h'} }); }
    tick(); setInterval(tick, 1000);
  })();
  (function () {
    var sun = ${jsafe(I.sun)}, moon = ${jsafe(I.moon)};
    var b = document.getElementById('themebtn'), root = document.documentElement;
    function paint() { b.innerHTML = root.classList.contains('light') ? moon : sun; }
    b.addEventListener('click', function () {
      root.classList.toggle('light');
      try { localStorage.setItem('qm_theme', root.classList.contains('light') ? 'light' : 'dark'); } catch (e) {}
      paint();
    });
    paint();
  })();
  // Cmd-K or / opens the lazily populated navigation switcher outside text fields.
  (function () {
    ${ESC_FN}
    ${FOCUS_FN}
    var ov = document.getElementById('qmjump'), q = document.getElementById('qmjump-q'), list = document.getElementById('qmjump-list');
    var data = null, rows = [], active = 0, loading = false;
    var jumpTrap = qmFocusTrap(ov);
    function dotFor(s) { return s === 'running' ? 'ok' : s === 'paused' || s === 'restarting' ? 'warn' : 'off'; }
    function build() {
      rows = [];
      if (!data) return;
      (data.containers || []).forEach(function (c) { rows.push({ label: c.name, kind: 'container', dot: dotFor(c.state), href: '/containers?sel=' + encodeURIComponent(c.id) }); });
      (data.stacks || []).forEach(function (s) { rows.push({ label: s, kind: 'stack', dot: 'none', href: '/stacks#' + encodeURIComponent(s) }); });
      (data.pages || []).forEach(function (p) { rows.push({ label: p.label, kind: 'page', dot: 'none', href: p.href }); });
    }
    function paint() {
      var term = (q.value || '').toLowerCase();
      var hits = rows.filter(function (r) { return !term || String(r.label).toLowerCase().indexOf(term) >= 0; }).slice(0, 12);
      if (active >= hits.length) active = Math.max(0, hits.length - 1);
      list.innerHTML = hits.length ? hits.map(function (r, i) {
        return '<div class="jump-row' + (i === active ? ' on' : '') + '" data-href="' + esc(r.href) + '"><span class="jdot ' + r.dot + '"></span><span class="jname">' + esc(r.label) + '</span><span class="badge line">' + esc(r.kind) + '</span></div>';
      }).join('') : '<div class="jump-note">' + (loading ? 'Fetching the list' : data ? 'Nothing matches.' : 'The list could not be fetched.') + '</div>';
    }
    function openJump() {
      var opener = document.activeElement;
      ov.hidden = false;
      q.value = '';
      active = 0;
      if (!data && !loading) {
        loading = true;
        fetch('/api/jump').then(function (r) { if (!r.ok) throw new Error('jump'); return r.json(); }).then(function (d) {
          data = d; loading = false; build(); paint();
        }).catch(function () { loading = false; data = null; paint(); });
      }
      paint();
      jumpTrap.open(opener, q);
    }
    function closeJump() { if (ov.hidden) return; ov.hidden = true; jumpTrap.close(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) closeJump(); });
    list.addEventListener('click', function (e) { var row = e.target.closest('.jump-row'); if (row) location.href = row.dataset.href; });
    q.addEventListener('input', function () { active = 0; paint(); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); active += 1; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); var row = list.querySelector('.jump-row.on'); if (row) location.href = row.dataset.href; }
      else if (e.key === 'Escape') { e.preventDefault(); closeJump(); }
    });
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var typing = t && ((t.matches && t.matches('input, textarea, select')) || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k' && (!typing || !ov.hidden)) {
        e.preventDefault();
        if (ov.hidden) openJump(); else closeJump();
        return;
      }
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && ov.hidden) { e.preventDefault(); openJump(); }
      else if (e.key === 'Escape' && !ov.hidden) closeJump();
    });
  })();
</script>
${appRuntime()}`);
}

function socketEmpty(active, title, csrf, meta, lines) {
  return shell(active, csrf || null, meta, `
    ${board(active, title, '', meta)}
    <div class="empty">${lines.filter(Boolean).join('<br>')}</div>`);
}

export function proxyBlocked(active, icon, title, flag, csrf) {
  const transport = dockerTransport();
  const set = `Set ${code(`${flag}: 1`)}`;
  const lines = transport.kind === 'proxy'
    ? [
      'The socket proxy is blocking this.',
      transport.service
        ? `${set} in the environment of the ${code(transport.service)} service in your compose file, then ${code(`docker compose -f docker-compose.example.yml up -d --build ${transport.service}`)}.`
        : `${set} on the Docker proxy answering at ${code(transport.host)}, then recreate that container.`,
      transport.service ? SAME_F_LIST : '',
    ]
    : transport.kind === 'socket'
      ? [
        `The Docker API on ${code(transport.path)} refused this with a 403.`,
        `A direct Docker socket normally does not return this 403. Check for a proxy on that path, ${set} in its compose service, then recreate the container.`,
        SAME_F_LIST,
      ]
      : [
        'The socket proxy is blocking this.',
        `${set} on the socket proxy in your compose file, then recreate it with the same ${code('docker compose -f ...')} command this install starts with.`,
      ];
  return socketEmpty(active, title, csrf, metaOf(), lines);
}

export function noSocket(active, icon, title, csrf) {
  const transport = dockerTransport();
  const lines = transport.kind === 'proxy'
    ? [
      `Nothing is answering at ${code(transport.host)}.`,
      `${code('DOCKER_HOST')} points there, so check that the configured socket proxy is running and reachable from Companion.`,
      'Restart the socket proxy from Unraid or its Compose project.',
    ]
    : transport.kind === 'socket'
      ? [
        `No Docker socket at ${code(transport.path)}.`,
        `Mount ${code(`${transport.path}:${transport.path}:ro`)} on Companion, then recreate the container.`,
      ]
      : [
        'No Docker socket reachable from here.',
        'Configure a reachable socket proxy or mount the Docker socket read only on Companion, then recreate Companion.',
      ];
  return socketEmpty(active, title, csrf, null, lines);
}
