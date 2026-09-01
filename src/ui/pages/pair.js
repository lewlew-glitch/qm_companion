import { escapeHtml } from '../../http.js';
import { config } from '../../config.js';
import { labelFor, PORTS, pairingCredentialState } from '../../kinds.js';
import { ladderFor } from '../../keyladder.js';
import { I, badge, jsafe, credentialTag, ESC_FN } from '../bits.js';
import { board, shell } from '../chrome.js';
import { CONFIGURE_WORDING, deferredCredentialMarkup, ladderMarkup } from './pair-ladder.js';
import { LIVE_CHECK_SCRIPT, liveCheckMarkup } from './pair-live.js';
import { pairReadyPage } from './pair-ready.js';
import { availabilityOf } from '../../build.js';
import { availabilityChip, availabilityNoteMarkup, availabilitySectionsMarkup, pairGroupFor, pairReadinessLine, PAIR_OFFLINE_SCRIPT } from './pair-offline.js';

function pairIssues(issues) {
  if (!issues || issues.length === 0) return '';
  return `<div class="err pair-errors">${issues.map((issue) => `<div>${escapeHtml(issue)}</div>`).join('')}</div>`;
}

// Readiness is based on selected rows and their credential state.
export function selectedPairReadiness(states) {
  let waiting = 0;
  let deferred = 0;
  let total = 0;
  for (const state of states || []) {
    total += 1;
    if (state === 'missing-key') waiting += 1;
    else if (state === 'sign-in' || state === 'key-and-secret') deferred += 1;
  }
  if (total === 0) return { ready: false, line: 'Nothing selected: tick at least one service to hand over' };
  if (waiting === 0 && deferred === 0) return { ready: true, line: 'Everything selected is ready' };
  if (waiting > 0 && deferred === 0) return { ready: false, line: `Watching for ${waiting} service key${waiting === 1 ? '' : 's'}` };
  if (waiting === 0) return { ready: false, line: `${deferred} selected service${deferred === 1 ? '' : 's'} need${deferred === 1 ? 's' : ''} setup after pairing` };
  const needing = waiting + deferred;
  return { ready: false, line: `${needing} selected service${needing === 1 ? '' : 's'} need credentials` };
}

// Direct field edits use this exact projection so collapsed rows stay in sync.
export function syncPairRouteSummary(row) {
  if (!row || typeof row.querySelector !== 'function') return;
  const summary = row.querySelector('[data-route-summary]');
  if (!summary) return;
  const base = row.querySelector('.pair-base');
  const remote = row.querySelector('.pair-remote');
  const local = base && base.value.trim() ? base.value.trim() : 'No local address set';
  const away = remote && remote.value.trim() ? `Away: ${remote.value.trim()}` : 'Home route only';
  const localLine = summary.querySelector('span');
  const awayLine = summary.querySelector('small');
  if (localLine) localLine.textContent = local;
  if (awayLine) awayLine.textContent = away;
}

// Summarize transfer eligibility.
export function pairTransferSummary(detected, forcedIds) {
  const rows = Array.isArray(detected) ? detected : [];
  const forced = forcedIds instanceof Set ? forcedIds : new Set(forcedIds || []);
  let ready = 0;
  let credential = 0;
  let unchecked = 0;
  let stopped = 0;
  let unreachable = 0;
  let includedAnyway = 0;
  for (const d of rows) {
    const availability = availabilityOf(d);
    if (availability === 'not-running') { stopped += 1; continue; }
    // Do not count an overridden unreachable row as left out.
    if (availability === 'unreachable') { if (forced.has(d.instanceId)) includedAnyway += 1; else unreachable += 1; continue; }
    if (availability === 'unverified') unchecked += 1;
    const state = pairingCredentialState(d.kind, d.apiKey, d.credentialConflict);
    if (state === 'included' || state === 'not-required') ready += 1;
    else credential += 1;
  }
  const total = rows.length;
  const parts = [];
  if (total === 0) parts.push('No services detected yet.');
  else if (total === 1) parts.push(`The one detected service is ${ready ? '' : 'not '}ready for this scan.`);
  else if (ready === 0) parts.push(`None of the ${total} detected services is ready for this scan yet.`);
  else parts.push(`${ready} of ${total} detected services ${ready === 1 ? 'is' : 'are'} ready for this scan.`);
  if (credential) parts.push(`${credential} still need${credential === 1 ? 's' : ''} a service credential: open the row and create or paste the key there.`);
  if (unchecked) parts.push(`Companion could not check ${unchecked} of them, so tick ${unchecked === 1 ? 'it' : 'one'} only if you know it is running.`);
  if (stopped) parts.push(`${stopped} ${stopped === 1 ? 'is' : 'are'} not running and cannot be handed over: start ${stopped === 1 ? 'it' : 'them'} in Docker and this page updates on its own.`);
  if (unreachable) parts.push(`${unreachable} ${unreachable === 1 ? 'is' : 'are'} running but unreachable from Companion and left out: use Include anyway on ${unreachable === 1 ? 'its row if your phone can reach it' : 'any row your phone can reach'}.`);
  if (includedAnyway) parts.push(`${includedAnyway} ${includedAnyway === 1 ? 'is' : 'are'} unreachable from Companion but manually included. The phone checks ${includedAnyway === 1 ? 'that address' : 'those addresses'} before saving.`);
  return parts.join(' ');
}

// Restore a posted reachability override after validation fails.
function forcedNoteMarkup(d, fallbackUrl, index, forced) {
  const markup = availabilityNoteMarkup(d, fallbackUrl, index);
  if (!forced) return markup;
  const found = new RegExp(`<input\\b[^>]*\\bname=["']?force_${index}["']?[^>]*>`).exec(markup);
  if (!found) return `${markup}<input type="hidden" name="force_${index}" value="on" data-force-flag>`;
  const stamped = /\bvalue=("[^"]*"|'[^']*')/.test(found[0])
    ? found[0].replace(/\bvalue=("[^"]*"|'[^']*')/, 'value="on"')
    : found[0].replace(/<input\b/, '<input value="on"');
  return markup.replace(found[0], () => stamped);
}

// Select the lowest published port and list any alternatives.
function publishedChoiceMarkup(d) {
  const alternates = Array.isArray(d.publishedPortAlternates) ? d.publishedPortAlternates : [];
  if (alternates.length === 0 || !d.publishedPort) return '';
  const all = [d.publishedPort, ...alternates];
  const list = `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
  return `<p class="cc-hint pair-port-choice" data-port-choice>Docker publishes this on ports ${escapeHtml(list)}, and all of them reach the same service. Companion has filled in ${escapeHtml(d.publishedPort)}: change the address below if your phone should use one of the others.</p>`;
}

function pairConfigurePage({ detected, draft, issues, csrf, mintEnabledKinds = [], canShell = false }) {
  const values = new Map((draft.services || []).map((row) => [row.instanceId, row]));
  // Credential methods by service instance.
  const ladders = {};
  const selectedStates = [];
  // Count only unreachable rows excluded from the hand-over.
  let unreachableLeftOut = 0;
  const forcedIds = new Set();
  const groups = { reachable: [], unreachable: [], stopped: [], unverified: [] };
  detected.forEach((d, index) => {
    const value = values.get(d.instanceId) || { included: false, baseUrl: '', remoteBaseUrl: '' };
    const title = String(d.name || labelFor(d.kind));
    const availability = availabilityOf(d);
    const group = pairGroupFor(d);
    // Preserve posted overrides across renders and probe changes.
    const forcedDecision = value.forced === true;
    // Apply an override only while the row remains unreachable.
    const forced = forcedDecision && group === 'unreachable' && d.credentialConflict !== true;
    // Stopped and unreachable rows are blocked unless an override applies.
    const blocked = d.credentialConflict === true || (group === 'unreachable' && !forced) || group === 'stopped';
    const state = pairingCredentialState(d.kind, d.apiKey, d.credentialConflict);
    const picked = value.included && !blocked;
    const localRoute = value.baseUrl || `No local address set`;
    const awayRoute = value.remoteBaseUrl ? `Away: ${value.remoteBaseUrl}` : 'Home route only';
    const toggleLabel = state === 'included' || state === 'not-required' ? 'Edit routes' : 'Set up service';
    const rung = state === 'missing-key' ? ladderFor(d.kind) : null;
    const deferred = deferredCredentialMarkup(d.kind, state);
    if (picked) selectedStates.push(state);
    if (group === 'unreachable' && !picked) unreachableLeftOut += 1;
    if (forced && picked) forcedIds.add(d.instanceId);
    if (rung) {
      ladders[d.instanceId] = {
        class: rung.class,
        kind: d.kind,
        settingsPath: rung.settingsPath || '',
        mint: rung.mint ? { usernameLabel: rung.mint.usernameLabel, passwordLabel: rung.mint.passwordLabel, note: rung.mint.note } : null,
      };
    }
    const markup = `<section class="pair-service${group === 'reachable' ? '' : ` is-${group}`}" data-pair-row data-instance="${escapeHtml(d.instanceId)}" data-kind="${escapeHtml(d.kind)}" data-cred-state="${escapeHtml(state)}" data-avail="${escapeHtml(availability)}" data-docker-state="${escapeHtml(d.dockerState || '')}" data-url="${escapeHtml(d.url || '')}" data-order="${index}"${forcedDecision ? ' data-forced="1"' : ''}>
      <input type="hidden" name="service_${index}" value="${escapeHtml(d.instanceId)}">
      <div class="pair-service-head">
        <label class="pair-pick"><input type="checkbox" name="include_${index}" ${picked ? 'checked' : ''} ${blocked ? 'disabled' : ''}>${badge(d.kind, title)}<span><b>${escapeHtml(title)}</b><small>${escapeHtml(d.kind)} · port ${escapeHtml(d.port || PORTS[d.kind] || 'unknown')}</small></span></label>
        <div class="pair-route-summary" data-route-summary><span class="mono">${escapeHtml(localRoute)}</span><small>${escapeHtml(awayRoute)}</small></div>
        <span class="credwrap" data-cred>${group === 'reachable' ? credentialTag(d, 'configure') : availabilityChip(availability, d.dockerState)}</span>
        <button class="btn pair-service-toggle" type="button" data-pair-toggle aria-expanded="false" aria-controls="pair-body-${index}">${escapeHtml(toggleLabel)}${I.chev}</button>
      </div>
      ${publishedChoiceMarkup(d)}
      ${forcedNoteMarkup(d, value.baseUrl, index, forcedDecision)}
      <div class="pair-service-body" id="pair-body-${index}" data-pair-body hidden>
        <div class="pair-route-grid">
          <div class="field"><label for="base_${index}">Home / local address</label><input class="pair-base" id="base_${index}" name="base_${index}" type="url" value="${escapeHtml(value.baseUrl || '')}" placeholder="http://192.168.1.10:${escapeHtml(d.port || PORTS[d.kind] || '')}" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label for="remote_${index}">Away address <span>optional, Tailscale or Cloudflare</span></label><input class="pair-remote" id="remote_${index}" name="remote_${index}" type="url" value="${escapeHtml(value.remoteBaseUrl || '')}" placeholder="https://nas.tailnet.ts.net:${escapeHtml(d.port || PORTS[d.kind] || '')} or https://${escapeHtml(d.kind)}.example.com" autocomplete="off" spellcheck="false"></div>
        </div>
        ${rung ? ladderMarkup(d.kind, rung, canShell, mintEnabledKinds, d.name) : deferred}
      </div>
    </section>`;
    groups[group].push(markup);
  });
  const transferSummary = pairTransferSummary(detected, forcedIds);
  const initialReadiness = selectedPairReadiness(selectedStates);
  const initialLine = pairReadinessLine(initialReadiness, { unreachable: unreachableLeftOut, stopped: groups.stopped.length });
  const edge = draft.edgeAccess || {};
  const meta = { host: config.qmHost || 'localhost', count: detected.length, online: null };
  return shell('pair', csrf || null, meta, `
    ${board('pair', 'Set up the app', '', meta)}
    <p class="sub">Review the addresses used by the phone. Detected API keys are included in the encrypted transfer. After setup, Quartermaster connects to each service directly.</p>
    ${pairIssues(issues)}
    ${liveCheckMarkup('pair-live', 'Checked when this page loaded.')}
    <div class="pair-credential-note">
      <div><b>Transfer readiness</b><span>${escapeHtml(transferSummary)}</span></div>
      <span class="pair-readiness${initialReadiness.ready ? ' ready' : ''}" id="pair-readiness"><span class="rdot"></span><span id="pair-ready-line">${escapeHtml(initialLine)}</span></span>
      <button class="btn" id="pair-expand" type="button" aria-expanded="false">Review all routes</button>
    </div>
    <form method="post" action="/pair" class="pair-form">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf || '')}">
      <div class="pair-services" data-pair-reachable-rows>${groups.reachable.join('')}</div>
      ${availabilitySectionsMarkup(groups)}
      <details class="conncard edge-card" ${edge.domain || edge.clientId ? 'open' : ''}>
        <summary>Cloudflare Access service token <span>optional</span></summary>
        <p class="cc-hint">Only use this when Access protects your away URLs. The pair is encrypted into the transfer and attached only to matching remote hosts. Companion accepts these long-lived credentials only when this page is served over HTTPS.</p>
        <div class="pair-edge-grid">
          <div class="field"><label for="edge_domain">Protected domain</label><input id="edge_domain" name="edge_domain" type="text" value="${escapeHtml(edge.domain || '')}" placeholder="example.com" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label for="edge_client_id">CF Access client ID</label><input id="edge_client_id" name="edge_client_id" type="text" value="${escapeHtml(edge.clientId || '')}" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label for="edge_client_secret">CF Access client secret</label><input id="edge_client_secret" name="edge_client_secret" type="password" value="" autocomplete="new-password" spellcheck="false"></div>
        </div>
      </details>
      <div class="pair-submit"><button class="btn primary" type="submit">Create one-time transfer${I.arrowR}</button><span>The code expires in three minutes.</span></div>
    </form>
    <script>
      (function () {
        ${ESC_FN}
        ${LIVE_CHECK_SCRIPT}
        ${selectedPairReadiness.toString()}
        ${syncPairRouteSummary.toString()}
        var LADDERS = ${jsafe(ladders)};
        var WORDING = ${jsafe(CONFIGURE_WORDING)};
        var CHECK = ${jsafe(I.check)}, ALERT = ${jsafe(I.alert)};
        var HEAD = { 'content-type': 'application/json', 'x-csrf-token': (document.querySelector('meta[name=csrf]') || {}).content || '' };
        var byId = {};
        Array.prototype.forEach.call(document.querySelectorAll('[data-pair-row]'), function (row) { byId[row.dataset.instance] = row; });

        function chipHtml(state) {
          var word = WORDING[state] || 'Needs setup', tone = 'line', icon = '';
          if (state === 'included') { tone = 'ok'; icon = CHECK; }
          else if (state === 'not-required') { tone = 'info'; icon = CHECK; }
          else if (state === 'conflict') { tone = 'bad'; icon = ALERT; }
          else if (state === 'missing-key' || state === 'key-and-secret') { tone = 'warn'; icon = ALERT; }
          return '<span class="badge ' + tone + '">' + icon + esc(word) + '</span>';
        }
        function refreshRung(row) {
          var ladder = row.querySelector('[data-ladder]'), made = row.querySelector('[data-made]');
          var next = row.querySelector('[data-next-step]'), state = row.dataset.credState;
          var missing = row.dataset.credState === 'missing-key';
          if (ladder) ladder.hidden = !missing;
          if (made) made.classList.toggle('on', !missing && row.dataset.minted === '1');
          if (next) next.hidden = state !== 'sign-in' && state !== 'key-and-secret';
        }
        function setChip(row, state) {
          if (state === row.dataset.credState) return;
          var wrap = row.dataset.avail === 'reachable' ? row.querySelector('[data-cred]') : null;
          if (wrap) { wrap.innerHTML = chipHtml(state); wrap.classList.remove('flip'); void wrap.offsetWidth; wrap.classList.add('flip'); }
          row.dataset.credState = state;
          refreshRung(row);
        }
        ${PAIR_OFFLINE_SCRIPT}
        function recount() {
          var selected = [];
          Array.prototype.forEach.call(document.querySelectorAll('[data-pair-row]'), function (row) {
            if (row.querySelector('.pair-pick input').checked) selected.push(row.dataset.credState);
          });
          var readiness = selectedPairReadiness(selected);
          var el = document.getElementById('pair-readiness'), line = document.getElementById('pair-ready-line');
          if (!el) return;
          el.classList.toggle('ready', readiness.ready);
          line.textContent = pairReadinessLine(readiness, leftOutCounts());
        }
        function updateOpen(row) {
          var a = row.querySelector('.pair-open'); if (!a) return;
          var lad = LADDERS[row.dataset.instance] || {}, base = (row.querySelector('.pair-base').value || '').trim();
          if (!base) { a.setAttribute('aria-disabled', 'true'); a.removeAttribute('href'); return; }
          a.removeAttribute('aria-disabled');
          a.href = base.replace(/\\/+$/, '') + (lad.settingsPath || '');
        }

        Array.prototype.forEach.call(document.querySelectorAll('[data-pair-row]'), function (row) {
          var id = row.dataset.instance, lad = LADDERS[id];
          var toggle = row.querySelector('[data-pair-toggle]'), body = row.querySelector('[data-pair-body]');
          function setOpen(open) {
            if (!toggle || !body) return;
            body.hidden = !open;
            row.classList.toggle('open', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          }
          if (toggle) toggle.addEventListener('click', function () { setOpen(body.hidden); });
          row.querySelector('.pair-pick input').addEventListener('change', recount);
          var base = row.querySelector('.pair-base');
          var remote = row.querySelector('.pair-remote');
          if (base) base.addEventListener('input', function () { updateOpen(row); syncPairRouteSummary(row); });
          if (remote) remote.addEventListener('input', function () { syncPairRouteSummary(row); });
          updateOpen(row);
          var manualInput = row.querySelector('[data-manual-key]');
          var saveKey = row.querySelector('[data-save-key]');
          var keyStatus = row.querySelector('[data-key-status]');
          function saveManualKey() {
            if (!manualInput || !saveKey) return;
            var apiKey = manualInput.value;
            if (!apiKey) {
              if (keyStatus) keyStatus.textContent = 'Paste the key first.';
              manualInput.focus();
              return;
            }
            saveKey.disabled = true;
            if (keyStatus) keyStatus.textContent = 'Saving securely...';
            var payload = JSON.stringify({ instanceId: id, apiKey: apiKey });
            apiKey = '';
            fetch('/pair/keys/manual', { method: 'POST', headers: HEAD, body: payload })
              .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok && d.ok === true, error: d.error }; }); })
              .then(function (result) {
                if (!result.ok) {
                  if (keyStatus) keyStatus.textContent = result.error || 'The key could not be saved.';
                  return;
                }
                manualInput.value = '';
                row.dataset.minted = '1';
                setChip(row, 'included');
                recount();
              })
              .catch(function () { if (keyStatus) keyStatus.textContent = 'The request failed.'; })
              .finally(function () { saveKey.disabled = false; payload = ''; });
          }
          if (saveKey) saveKey.addEventListener('click', saveManualKey);
          if (manualInput) manualInput.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') { event.preventDefault(); saveManualKey(); }
          });
          var copy = row.querySelector('[data-copy]');
          if (copy) copy.addEventListener('click', function () {
            var code = row.querySelector('[data-copytext]'), text = code ? (code.getAttribute('data-copytext') || code.textContent) : '';
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { copy.textContent = 'Copied'; }).catch(function () { copy.textContent = 'Copy failed'; });
          });
          var forget = row.querySelector('[data-forget]');
          if (forget) forget.addEventListener('click', function () {
            fetch('/pair/keys/forget', { method: 'POST', headers: HEAD, body: JSON.stringify({ instanceId: id }) }).then(function (r) {
              if (r.ok) { row.dataset.minted = ''; setChip(row, 'missing-key'); recount(); }
            });
          });
          var readBtn = row.querySelector('[data-read]');
          if (readBtn) readBtn.addEventListener('click', function () {
            qmConfirm({ title: 'Read key from container', what: 'Companion runs one command inside the ' + row.dataset.kind + ' container to read its API key, then seals it.', confirmLabel: 'Read key', pref: true }).then(function (go) {
              if (!go) return;
              var t = qmToast('Reading the ' + row.dataset.kind + ' key');
              t.ops.set('read', { label: 'Reading from the container', state: 'active' });
              fetch('/pair/keys/read', { method: 'POST', headers: HEAD, body: JSON.stringify({ instanceId: id }) })
                .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok && d.ok, error: d.error }; }); })
                .then(function (res) {
                  t.ops.set('read', { state: res.ok ? 'ok' : 'fail', note: res.ok ? 'sealed' : (res.error || 'could not read the key') });
                  if (res.ok) { row.dataset.minted = '1'; setChip(row, 'included'); recount(); }
                }).catch(function () { t.ops.set('read', { state: 'fail', note: 'the request failed' }); });
            });
          });
          var mintBtn = row.querySelector('[data-mint-btn]');
          if (mintBtn && lad && lad.mint) mintBtn.addEventListener('click', function () {
            var nameEl = row.querySelector('.pair-pick b');
            var serviceName = nameEl ? nameEl.textContent : row.dataset.kind;
            var baseEl = row.querySelector('.pair-base');
            var baseUrl = baseEl ? baseEl.value.trim() : '';
            qmMintModal({
              title: 'Create a ' + serviceName + ' key',
              note: lad.mint.note,
              kind: row.dataset.kind,
              serviceName: serviceName,
              baseUrl: baseUrl,
              usernameLabel: lad.mint.usernameLabel,
              passwordLabel: lad.mint.passwordLabel,
              onSubmit: function (user, pass, onStep) {
                return qmStream('/pair/keys/mint', { instanceId: id, baseUrl: baseUrl, credentials: { username: user, password: pass } }, onStep);
              },
            }).then(function (ok) { if (ok) { row.dataset.minted = '1'; setChip(row, 'included'); recount(); } });
          });
        });

        var expand = document.getElementById('pair-expand');
        if (expand) expand.addEventListener('click', function () {
          var opening = expand.getAttribute('aria-expanded') !== 'true';
          document.querySelectorAll('[data-pair-row]').forEach(function (row) {
            var body = row.querySelector('[data-pair-body]'), toggle = row.querySelector('[data-pair-toggle]');
            if (!body || !toggle) return;
            body.hidden = !opening;
            row.classList.toggle('open', opening);
            toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
          });
          expand.setAttribute('aria-expanded', opening ? 'true' : 'false');
          expand.textContent = opening ? 'Collapse all routes' : 'Review all routes';
        });

        // Surface polling failures because they make readiness state stale.
        var live = qmLiveCheck('pair-live', {
          expired: 'Your Companion session expired. Sign in again, then check for updates. Your entered addresses remain on this page.',
          unreachable: 'Companion did not answer the last two checks. The displayed status may be out of date.',
        });
        function poll() {
          fetch('/api/services', { headers: { accept: 'application/json' } })
            .then(function (r) { if (!r.ok) { live.fail(r.status); return null; } return r.json().catch(function () { return {}; }); })
            .then(function (d) {
              if (d === null) return;
              if (!d || !Array.isArray(d.services)) { live.fail(0); return; }
              live.ok();
              d.services.forEach(function (s) {
                var row = byId[s.instanceId];
                if (!row) return;
                if (s.credentialState) setChip(row, s.credentialState);
                if (s.availability) setAvailability(row, s.availability, s.dockerState || '', s.url);
              });
              recount();
            }).catch(function () { live.fail(0); });
        }
        live.onRetry(poll);
        var timer = setInterval(function () { if (!document.hidden) poll(); }, 5000);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
        window.addEventListener('focus', poll);
      })();
    </script>`);
}

export function pairPage(model) {
  if (model.stage === 'ready') return pairReadyPage(model);
  if (model.stage === 'configure') return pairConfigurePage(model);
  return shell('pair', model.csrf || null, null, `
    ${board('pair', 'Set up the app', '', null)}
    <p class="sub">Companion creates a short-lived encrypted handoff; the phone then connects to your services directly.</p>
    ${pairIssues(model.issues)}
    <div class="empty">No services are ready to hand over yet.</div>`);
}
