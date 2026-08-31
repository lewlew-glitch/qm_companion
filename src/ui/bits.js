// Shared UI formatters, icons, badges, and table helpers.

import { escapeHtml } from '../http.js';
import { config } from '../config.js';
import { pairingCredentialState } from '../kinds.js';
import { hasIcon } from '../icons.js';
import { cachedInfo } from '../docker.js';
import { getPrefs } from '../store.js';

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export const I = {
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7.7 1.6 1.6 0 0 0-1 1.5V22a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 15H4.4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.2-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H12a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V12a2 2 0 1 1 0 4Z"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  arrowIn: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>',
  arrowR: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  img: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 20"/></svg>',
  disk: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  net: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v3M6 16v-2h12v2"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  stack: '<svg class="fill-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="4" width="8" height="7" rx="1.5"/><rect x="8" y="13" width="8" height="7" rx="1.5"/></svg>',
  service: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h7M11 16.5h7"/></svg>',
  template: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5M9 12h6M9 16h6"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="m4 17 6-5-6-5"/><path d="M12 19h8"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="m7 4 13 8-13 8Z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M10 5v14M14 5v14"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>',
  checkO: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 3 5 6v5c0 4.6 2.9 8.1 7 10 4.1-1.9 7-5.4 7-10V6Z"/><path d="m9 12 2 2 4-4"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
  mem: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M6 19v-3M10 19v-3M14 19v-3M18 19v-3"/><rect x="3" y="5" width="18" height="11" rx="2"/><path d="M7 9v3M12 9v3M17 9v3"/></svg>',
  temp: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0Z"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M12 20h.01"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M13 2 3 14h8l-1 8 10-12h-8Z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  slash: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 2v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
};

export function fmtAge(sec) {
  if (!sec) return 'Not available';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Browser-side escaping for data inserted into text or attributes by inline scripts.
export const ESC_FN = `function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}`;

// Trap focus in the visible overlay, restore it on close, and yield to nested modals.
export const FOCUS_FN = `function qmFocusTrap(root) {
  var back = null, listening = false;
  var query = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function usable(el) {
    if (!el || el.getAttribute('tabindex') === '-1' || el.closest('[hidden],[aria-hidden="true"]')) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }
  function items() { return Array.from(root.querySelectorAll(query)).filter(usable); }
  function anotherModalOwnsFocus() {
    return Array.from(document.querySelectorAll('[aria-modal="true"]')).some(function (modal) {
      return !root.contains(modal) && usable(modal);
    });
  }
  function onKey(event) {
    if (event.key !== 'Tab' || anotherModalOwnsFocus()) return;
    var list = items();
    if (!list.length) { event.preventDefault(); root.focus(); return; }
    var first = list[0], last = list[list.length - 1], current = document.activeElement;
    if (!root.contains(current)) { event.preventDefault(); first.focus(); return; }
    if (event.shiftKey && current === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
  }
  function stop(restore) {
    if (listening) document.removeEventListener('keydown', onKey, true);
    listening = false;
    var target = back; back = null;
    if (restore !== false && target && target.isConnected && typeof target.focus === 'function') {
      try { target.focus(); } catch (error) {}
    }
  }
  return {
    open: function (opener, preferred) {
      stop(false); back = opener || document.activeElement;
      document.addEventListener('keydown', onKey, true); listening = true;
      var list = items(), target = preferred && list.indexOf(preferred) >= 0 ? preferred : list[0];
      if (target) target.focus(); else { root.setAttribute('tabindex', '-1'); root.focus(); }
    },
    close: stop,
  };
}`;

// Shared Compose findings panel. Build rows with DOM methods so input remains text.
export function lintPanel(id) {
  return `<div class="lintpanel" id="${escapeHtml(id)}" hidden></div>`;
}

// Validate editor text, render findings, and keep errors blocking until a successful validation.
export const LINT_FN = `function qmLintWire(o) {
  var timer = null, errs = 0, seq = 0, offline = false;
  var note = document.createElement('div'); note.className = 'lint-note'; note.hidden = true;
  var list = document.createElement('div'); list.className = 'lint-list';
  o.panel.appendChild(note); o.panel.appendChild(list);
  function jump(line) {
    var rows = o.yaml.value.split('\\n');
    var start = 0;
    for (var i = 0; i < line - 1 && i < rows.length; i++) start += rows[i].length + 1;
    var end = start + (rows[line - 1] || '').length;
    o.yaml.focus();
    try { o.yaml.setSelectionRange(start, end); } catch (e) {}
    var lh = parseFloat(getComputedStyle(o.yaml).lineHeight) || 17;
    o.yaml.scrollTop = Math.max(0, (line - 3) * lh);
  }
  function sync() {
    (o.buttons || []).forEach(function (b) { if (b) b.disabled = errs > 0; });
  }
  function tell() {
    var blocked = errs ? errs + (errs === 1 ? ' error blocks deployment' : ' errors block deployment') : '';
    if (!offline) { note.textContent = blocked; note.hidden = errs === 0; return; }
    note.textContent = (blocked ? blocked + '. ' : '')
      + 'The linter could not be reached, so this is the last answer it gave. Edit the file to check again, or reload the page.';
    note.hidden = false;
  }
  function paint(findings) {
    list.textContent = '';
    errs = 0;
    offline = false;
    findings.forEach(function (f) {
      if (f.severity === 'error') errs++;
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'lint-row';
      var dot = document.createElement('i'); dot.className = 'ldot ' + f.severity;
      var id = document.createElement('code'); id.className = 'lint-id'; id.textContent = f.id;
      var msg = document.createElement('span'); msg.className = 'lint-msg'; msg.textContent = f.message;
      row.appendChild(dot); row.appendChild(id); row.appendChild(msg);
      row.addEventListener('click', function () { jump(f.line || 1); });
      list.appendChild(row);
    });
    o.panel.hidden = findings.length === 0;
    tell();
    sync();
  }
  function refresh() {
    var mine = ++seq;
    fetch('/api/compose/validate', {
      method: 'POST',
      headers: { 'x-csrf-token': document.querySelector('meta[name=csrf]').content, 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: o.yaml.value, env: o.env ? o.env() : {}, stack: o.stack ? o.stack() : '' }),
    }).then(function (r) { if (!r.ok) throw new Error('validate'); return r.json(); })
      .then(function (d) { if (mine === seq) paint(d.findings || []); })
      .catch(function () { if (mine === seq) { offline = true; o.panel.hidden = false; tell(); sync(); } });
  }
  o.yaml.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(refresh, 500); });
  return {
    refresh: refresh,
    sync: sync,
    reset: function () { seq++; paint([]); },
  };
}`;

// Search control and live count for rows with data-find attributes.
export function searchTools(placeholder) {
  const input = `<div class="tbar-search">${I.search}<input id="tsearch" type="text" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false"></div>`;
  const script = `<div class="empty hidden" id="tempty">Nothing matches that filter.</div>
  <script>(function(){var q=document.getElementById('tsearch'),c=document.getElementById('tcount'),e=document.getElementById('tempty');
    q.addEventListener('input',function(){var t=q.value.toLowerCase(),n=0;
      document.querySelectorAll('[data-find]').forEach(function(r){var ok=!t||r.dataset.find.indexOf(t)>=0;r.style.display=ok?'':'none';if(ok)n++;});
      c.textContent=n;e.classList.toggle('hidden',n>0);});})();</script>`;
  return { input, script };
}

// Map stack names deterministically to six non-interactive tint classes.
export const STACK_TINTS = 6;
export function stackClass(name) {
  const s = String(name || '');
  if (!s) return '';
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) + s.charCodeAt(i)) >>> 0;
  return `sh-${h % STACK_TINTS}`;
}

// Stable fallback colours by service kind.
export const BRANDS = {
  radarr: '#E5A00D', sonarr: '#2193B5', prowlarr: '#E66000', lidarr: '#159552', bazarr: '#BE6A38',
  jellyfin: '#8E44AD', emby: '#43A047', plex: '#C58B0B',
  jellyseerr: '#6D5ED1', musicseerr: '#6D5ED1', wizarr: '#6D5ED1',
  sabnzbd: '#B8940E', nzbget: '#3F9427', nzbhydra2: '#4C5ED1', jackett: '#C12F2F',
  qbittorrent: '#2A6DBF', deluge: '#3B55CC', transmission: '#C0403C', qui: '#2A6DBF',
  tautulli: '#B8920E', jellystat: '#3B6BD6', streamystats: '#3B6BD6', tracearr: '#3B6BD6',
  portainer: '#13A8D6', dozzle: '#3E9BC0', dockhand: '#4258D6', komodo: '#7A55E0', beszel: '#C06046',
  glances: '#2B9494', scrutiny: '#3B6BD6', gluetun: '#3E9BC0', dispatcharr: '#3B6BD6',
  pihole: '#D12B2E', adguard: '#3E9B4C', technitium: '#2E7FC4', nextdns: '#2270BE', controld: '#2270BE',
  homeassistant: '#0BA4D8', unifi: '#2458C4', proxmox: '#C7501F',
  truenas: '#1E85C4', synology: '#2270BE', unraid: '#D93E12', ugreen: '#4258D6', coolify: '#6D5ED1',
  komga: '#348A5C', kavita: '#3B6BD6', audiobookshelf: '#D07E22', readmeabook: '#3E9E7E', bookorbit: '#3B6BD6',
  shelfmark: '#3B6BD6', shelfarr: '#3B6BD6', immich: '#4348C9', tdarr: '#7A55E0', maintainerr: '#C06046', arcane: '#7A55E0',
};
export function brand(kind) { return BRANDS[kind] || 'var(--faint)'; }

export function badge(kind, text, fallback = 'service') {
  if (kind && hasIcon(kind)) {
    return `<div class="logo img"><img src="/assets/icons/${encodeURIComponent(kind)}.svg" alt="" loading="lazy"></div>`;
  }
  const name = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!kind && ['qm-companion', 'qm-socket-proxy'].includes(name)) {
    return '<div class="logo img product"><img src="/assets/logo.png" alt="" loading="lazy"></div>';
  }
  const c = brand(kind);
  const variant = fallback === 'template' ? ' template' : '';
  const colour = fallback === 'template' ? '' : ` style="--logo-bg:${c}"`;
  return `<div class="logo generic${variant}"${colour} aria-hidden="true">${fallback === 'template' ? I.template : I.service}</div>`;
}

// Semantic state badge.
export function tag(tone, text, icon) {
  return `<span class="badge ${tone}">${icon ? I[icon] : ''}${escapeHtml(text)}</span>`;
}

// State cell with a coloured dot and label.
export function state(tone, text) {
  return `<span class="state ${tone}"><i></i>${escapeHtml(text)}</span>`;
}

// Escape JSON embedded in inline scripts so data cannot close the script element.
export function jsafe(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

// Local app icon used for the tab and brand marks.
export const FAVICON = '/assets/logo.png';
export const MARK = '<img src="/assets/logo.png" alt="Quartermaster">';

export function credentialTag(d, context = 'dashboard') {
  const status = d.credentialState || pairingCredentialState(d.kind, d.apiKey, d.credentialConflict);
  const wording = {
    dashboard: {
      included: 'Included in scan',
      'not-required': 'No key required',
      'sign-in': 'Sign in on phone',
      'key-and-secret': 'Needs setup',
      'missing-key': 'Needs setup',
      conflict: 'Credential conflict',
    },
    configure: {
      included: 'Included automatically',
      'not-required': 'No key needed',
      'sign-in': 'Sign in after pairing',
      'key-and-secret': 'Key and secret needed',
      'missing-key': 'Needs setup',
      conflict: 'Check key sources',
    },
    ready: {
      included: 'Included',
      'not-required': 'No key needed',
      'sign-in': 'Sign in later',
      'key-and-secret': 'Not included',
      'missing-key': 'Not included',
      conflict: 'Not transferred',
    },
  }[context];
  if (status === 'included') return tag('ok', wording[status], 'check');
  if (status === 'not-required') return tag('info', wording[status], 'check');
  if (status === 'conflict') return tag('bad', wording[status], 'alert');
  if (status === 'missing-key' || status === 'key-and-secret') return tag('warn', wording[status], 'alert');
  return tag('line', wording[status] || 'Needs setup');
}

export const EVENT_ICON = {
  start: ['play', 'ec run'], create: ['plus', 'ec run'], restart: ['rotate', 'ec pause'],
  stop: ['stop', 'ec pause'], pause: ['pause', 'ec pause'], unpause: ['play', 'ec run'],
  die: ['zap', 'ec bad'], kill: ['zap', 'ec pause'], destroy: ['trash', 'ec'], update: ['pencil', 'ec pause'],
};

// Container lifecycle badge.
const lifeGlyph = (tone, ico, word) => `<span class="state glyph ${tone}">${I[ico]}${word}</span>`;
export function cState(c) {
  if (c.state === 'running') return lifeGlyph('ok', 'play', 'Running');
  if (c.state === 'paused') return lifeGlyph('warn', 'pause', 'Paused');
  if (c.state === 'restarting') return lifeGlyph('warn', 'rotate', 'Restarting');
  if (c.state === 'created') return lifeGlyph('info', 'plus', 'Created');
  if (c.state === 'exited') return lifeGlyph('bad', 'stop', 'Exited');
  if (c.state === 'dead') return lifeGlyph('bad', 'zap', 'Dead');
  return state('off', c.state || 'unknown');
}

// Render a dash when no health check exists; do not mark it healthy.
export const HEALTH_TONE = { healthy: 'ok', unhealthy: 'bad', starting: 'warn' };
export function healthDot(h, lifecycle) {
  if (!h) {
    const label = lifecycle === 'running' ? 'No health check' : 'Health not reported';
    return `<span class="faint nohealth" title="${label}">-</span>`;
  }
  const word = h === 'starting' ? 'Check starting' : h === 'healthy' ? 'Healthy' : h === 'unhealthy' ? 'Unhealthy' : h;
  return `<span class="healthline ${HEALTH_TONE[h] || ''}"><i></i>${escapeHtml(word)}</span>`;
}

// Format epoch milliseconds or Docker date strings with saved display preferences.
export const fmtWhen = (t) => {
  if (!t) return 'Not available';
  const p = getPrefs();
  const d = new Date(t);
  if (isNaN(d.getTime())) return 'Not available';
  const pad = (n) => String(n).padStart(2, '0');
  const date = p.dateFormat === 'yyyy-mm-dd'
    ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    : pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
  return date + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: p.clock === '12h' });
};

export function metaOf() {
  return cachedInfo() || config.qmHost ? { host: config.qmHost || 'localhost', count: null } : null;
}
