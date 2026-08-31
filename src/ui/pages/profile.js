import { escapeHtml } from '../../http.js';
import { config } from '../../config.js';
import { tag, fmtWhen } from '../bits.js';
import { board, shell } from '../chrome.js';

// Default bearer-token read allowlist.
export const TOKEN_READ_PATHS = [
  '/api/services',
  '/api/updates',
  '/api/docker/stats',
  '/api/containers/stats',
  '/api/docker/df',
];

// Infer tone for legacy string flashes; structured flashes provide an explicit status.
const REFUSAL = /(was wrong|did not|does not|not accepted|needs at least|must be at most|could not|cannot|failed|invalid|too many|expired)/i;

export function flashNote(flash) {
  if (!flash) return null;
  if (typeof flash === 'object') {
    const text = String(flash.text || '');
    return text ? { text, ok: flash.ok !== false } : null;
  }
  const text = String(flash);
  return { text, ok: !REFUSAL.test(text) };
}

function pathList(readPaths) {
  const paths = [...(readPaths || TOKEN_READ_PATHS)].map(String);
  return paths.map((p) => `<code class="mono">${escapeHtml(p)}</code>`).join('<br>');
}

// Start with the configured host and replace it with the browser origin when available.
function curlLine(freshToken, readPaths) {
  const first = [...(readPaths || TOKEN_READ_PATHS)][0] || '/api/services';
  const origin = `http://${config.qmHost}:${config.port}`;
  return { origin, text: `curl -H "Authorization: Bearer ${freshToken}" ${origin}${first}` };
}

function freshTokenCard(freshToken, readPaths) {
  const curl = curlLine(freshToken, readPaths);
  return `<div class="setcard" style="margin-bottom:14px;border-color:var(--accent)"><div class="sec-h">Your new token, shown once</div>
      <div class="kv"><b class="mono" id="tok-val" style="font-size:13px;overflow-wrap:anywhere;max-width:none;text-align:left">${escapeHtml(freshToken)}</b>
        <button class="btn" type="button" data-copy="tok-val">Copy</button></div>
      <div class="kv"><span class="dim">Send it as <code class="mono">Authorization: Bearer …</code> on a GET. It reads only these paths; every other path on the panel is refused.</span>
        <span class="mono" style="flex:none;font-size:11.5px;line-height:1.8;text-align:right">${pathList(readPaths)}</span></div>
      <div class="kv"><code class="mono" id="tok-curl" data-origin="${escapeHtml(curl.origin)}" style="flex:1 1 auto;min-width:0;font-size:11.5px;overflow-wrap:anywhere">${escapeHtml(curl.text)}</code>
        <button class="btn" type="button" data-copy="tok-curl">Copy</button></div>
      <div class="kv"><span class="dim">Copy it now. The panel keeps only a hash of it, so this is the last time it can be shown.</span></div></div>`;
}

// Use a textarea fallback when the Clipboard API is unavailable.
const COPY_SCRIPT = `<script>
  (function () {
    var curl = document.getElementById('tok-curl');
    if (curl && curl.dataset.origin && location.origin && location.origin !== curl.dataset.origin) {
      curl.textContent = curl.textContent.split(curl.dataset.origin).join(location.origin);
    }
    function copyText(t) {
      if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
      return new Promise(function (res, rej) {
        var a = document.createElement('textarea');
        a.value = t; a.setAttribute('readonly', ''); a.style.position = 'fixed'; a.style.top = '-1000px'; a.style.opacity = '0';
        document.body.appendChild(a); a.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
        a.remove();
        if (ok) res(); else rej();
      });
    }
    document.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = document.getElementById(b.dataset.copy);
        if (!el) return;
        var was = b.dataset.label || b.textContent;
        b.dataset.label = was;
        copyText(el.textContent).then(function () { b.textContent = 'Copied'; }, function () { b.textContent = 'Select it to copy'; });
        setTimeout(function () { b.textContent = was; }, 1800);
      });
    });
  })();
</script>`;

export function profilePage(info, mfaOn, tokens, csrf, flash, freshToken, readPaths) {
  const initials = escapeHtml((info.name || 'A').replace(/[^a-z0-9 ]/gi, '').split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase() || 'AD');
  const note = flashNote(flash);
  // Distinguish tokens that have never been used from missing timestamps.
  const lastUsed = (t) => (t.lastUsedAt ? `last used ${escapeHtml(fmtWhen(t.lastUsedAt))}` : 'never used');
  const tokenRows = tokens.length ? tokens.map((t) => `
    <div class="kv"><span><b style="font-size:12px">${escapeHtml(t.name)}</b><small><span class="mono">${escapeHtml(t.prefix)}…</span> · created ${escapeHtml(fmtWhen(t.createdAt))} · ${lastUsed(t)}</small></span>
      <form method="post" action="/profile/token/revoke" style="flex:none">
        <input type="hidden" name="id" value="${escapeHtml(t.id)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button class="btn" type="submit">Revoke</button>
      </form></div>`).join('') : '<div class="kv"><span class="dim">No tokens. Generate one for scripts that read the API.</span></div>';
  return shell('profile', csrf, null, `
    ${board('profile', 'Profile', '', null)}
    ${note ? (note.ok
      ? `<p class="sub" style="color:var(--ok)">${escapeHtml(note.text)}</p>`
      : `<div class="err" style="max-width:70ch">${escapeHtml(note.text)}</div>`) : ''}
    ${freshToken ? freshTokenCard(freshToken, readPaths) : ''}
    <div class="setgrid">
      <div class="setcard">
        <div class="sec-h">Account</div>
        <div class="kv"><span style="display:flex;align-items:center;gap:12px"><span style="width:40px;height:40px;border-radius:50%;background:var(--accent-soft);color:var(--accent-2);display:grid;place-items:center;font-weight:600;font-size:13px">${initials}</span><span>${escapeHtml(info.name)}<small>Owner · the only account</small></span></span></div>
        <div class="kv"><span>Created</span><b>${escapeHtml(fmtWhen(info.createdAt))}</b></div>
        <div class="kv"><span>Last sign-in</span><b>${escapeHtml(fmtWhen(info.lastLoginAt))}</b></div>
        <form method="post" action="/profile/name" class="kv" style="display:flex">
          <span>Display name</span>
          <span style="display:flex;gap:8px;flex:none">
            <input name="name" type="text" value="${escapeHtml(info.name)}" maxlength="40" class="in" style="width:160px">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button class="btn" type="submit">Save</button>
          </span>
        </form>
      </div>
      <div class="setcard">
        <div class="sec-h">Security</div>
        <form method="post" action="/profile/password">
          <div class="kv"><span>Current password</span><input name="current" type="password" autocomplete="current-password" maxlength="256" required class="in" style="width:200px"></div>
          <div class="kv"><span>New password<small>At least 10 characters.</small></span><input name="next" type="password" autocomplete="new-password" minlength="10" maxlength="256" required class="in" style="width:200px"></div>
          <div class="kv"><span></span><span style="flex:none"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="btn" type="submit">Change password</button></span></div>
        </form>
        <div class="kv"><span>Two-factor sign-in${mfaOn ? '' : '<small>An authenticator code on top of the password.</small>'}</span>
          ${mfaOn ? tag('ok', 'On', 'check') : `<a class="btn" href="/settings/mfa">Turn on</a>`}</div>
        ${mfaOn ? `<form method="post" action="/settings/mfa/disable" class="kv" style="display:flex">
          <span>Turn off<small>Needs a current code or a recovery code.</small></span>
          <span style="display:flex;gap:8px;flex:none">
            <input name="code" type="text" inputmode="numeric" placeholder="123456" autocomplete="one-time-code" class="in" style="width:110px">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button class="btn" type="submit">Disable</button>
          </span>
        </form>` : ''}
      </div>
      <div class="setcard">
        <div class="sec-h">API tokens</div>
        ${tokenRows}
        <form method="post" action="/profile/token/new" class="kv" style="display:flex">
          <span>New token<small>Read-only, and only these GET paths: ${escapeHtml([...(readPaths || TOKEN_READ_PATHS)].join(', '))}. Nothing else on the panel opens to a token.</small></span>
          <span style="display:flex;gap:8px;flex:none">
            <input name="name" type="text" placeholder="what is it for" maxlength="30" required class="in" style="width:150px">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button class="btn primary" type="submit">Generate</button>
          </span>
        </form>
      </div>
    </div>
    ${freshToken ? COPY_SCRIPT : ''}`);
}
