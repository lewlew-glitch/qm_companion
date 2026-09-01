import { mountedConfigKind } from '../../detect.js';
import { escapeHtml } from '../../http.js';
import { labelFor } from '../../kinds.js';
import { I } from '../bits.js';

// Client copy of the credential status labels.
export const CONFIGURE_WORDING = {
  included: 'Included automatically',
  'not-required': 'No key needed',
  'sign-in': 'Sign in after pairing',
  'key-and-secret': 'Key and secret needed',
  'missing-key': 'Needs service key',
  conflict: 'Check key sources',
};


export function deferredCredentialMarkup(kind, state) {
  const label = labelFor(kind);
  if (state === 'sign-in') {
    return `<div class="pair-ladder" data-next-step>
      <span class="lad-hint"><b>Next step:</b> Companion transfers the reviewed addresses but no account password. After importing, open ${escapeHtml(label)} in Quartermaster and complete its sign-in.</span>
    </div>`;
  }
  if (state === 'key-and-secret') {
    return `<div class="pair-ladder" data-next-step>
      <span class="lad-hint"><b>Next step:</b> Open ${escapeHtml(label)} and create an API key plus API secret. Companion cannot recover a complete pair, so neither credential is included. After importing, add both in Quartermaster.</span>
      <div class="lad-actions"><a class="btn pair-open" data-open target="_blank" rel="noopener">Open ${escapeHtml(label)}</a></div>
    </div>`;
  }
  return '';
}

function pasteKeyMarkup(kind, note, openLabel = 'Open settings page', extra = '') {
  const label = labelFor(kind);
  return `<div class="pair-ladder" data-ladder>
    <span class="lad-hint">${escapeHtml(note)}</span>
    <div class="lad-actions pair-key-entry">
      <a class="btn pair-open" data-open target="_blank" rel="noopener">${escapeHtml(openLabel)}</a>
      <label class="pair-key-field"><span>${escapeHtml(label)} API key or token</span><input class="in" data-manual-key type="password" maxlength="16384" autocomplete="new-password" spellcheck="false"></label>
      <button type="button" class="btn primary" data-save-key>Save key</button>
      <span class="pair-key-status" data-key-status role="status" aria-live="polite"></span>
    </div>${extra}
  </div>`;
}

// Render read-only config mounting instructions for services that support file discovery.
function mountPanelMarkup(kind, fileRule, instanceName) {
  const label = labelFor(kind);
  const rule = fileRule || {};
  const target = rule.target || `/stack/${kind}`;
  const fileName = rule.mountedName || 'its config file';
  const instance = String(instanceName || '').trim().toLowerCase();
  const compatibleInstance = mountedConfigKind(instance) === kind;
  if (instance && !compatibleInstance) {
    return `<p>Automatic file matching is unavailable for this container name. Paste the ${escapeHtml(label)} API key above instead.</p>`;
  }
  const folder = compatibleInstance ? instance : kind;
  const destination = `${compatibleInstance ? `/stack/${folder}` : target}/${fileName}`;
  const line = `- /your/host/path/to/${folder}/${fileName}:${destination}:ro`;
  return `<details class="mountpanel">
      <summary>Or mount ${escapeHtml(fileName)} and let Companion read it</summary>
      <p>Map only ${escapeHtml(label)}'s <code>${escapeHtml(fileName)}</code> read only to <code>${escapeHtml(destination)}</code>. For Compose, replace the first path below with the exact file on the host. In Unraid, add the same two paths as a read-only Path:</p>
      <div class="copyline"><code class="mono" data-copytext="${escapeHtml(line)}">${escapeHtml(line)}</code><button type="button" class="copybtn" data-copy>Copy</button></div>
      <p>Use a separate folder beneath <code>/stack</code> for each extra instance and keep its name aligned with the container name. Recreate Companion, then scan again.</p>
    </details>`;
}

// Render the available credential methods for one service.
export function ladderMarkup(kind, rung, control, mintEnabledKinds = [], instanceName = '') {
  const enabledKinds = Array.isArray(mintEnabledKinds) ? mintEnabledKinds : [];
  const made = `<div class="key-made" data-made>${I.check}<span>Key saved in Companion</span><button type="button" data-forget>Remove</button></div>`;
  if (rung.class === 'file') {
    const label = labelFor(kind);
    const read = control
      ? `<div class="lad-actions"><button type="button" class="btn primary" data-read>Read key from container</button></div>`
      : `<span class="lad-hint">To read this key from the ${escapeHtml(label)} container, enable Management + shell under Docker access and reopen this page.</span>`;
    return `${pasteKeyMarkup(
      kind,
      `Create or copy the API key in ${label}, then paste it here. Companion seals it and includes it in this scan.`,
      'Open settings page',
      `${read}${mountPanelMarkup(kind, rung.fileRule, instanceName)}`,
    )}${made}`;
  }
  if (rung.class === 'mint' && enabledKinds.includes(kind)) {
    // Offer automatic creation and manual paste.
    const label = labelFor(kind);
    return `<div class="pair-ladder" data-ladder>
      <span class="lad-hint">${escapeHtml(rung.mint.note)} Review how the sign-in and key are handled before you continue, or paste a key you made yourself.</span>
      <div class="lad-actions"><button type="button" class="btn primary" data-mint-btn>Create key for me</button></div>
      <div class="lad-or">or paste your own</div>
      <div class="lad-actions pair-key-entry">
        <a class="btn pair-open" data-open target="_blank" rel="noopener">Open settings page</a>
        <label class="pair-key-field"><span>${escapeHtml(label)} API key or token</span><input class="in" data-manual-key type="password" maxlength="16384" autocomplete="new-password" spellcheck="false"></label>
        <button type="button" class="btn" data-save-key>Save key</button>
        <span class="pair-key-status" data-key-status role="status" aria-live="polite"></span>
      </div>
    </div>${made}`;
  }
  if (rung.class === 'mint') {
    return `${pasteKeyMarkup(
      kind,
      `Create an API key in ${labelFor(kind)}, then paste it here. Companion encrypts it for this setup.`,
    )}${made}`;
  }
  if (kind === 'homeassistant') {
    return `${pasteKeyMarkup(
      kind,
      'Create a Long-Lived Access Token in your Home Assistant profile, then paste it here. Companion seals it and includes it in this scan.',
      'Open token settings',
    )}${made}`;
  }
  return `${pasteKeyMarkup(
    kind,
    `Create or copy the API key in ${labelFor(kind)}, then paste it here. Companion seals it and includes it in this scan.`,
  )}${made}`;
}
