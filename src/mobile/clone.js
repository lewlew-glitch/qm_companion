// Reset copied mobile authority once per QM_CLONE_AS_NEW nonce.

import { existsSync } from 'node:fs';

import { config } from '../config.js';
import { addAudit } from '../store.js';
import { classifyMobileCertificate, rotateMobileCertificate } from './cert.js';
import { parseAdvertisedOrigin } from './origin.js';
import { MOBILE_STATE_FILE, freshMobileState, loadMobileState, saveMobileState, updateMobileState } from './store.js';

export const CLONE_ENV = 'QM_CLONE_AS_NEW';
export const CLONE_NONCE_HINT = 'openssl rand -hex 16';
const NONCE_RE = /^[0-9a-f]{32}$/;

const defaultLog = (line) => process.stdout.write(line);

/** Accept 128-bit lowercase hexadecimal nonces. */
export function parseCloneNonce(value) {
  if (typeof value !== 'string' || !NONCE_RE.test(value)) {
    return { ok: false, error: `${CLONE_ENV} must be exactly 32 hex characters (generate one with \`${CLONE_NONCE_HINT}\`); nothing was reset` };
  }
  return { ok: true, nonce: value };
}

function audit(line) {
  try {
    addAudit(line);
  } catch {
    // Audit persistence is best-effort; sidecar state is authoritative.
  }
}

// Select a host for managed certificate regeneration.
function certificateHost(record) {
  const origin = parseAdvertisedOrigin(process.env.QM_ADVERTISED_ORIGIN);
  if (origin.ok) return origin.host;
  return typeof record?.host === 'string' && record.host ? record.host : null;
}

/** Regenerate managed TLS under the certificate lock, creating missing material when possible. */
export function regenerateGeneratedCertificate() {
  // Settle staging before classifying certificate ownership.
  const found = classifyMobileCertificate(config.dataDir);
  // Refuse classification while another process holds the TLS lock.
  if (found.locked) {
    return { ok: false, reason: `the TLS material could not be classified: ${found.locked === 'QM_CERT_LOCK_TIMEOUT' ? 'another process is holding the TLS lock' : 'an interrupted certificate write could not be settled'}` };
  }
  if (!found.present) {
    // Generate a fresh leaf when no material exists and a usable host is available.
    const freshHost = certificateHost(null);
    if (!freshHost) return { ok: true, outcome: 'absent' };
    const made = rotateMobileCertificate({ dataDir: config.dataDir, host: freshHost });
    if (!made.ok) return { ok: false, reason: made.reason };
    return { ok: true, outcome: 'regenerated', host: freshHost, fingerprint: made.fingerprint, previousFingerprint: null };
  }
  if (found.source !== 'generated') return { ok: true, outcome: 'owner', fingerprint: found.fingerprint };
  const host = certificateHost(found.record);
  if (!host) return { ok: false, reason: 'the generated certificate cannot be regenerated: QM_ADVERTISED_ORIGIN is not set and the record names no host' };
  const rotated = rotateMobileCertificate({ dataDir: config.dataDir, host });
  if (!rotated.ok) {
    if (rotated.code === 'owner') return { ok: true, outcome: 'owner', fingerprint: found.fingerprint };
    return { ok: false, reason: rotated.reason };
  }
  return { ok: true, outcome: 'regenerated', host, fingerprint: rotated.fingerprint, previousFingerprint: rotated.previousFingerprint };
}

function describeTls(tls) {
  if (tls.outcome === 'regenerated') return `regenerated the certificate for ${tls.host} (sha256 ${tls.fingerprint.slice(0, 16)}...); every phone must pair again`;
  if (tls.outcome === 'owner') return 'the certificate is owner-supplied and was left in place; replace mobile.crt and mobile.key yourself, then re-pair every phone';
  return 'no certificate exists yet; the listener generates one on its first start';
}

// Complete pending TLS replacement before clearing tlsResetPending.
function completeTlsReset(log) {
  const tls = regenerateGeneratedCertificate();
  if (!tls.ok) {
    log(`  mobile api: clone-as-new is unfinished, ${tls.reason}; the mobile listener stays off until the next start completes it\n`);
    return { ok: false, reason: tls.reason, tls };
  }
  try {
    updateMobileState((state) => { state.tlsResetPending = false; });
  } catch (error) {
    log(`  mobile api: clone-as-new is unfinished (${error.message})\n`);
    return { ok: false, reason: error.message, tls };
  }
  log(`  mobile api: clone-as-new ${describeTls(tls)}\n`);
  if (tls.outcome === 'regenerated') audit(`mobile: clone-as-new regenerated the listener certificate (sha256 ${tls.fingerprint})`);
  return { ok: true, tls };
}

/** Finish a pending TLS reset before listener startup without creating a sidecar. */
export function finishPendingTlsReset({ log = defaultLog } = {}) {
  if (!existsSync(MOBILE_STATE_FILE)) return { ok: true, pending: false, listenerAllowed: true };
  let state;
  try {
    state = loadMobileState();
  } catch (error) {
    // Unreadable sidecar state is handled by listener startup.
    return { ok: false, pending: false, listenerAllowed: true, reason: error.message };
  }
  if (!state.tlsResetPending) return { ok: true, pending: false, listenerAllowed: true };
  log('  mobile api: clone-as-new was interrupted before the TLS step; finishing it now\n');
  const done = completeTlsReset(log);
  return { ok: done.ok, pending: true, listenerAllowed: done.ok, reason: done.reason, tls: done.tls };
}

/** Apply a nonce-bound clone reset after completing pending TLS work. */
export function applyCloneAsNew(nonce, { log = defaultLog } = {}) {
  const parsed = parseCloneNonce(nonce);
  if (!parsed.ok) {
    log(`  mobile api: clone-as-new refused (${parsed.error})\n`);
    return { ok: false, applied: false, inert: false, listenerAllowed: false, reason: parsed.error };
  }
  let current;
  try {
    current = loadMobileState(); // creates the sidecar on a first boot; fails closed when corrupt
  } catch (error) {
    log(`  mobile api: clone-as-new refused (${error.message})\n`);
    return { ok: false, applied: false, inert: false, listenerAllowed: false, reason: error.message };
  }
  if (current.consumedCloneNonce === parsed.nonce) {
    if (current.tlsResetPending) {
      log(`  mobile api: clone-as-new nonce already consumed; finishing the interrupted TLS step\n`);
      const done = completeTlsReset(log);
      return { ok: done.ok, applied: false, inert: true, listenerAllowed: done.ok, reason: done.reason, mobileInstallationId: current.mobileInstallationId, fingerprint: current.identity.fingerprint, tls: done.tls };
    }
    log(`  mobile api: clone-as-new nonce already consumed; nothing changed (remove ${CLONE_ENV} from the Compose file)\n`);
    return { ok: true, applied: false, inert: true, listenerAllowed: true, mobileInstallationId: current.mobileInstallationId, fingerprint: current.identity.fingerprint };
  }
  // Commit the replacement identity atomically with tlsResetPending set.
  let next;
  try {
    next = saveMobileState(freshMobileState({ consumedCloneNonce: parsed.nonce, tlsResetPending: true }));
  } catch (error) {
    // Resume TLS work after restart if commit durability is uncertain.
    log(`  mobile api: clone-as-new ${error.code === 'QM_MOBILE_STATE_DURABILITY_UNCERTAIN' ? 'committed but could not continue' : 'refused'} (${error.message})\n`);
    return { ok: false, applied: error.code === 'QM_MOBILE_STATE_DURABILITY_UNCERTAIN', inert: false, listenerAllowed: false, reason: error.message };
  }
  log(`  mobile api: clone-as-new applied; this Companion is now mobile installation ${next.mobileInstallationId} (identity ${next.identity.fingerprint.slice(0, 16)}...), ${current.devices.length} device${current.devices.length === 1 ? '' : 's'} forgotten\n`);
  audit(`mobile: clone-as-new applied; new mobile installation ${next.mobileInstallationId}, identity ${next.identity.fingerprint}, ${current.devices.length} device(s) forgotten`);
  // Complete certificate replacement and clear the pending flag.
  const done = completeTlsReset(log);
  return { ok: done.ok, applied: true, inert: false, listenerAllowed: done.ok, reason: done.reason, mobileInstallationId: next.mobileInstallationId, fingerprint: next.identity.fingerprint, tls: done.tls };
}

/** Run clone recovery and return whether listener startup is allowed. */
export function bootMobileClone({ env = process.env, log = defaultLog } = {}) {
  const raw = env[CLONE_ENV];
  if (raw === undefined || raw === '') return { ...finishPendingTlsReset({ log }), requested: false };
  return { ...applyCloneAsNew(raw, { log }), requested: true };
}
