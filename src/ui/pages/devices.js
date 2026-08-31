import { escapeHtml } from '../../http.js';
import { tag, fmtWhen } from '../bits.js';
import { board, shell } from '../chrome.js';

const SCOPE_LABEL = { 'summary.read': 'Overview', 'containers.read': 'Containers', 'stacks.read': 'Stacks', 'updates.read': 'Updates', 'events.read': 'Activity' };

// Terminal pairing states permit no further transition.
const TERMINAL_STATES = ['expired', 'rejected', 'cancelled'];

// Known completed actions use success tone; other messages default to refusal tone.
const FLASH_DONE = [
  'Approved. The phone is finishing the pairing.',
  'Pairing removed.',
  'Device revoked. Its next request is refused.',
  'Device forgotten.',
  'Renamed.',
];

// Preserve a server-rendered fallback and expose timestamps for browser-local formatting.
function when(t) {
  const ts = t ? new Date(t).getTime() : NaN;
  if (!Number.isFinite(ts)) return escapeHtml(fmtWhen(t));
  return `<span data-when="${ts}">${escapeHtml(fmtWhen(t))}</span>`;
}

function flashLine(flash) {
  if (!flash) return '';
  const colour = FLASH_DONE.includes(flash) ? 'var(--ok)' : 'var(--bad)';
  return `<p class="sub" role="status" style="color:${colour}">${escapeHtml(flash)}</p>`;
}

function csrfField(csrf) {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function stateTag(state) {
  if (state === 'awaiting_owner_approval') return tag('warn', 'Awaiting your approval', 'alert');
  if (state === 'created') return tag('', 'Waiting for the phone', 'clock');
  if (state === 'approved' || state === 'grant_ready' || state === 'delivered') return tag('ok', 'Approved, finishing on the phone', 'check');
  if (state === 'acknowledged' || state === 'consumed') return tag('ok', 'Paired', 'check');
  return tag('', state.charAt(0).toUpperCase() + state.slice(1), 'slash');
}

/** What a finished record says about itself. Past tense, and explicit that nothing was granted. */
function terminalNote(e) {
  if (e.state === 'rejected') return 'You rejected it. Nothing was granted, and no phone gained access from it.';
  if (e.state === 'cancelled') return 'Cancelled before it finished. Nothing was granted.';
  return e.transcript
    ? `Expired ${when(e.expiresAt)}, before you approved it. Nothing was granted.`
    : `Expired ${when(e.expiresAt)}. The key was never entered on a phone, so nothing was granted.`;
}

function pendingRow(e, csrf, canPair) {
  const t = e.transcript;
  const over = TERMINAL_STATES.includes(e.state);
  const who = t ? `${escapeHtml(t.deviceName)} · ${escapeHtml(t.origin)} · ${(t.requestedScopes || []).map((s) => escapeHtml(SCOPE_LABEL[s] || s)).join(', ')}` : '';
  let facts;
  if (over) facts = `<small>${who ? `${who} · ` : ''}${terminalNote(e)}</small>`;
  else if (t) facts = `<small>${who}</small>`;
  else facts = `<small>Enter the pairing key on the phone. Expires ${when(e.expiresAt)}.</small>`;
  // SAS comparison applies only while pairing is active.
  const sas = !over && e.sasWords ? `<div class="kv"><span>Compare these words with the phone<small>Approve only if all five match.</small></span><b class="mono" style="font-size:15px;letter-spacing:.02em">${e.sasWords.map(escapeHtml).join(' · ')}</b></div>` : '';
  const canApprove = e.state === 'awaiting_owner_approval';
  // Render a complete footer for each known pairing state.
  let foot;
  if (over) foot = `<span class="dim">Remove clears this row. It does not touch any paired phone.${canPair ? ' Create a new pairing key to try this phone again.' : ''}</span>`;
  else if (t) foot = `<span class="dim">Server identity <span class="mono">${escapeHtml(t.serverSigningFingerprint.slice(0, 16))}</span></span>`;
  else foot = '<span class="dim">The server identity appears here once the phone gets in touch.</span>';
  return `<div class="setcard" style="margin-bottom:12px">
    <div class="kv"><span><b style="font-size:12px">Pairing ${escapeHtml(e.enrolmentId.slice(0, 6))}</b>${facts}</span>${stateTag(e.state)}</div>
    ${sas}
    <div class="kv">${foot}
      <span style="display:flex;gap:8px;flex:none">
        ${canApprove ? `<form method="post" action="/devices/approve">${csrfField(csrf)}<input type="hidden" name="id" value="${escapeHtml(e.enrolmentId)}"><button class="btn primary" type="submit">Approve</button></form>` : ''}
        <form method="post" action="/devices/reject">${csrfField(csrf)}<input type="hidden" name="id" value="${escapeHtml(e.enrolmentId)}"><button class="btn" type="submit">${canApprove ? 'Reject' : 'Remove'}</button></form>
      </span></div>
  </div>`;
}

function deviceRow(d, csrf, secure) {
  const active = d.status === 'active';
  if (!secure) {
    // The off-profile view is read-only.
    return `<div class="kv"><span><b style="font-size:12px">${escapeHtml(d.deviceName)}</b><small>${(d.scopes || []).map((s) => escapeHtml(SCOPE_LABEL[s] || s)).join(', ')} · paired ${when(d.createdAt)} · last seen ${when(d.lastSeenAt)}</small></span>
      <span style="display:flex;gap:8px;flex:none;align-items:center">${active ? tag('ok', 'Active', 'check') : tag('', escapeHtml(d.status), 'slash')}</span></div>`;
  }
  return `<div class="kv"><span><b style="font-size:12px">${escapeHtml(d.deviceName)}</b><small>${(d.scopes || []).map((s) => escapeHtml(SCOPE_LABEL[s] || s)).join(', ')} · paired ${when(d.createdAt)} · last seen ${when(d.lastSeenAt)}</small></span>
    <span style="display:flex;gap:8px;flex:none;align-items:center">
      ${active ? tag('ok', 'Active', 'check') : tag('', escapeHtml(d.status), 'slash')}
      ${active ? `<form method="post" action="/devices/rename" style="display:flex;gap:6px">${csrfField(csrf)}<input type="hidden" name="id" value="${escapeHtml(d.deviceId)}"><input name="name" type="text" value="${escapeHtml(d.deviceName)}" maxlength="64" class="in" style="width:140px"><button class="btn" type="submit">Rename</button></form>
      <form method="post" action="/devices/revoke">${csrfField(csrf)}<input type="hidden" name="id" value="${escapeHtml(d.deviceId)}"><button class="btn" type="submit">Revoke</button></form>`
      : `<form method="post" action="/devices/forget">${csrfField(csrf)}<input type="hidden" name="id" value="${escapeHtml(d.deviceId)}"><button class="btn" type="submit">Forget</button></form>`}
    </span></div>`;
}

// Secure pages carry device controls; off-profile pages are read-only.
function planeSetup(reason) {
  if (!/MOBILE_API_ENABLED is not true/.test(String(reason || ''))) return '';
  return '<div class="kv"><span>Enable mobile access<small>Add <b class="mono">docker-compose.mobile.yml</b>. Set <b class="mono">QM_MOBILE_BIND_IP</b> to a host address and <b class="mono">QM_ADVERTISED_ORIGIN</b> to the HTTPS address phones will use, then recreate Companion. Changing that origin requires pairing phones again.</small></span></div>';
}

function enrolmentSetup() {
  return '<div class="kv"><span>Enable new pairings<small>Set <b class="mono">MOBILE_ENROLMENT_ENABLED=true</b> in <b class="mono">.env</b>, then recreate Companion with the same <b class="mono">-f</b> files in the same order. The value must be lowercase <b class="mono">true</b>. Existing pairings are unaffected.</small></span></div>';
}

// Use one renderer for the full page and live fragment.
export function devicesGrid({ plane, enrolments, devices, identity }, csrf) {
  const pending = enrolments.filter((e) => !['acknowledged', 'consumed'].includes(e.state));
  const canPair = Boolean(plane.ok && plane.enrolment);
  const planeCard = plane.ok
    ? `<div class="kv"><span>Quartermaster app access</span>${tag('ok', 'On', 'check')}</div>
       <div class="kv"><span>Address</span><b class="mono">${escapeHtml(plane.origin)}</b></div>
       <div class="kv"><span>Pairing</span>${plane.enrolment ? tag('ok', 'Open', 'check') : tag('warn', 'Off', 'alert')}</div>
       ${plane.enrolment ? '' : enrolmentSetup()}
       ${plane.tls ? `<div class="kv"><span>Certificate<small>${plane.tls.source === 'generated' ? `Generated for ${escapeHtml(plane.tls.certificateHost)}${plane.tls.notAfter ? `, valid until ${when(plane.tls.notAfter)}` : ''}. Rotating it revokes paired devices.` : 'Owner-supplied from DATA_DIR/tls and left unchanged.'}</small></span><b class="mono" style="font-size:12px;overflow-wrap:anywhere">${escapeHtml(plane.tls.fingerprint)}</b></div>` : ''}`
    : `<div class="kv"><span>Quartermaster app access<small>${escapeHtml(plane.reason)}</small></span>${tag('', plane.tlsCode === 'host_changed' ? 'Off, rotation needed' : 'Off', 'slash')}</div>`;
  let identityNote;
  if (canPair) identityNote = '<small>Compare this with the phone as it pairs.</small>';
  else if (plane.ok) identityNote = '<small>Pairing is off. This fingerprint remains the server identity.</small>';
  else identityNote = '<small>This fingerprint identifies the server when pairing is available.</small>';
  const identityCard = identity ? `<div class="kv"><span>Server identity${identityNote}</span><b class="mono" style="font-size:12px;overflow-wrap:anywhere">${escapeHtml(identity.fingerprint)}</b></div>` : '';
  let emptyPending;
  if (canPair) emptyPending = 'Nothing waiting. Create a pairing key to add a phone.';
  else if (plane.ok) emptyPending = 'No pending pairings. Pairing is off; enable it above to add a phone.';
  else emptyPending = 'No pending pairings. The mobile listener is off.';
  return `<div class="setcard">
        <div class="sec-h">App access</div>
        ${planeCard}
        ${identityCard}
        ${canPair ? `<form method="post" action="/devices/pair" class="kv" style="display:flex"><span>New pairing key<small>Single use; expires in ten minutes.</small></span><span style="flex:none">${csrfField(csrf)}<button class="btn primary" type="submit">Create pairing key</button></span></form>
        <form method="post" action="/devices/pair-qr" class="kv" style="display:flex"><span>Pair by QR code<small>Single use; expires in ten minutes.</small></span><span style="flex:none">${csrfField(csrf)}<button class="btn" type="submit">Show QR code</button></span></form>` : ''}
      </div>
      <div class="setcard">
        <div class="sec-h">Pending pairings</div>
        ${pending.length ? pending.map((e) => pendingRow(e, csrf, canPair)).join('') : `<div class="kv"><span class="dim">${emptyPending}</span></div>`}
      </div>
      <div class="setcard">
        <div class="sec-h">Paired devices</div>
        ${devices.length ? devices.map((d) => deviceRow(d, csrf, true)).join('') : '<div class="kv"><span class="dim">No devices yet.</span></div>'}
      </div>`;
}

// Refresh the visible grid without replacing active form input or one-time pairing cards.
const LIVE_SCRIPT = `<script>
  (function () {
    var grid = document.getElementById('devices-live');
    function localTimes(root) {
      Array.prototype.forEach.call((root || document).querySelectorAll('[data-when]'), function (el) {
        var t = Number(el.getAttribute('data-when'));
        if (t) el.textContent = new Date(t).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      });
    }
    localTimes(document);
    if (!grid) return;
    var last = null;
    function poll() {
      fetch('/devices/live', { headers: { accept: 'text/html' } }).then(function (r) {
        if (!r.ok) throw new Error('live');
        return r.text();
      }).then(function (t) {
        if (t === last) return;
        var a = document.activeElement;
        if (a && a.tagName === 'INPUT' && grid.contains(a)) return;
        last = t;
        grid.innerHTML = t;
        localTimes(grid);
      }).catch(function () {});
    }
    setInterval(function () { if (!document.hidden) poll(); }, 5000);
  })();
</script>`;

export function devicesPage({ plane, enrolments, devices, identity, secure = true }, csrf, flash, freshKey, freshQr) {
  const secureLink = plane.ok
    ? `<div class="kv"><span>Pairing and device controls<small>Available only on the HTTPS address.</small></span><a class="btn primary" style="flex:none" href="${escapeHtml(plane.origin)}/devices">Open secure Devices page</a></div>`
    : `<div class="kv"><span>Pairing and device controls<small>The secure listener is not running.</small></span>${tag('', 'Unavailable', 'slash')}</div>${planeSetup(plane.reason)}`;
  if (!secure) {
    const canPair = Boolean(plane.ok && plane.enrolment);
    const planeCard = plane.ok
      ? `<div class="kv"><span>Quartermaster app access</span>${tag('ok', 'On', 'check')}</div>
         <div class="kv"><span>Address</span><b class="mono">${escapeHtml(plane.origin)}</b></div>
         <div class="kv"><span>Pairing</span>${plane.enrolment ? tag('ok', 'Open', 'check') : tag('warn', 'Off', 'alert')}</div>`
      : `<div class="kv"><span>Quartermaster app access<small>${escapeHtml(plane.reason)}</small></span>${tag('', plane.tlsCode === 'host_changed' ? 'Off, rotation needed' : 'Off', 'slash')}</div>`;
    let identityNote;
    if (canPair) identityNote = '<small>Compare this with the phone as it pairs.</small>';
    else if (plane.ok) identityNote = '<small>Pairing is off. This fingerprint remains the server identity.</small>';
    else identityNote = '<small>This fingerprint identifies the server when pairing is available.</small>';
    const identityCard = identity ? `<div class="kv"><span>Server identity${identityNote}</span><b class="mono" style="font-size:12px;overflow-wrap:anywhere">${escapeHtml(identity.fingerprint)}</b></div>` : '';
    return shell('devices', csrf, null, `
      ${board('devices', 'Devices', '', null)}
      <div class="setgrid">
        <div class="setcard">
          <div class="sec-h">App access</div>
          ${planeCard}
          ${identityCard}
          ${secureLink}
        </div>
        <div class="setcard">
          <div class="sec-h">Paired devices</div>
          ${devices.length ? devices.map((d) => deviceRow(d, csrf, false)).join('') : '<div class="kv"><span class="dim">No devices yet.</span></div>'}
        </div>
      </div>`);
  }
  return shell('devices', csrf, null, `
    ${board('devices', 'Devices', '', null)}
    ${flashLine(flash)}
    ${freshKey ? `<div class="setcard" style="margin-bottom:14px;border-color:var(--accent)"><div class="sec-h">Your pairing key, shown once</div>
      <div class="kv"><b class="mono" style="font-size:14px;overflow-wrap:anywhere">${escapeHtml(freshKey.pairingKey)}</b></div>
      <div class="kv"><span class="dim">In the Quartermaster app choose Add connection, then QM Companion, and enter this key with the address <span class="mono">${escapeHtml(freshKey.origin)}</span>. It expires ${when(freshKey.expiresAt)} and works once.</span></div></div>` : ''}
    ${freshQr ? `<div class="setcard" style="margin-bottom:14px;border-color:var(--accent)"><div class="sec-h">Your pairing QR code, shown once</div>
      <div class="kv" style="justify-content:center"><img src="${escapeHtml(freshQr.qrPng)}" alt="Pairing QR code for ${escapeHtml(freshQr.origin)}" width="228" height="228" style="border-radius:8px;background:#fff"></div>
      <div class="kv"><span class="dim">In the Quartermaster app choose Add connection, QM Companion, then Scan QR code. It pairs with <span class="mono">${escapeHtml(freshQr.origin)}</span>, expires ${when(freshQr.expiresAt)} and works once.</span></div></div>` : ''}
    <div class="setgrid" id="devices-live">
      ${devicesGrid({ plane, enrolments, devices, identity }, csrf)}
    </div>
    ${LIVE_SCRIPT}`);
}
