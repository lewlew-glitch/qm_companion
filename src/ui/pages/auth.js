import { escapeHtml } from '../../http.js';
import { setupTokenWasGenerated } from '../../setup-token.js';
import { I, MARK } from '../bits.js';
import { doc, board, shell } from '../chrome.js';

// Setup-token prompt.
function setupTokenField(tokenWasGenerated) {
  const hint = tokenWasGenerated
    ? 'Companion generated this at first boot and printed it once, on the line reading "first-run setup token". Read it back with: docker logs qm-companion'
    : 'This is the SETUP_TOKEN you set in your compose file or .env. It is never printed to the log, so take it from there.';
  return `<div class="field">
    <label for="setup-token">Setup token</label>
    <input id="setup-token" name="setupToken" type="password" placeholder="${tokenWasGenerated ? 'Paste the token from the server log' : 'Paste your SETUP_TOKEN'}"
      autocomplete="one-time-code" autofocus required>
    <p class="note" style="color:var(--fg-2);font-size:11.5px;line-height:1.5;margin:8px 0 0">${escapeHtml(hint)}</p>
  </div>`;
}

// Format the remaining lockout time.
export function lockWait(ms) {
  const seconds = Math.ceil(Math.max(0, Number(ms) || 0) / 1000);
  if (seconds < 60) return 'under a minute';
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function lockedNotice(lockedForMs) {
  return `<div class="err">Too many sign-in attempts from this address. Sign-in reopens on its own in ${escapeHtml(lockWait(lockedForMs))}.<br>
    If that is your own address and you cannot wait, clear it with: <code class="mono">docker restart qm-companion</code></div>`;
}

function authCard(kind, error, formToken = '', { tokenWasGenerated = true, lockedForMs = 0 } = {}) {
  const setup = kind === 'setup';
  const locked = !setup && lockedForMs > 0;
  const off = locked ? ' disabled' : '';
  return doc(setup ? 'Get started' : 'Sign in', null, `
<div class="auth"><form class="card" method="post" action="${setup ? '/setup' : '/login'}">
  <div class="mark">${MARK}</div>
  <div class="wm">Quartermaster Companion</div>
  <h1>${setup ? 'Welcome' : 'Welcome back'}</h1>
  <p class="lead">${setup ? 'Set an admin password to protect the panel and every key it reaches.' : 'Sign in to manage your stack.'}</p>
  ${locked ? lockedNotice(lockedForMs) : error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  ${setup ? setupTokenField(tokenWasGenerated) : ''}
  ${setup ? '' : `<input type="hidden" name="formToken" value="${escapeHtml(formToken)}">`}
  <div class="field">
    <label for="pw">${setup ? 'New password' : 'Password'}</label>
    <input id="pw" name="password" type="password" placeholder="${setup ? 'At least 10 characters' : locked ? 'Locked for now' : 'Enter your password'}"
      autocomplete="${setup ? 'new-password' : 'current-password'}" ${setup || locked ? '' : 'autofocus'} required maxlength="256" ${setup ? 'minlength="10"' : ''}${off}>
  </div>
  <button class="btn primary" type="submit"${off}>${I.arrowIn}${setup ? 'Create and continue' : locked ? 'Locked' : 'Sign in'}</button>
  <p class="foot">Quartermaster Docker &amp; media companion</p>
</form></div>`);
}

// Render the current lockout duration.
export function loginPage(error, formToken, lockedForMs = 0) {
  return authCard('login', error, formToken, { lockedForMs });
}

export function setupPage(error, tokenWasGenerated = setupTokenWasGenerated) {
  return authCard('setup', error, '', { tokenWasGenerated });
}

// Two-factor challenge.
export function mfaPage(ticket, error, formToken = '') {
  return doc('Two-factor', null, `
<div class="auth"><form class="card" method="post" action="/login/mfa">
  <div class="mark">${MARK}</div>
  <div class="wm">Quartermaster Companion</div>
  <h1>Two-factor</h1>
  <p class="lead">Enter the six-digit code from your authenticator app, or a recovery code.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
  <input type="hidden" name="formToken" value="${escapeHtml(formToken)}">
  <div class="field">
    <label for="code">Code</label>
    <input id="code" name="code" type="text" inputmode="numeric" placeholder="123456" autocomplete="one-time-code" autofocus required>
  </div>
  <button class="btn primary" type="submit">${I.arrowIn}Verify</button>
  <p class="foot">Codes rotate every 30 seconds</p>
</form></div>`);
}

export function mfaSetupPage(qrDataUrl, secretB32, csrf, error) {
  return shell('settings', csrf, null, `
    ${board('settings', 'Two-factor setup', '', null)}
    <p class="sub">Scan the code with any authenticator app (or type the secret in), then confirm with the six digits it shows. Recovery codes come next - two-factor only switches on after you confirm.</p>
    <div class="pair-wrap">
      <div>
        <div class="qr"><img src="${qrDataUrl}" alt="Authenticator enrolment code"></div>
        <div class="passbox"><span>Manual entry</span><code>${escapeHtml(secretB32)}</code></div>
      </div>
      <div>
        ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
        <form method="post" action="/settings/mfa/enable" style="max-width:320px">
          <div class="field">
            <label for="code">Code from the app</label>
            <input id="code" name="code" type="text" inputmode="numeric" placeholder="123456" autocomplete="one-time-code" autofocus required>
          </div>
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button class="btn primary" type="submit">Turn on two-factor</button>
          <a class="btn" href="/settings" style="margin-left:8px">Cancel</a>
        </form>
      </div>
    </div>`);
}

export function mfaRecoveryPage(codes, csrf) {
  const rows = codes.map((c) => `<div class="kv"><b class="mono" style="font-size:14px">${escapeHtml(c.slice(0, 5))}-${escapeHtml(c.slice(5))}</b></div>`).join('');
  return shell('settings', csrf, null, `
    ${board('settings', 'Recovery codes', '', null)}
    <p class="sub">Two-factor is on. These eight codes are shown once and each works once - save them somewhere safe. A recovery code signs you in if the phone is gone.</p>
    <div class="setgrid"><div class="setcard">${rows}</div></div>
    <div class="rightrow" style="justify-content:flex-start;margin-top:16px"><a class="btn primary" href="/settings">I have saved them</a></div>`);
}
