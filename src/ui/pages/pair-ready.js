import { escapeHtml } from '../../http.js';
import { config } from '../../config.js';
import { badge, jsafe, credentialTag, ESC_FN } from '../bits.js';
import { board, shell } from '../chrome.js';
import { LIVE_CHECK_SCRIPT, liveCheckMarkup } from './pair-live.js';

// The static no-JavaScript fallback reports the fixed UTC deadline across browser time zones.
export function pairExpiryText(expiresAt) {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return 'Expires shortly. Create another transfer if the code is refused.';
  return `Expires at ${new Date(at).toISOString().slice(11, 19)} UTC`;
}

export function pairReadyPage({ bundle, qrDataUrl, filePath, csrf }) {
  const meta = { host: config.qmHost || 'localhost', count: bundle.summary.length, online: null };
  const rows = bundle.summary.map((s) => `
    <div class="pair-ready-row">
      ${badge(s.kind, s.label)}
      <div><b>${escapeHtml(s.label)}</b><small class="mono">${escapeHtml(s.baseUrl)}</small>${s.remoteBaseUrl ? `<small class="mono">${escapeHtml(s.remoteBaseUrl)}</small>` : ''}</div>
      <div>${credentialTag(s, 'ready')}</div>
    </div>`).join('');
  // Watch services that were transferred without a key.
  const awaiting = bundle.summary.filter((s) => !s.hasKey).map((s) => ({ instanceId: s.instanceId, label: s.label }));
  return shell('pair', csrf || null, meta, `
    ${board('pair', 'One-time transfer ready', '', meta)}
    <p class="sub">Every service listed below is included. The badges describe which credentials come with it. Quartermaster checks each connection before saving; services without credentials may need you to sign in. The encrypted transfer disappears after the first download or when the timer ends.</p>
    ${awaiting.length ? liveCheckMarkup('pair-ready-live', 'Watching for late keys. Checked when this page loaded.') : ''}
    <div class="pair-wrap">
      <div>
        <div class="qr"><img id="pair-qr" src="${qrDataUrl}" alt="One-time Companion pairing code"><div class="count" id="pair-expiry">${escapeHtml(pairExpiryText(bundle.companion.expiresAt))}</div></div>
        <div class="passbox"><div class="p-top"><span>Setup code</span><button class="copybtn" id="copy-setup" type="button">Copy</button></div><code class="mono" id="setup-code">${escapeHtml(bundle.setupCode)}</code></div>
        <a class="btn pair-fallback" id="pair-file" href="${escapeHtml(filePath)}" download="quartermaster.qmcompanion">Download one-use .qmcompanion file instead</a>
        <a class="btn primary pair-fallback" id="pair-again" href="/pair" hidden style="display:none">Create another transfer</a>
      </div>
      <div>
        <ol class="steps">
          <li>Open <b>Quartermaster</b> and choose <b>Set up with Companion</b>.</li>
          <li>Scan this code before it expires.</li>
          <li>Type the separate <b>setup code</b>, review the routes, then import.</li>
        </ol>
        <p class="cc-hint">The .qmcompanion fallback opens only in Quartermaster's Companion setup. Downloading it consumes the same transfer, so the QR will no longer redeem. If setup is interrupted after redemption, create a fresh transfer.</p>
        <form method="post" action="/pair/reissue" class="reissue-form" id="reissue" hidden>
          <input type="hidden" name="bundleId" value="${escapeHtml(bundle.companion.bundleId)}">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf || '')}">
          <div class="reissue-banner" id="reissue-msg"></div>
          <button class="btn primary" type="submit">Re-issue with the new key</button>
        </form>
        <div class="sec-h">Handing over ${bundle.summary.length} service${bundle.summary.length === 1 ? '' : 's'}</div>
        <div class="pair-ready-list">${rows}</div>
        <p class="cc-hint">To include a missing API key, <a href="/pair">return to setup</a> and create or paste it before making a fresh transfer.</p>
      </div>
    </div>
    <script>
      (function () {
        ${ESC_FN}
        ${LIVE_CHECK_SCRIPT}
        try { history.replaceState(null, '', '/pair'); } catch (e) {}
        var expires = Date.parse(${jsafe(bundle.companion.expiresAt)}), label = document.getElementById('pair-expiry');
  // Disable expired transfer controls.
        function expire() {
          if (label) label.textContent = 'Expired. This code will not redeem.';
          var qr = document.getElementById('pair-qr');
          if (qr) {
            qr.style.filter = 'grayscale(1) blur(5px)';
            qr.style.opacity = '0.3';
            qr.alt = 'Expired pairing code';
          }
          var copy = document.getElementById('copy-setup');
          if (copy) { copy.disabled = true; copy.textContent = 'Expired'; }
          var file = document.getElementById('pair-file');
          if (file) {
            file.removeAttribute('href');
            file.removeAttribute('download');
            file.setAttribute('aria-disabled', 'true');
            file.textContent = 'The one-use file has expired too';
          }
        // Clear both display overrides.
          var again = document.getElementById('pair-again');
          if (again) { again.hidden = false; again.style.display = ''; }
        }
        function tick() {
          if (!isFinite(expires)) return;
          var seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
          if (!seconds) { expire(); return; }
          label.textContent = 'Expires in ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
          setTimeout(tick, 1000);
        }
        document.getElementById('copy-setup').addEventListener('click', function () {
          var button = this, code = document.getElementById('setup-code');
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code.textContent).then(function () { button.textContent = 'Copied'; }).catch(function () { button.textContent = 'Select the code'; });
          } else {
            var range = document.createRange(); range.selectNodeContents(code);
            var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
            button.textContent = 'Selected';
          }
        });
        tick();

        // Poll for keys that were unavailable when the code was created.
        var AWAIT = ${jsafe(awaiting)};
        var form = document.getElementById('reissue'), msg = document.getElementById('reissue-msg');
        if (AWAIT.length) {
          var live = qmLiveCheck('pair-ready-live', {
            expired: 'Your Companion session expired. Sign in again, then check for the key. The displayed code remains valid until it expires.',
            unreachable: 'Companion did not answer the last two checks.',
          });
        var pollActive = true, pollRun = null, timer = null;
        function poll() {
          if (!pollActive || document.hidden || pollRun) return;
          var run = { controller: new AbortController(), deadline: null }, skipped = {};
          pollRun = run;
          function current() { return pollActive && pollRun === run; }
          function finish() {
            clearTimeout(run.deadline);
            if (pollRun === run) pollRun = null;
          }
          run.deadline = setTimeout(function () {
            if (!current()) return;
            finish();
            run.controller.abort();
            live.fail(0);
          }, 90000);
          Promise.resolve().then(function () {
            if (!current()) return skipped;
            return fetch('/api/services', { headers: { accept: 'application/json' }, signal: run.controller.signal });
          }).then(function (r) {
            if (!current() || r === skipped) return skipped;
            if (!r.ok) { live.fail(r.status); return skipped; }
            return r.json();
          }).then(function (d) {
            if (!current() || d === skipped) return;
            if (!d || !Array.isArray(d.services)) { live.fail(0); return; }
            live.ok();
                var map = {};
                d.services.forEach(function (s) { map[s.instanceId] = s; });
                var available = AWAIT.filter(function (a) { return map[a.instanceId] && map[a.instanceId].hasKey; });
                if (available.length && form.hidden) {
                  msg.textContent = available[0].label + "'s key is now available. Re-issue to include it.";
                  form.hidden = false;
                }
          }).catch(function () { if (current()) live.fail(0); }).finally(finish);
        }
        function armPolling() {
          if (timer === null) timer = setInterval(poll, 10000);
        }
        function pausePolling() {
          pollActive = false;
          clearInterval(timer); timer = null;
          var run = pollRun; pollRun = null;
          if (run) { clearTimeout(run.deadline); run.controller.abort(); }
        }
        live.onRetry(poll);
        document.addEventListener('visibilitychange', poll);
        window.addEventListener('focus', poll);
        window.addEventListener('pagehide', pausePolling);
        window.addEventListener('pageshow', function () {
          if (pollActive) return;
          pollActive = true; armPolling(); poll();
        });
        armPolling();
        poll();
        }
      })();
    </script>`);
}
