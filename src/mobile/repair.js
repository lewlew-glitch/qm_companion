#!/usr/bin/env node
// Read-only mobile-state diagnostic.
// Exit codes: 0 healthy, 1 invalid, 2 not provisioned.
import { X509Certificate, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';

import { config } from '../config.js';
import { getInstallationId } from '../store.js';
import { certificateCoversHost, checkMaterial, fingerprintOf, tlsPaths } from './cert.js';
import { mobileListenerPlan } from './config.js';
import { MOBILE_STATE_FILE, loadMobileState } from './store.js';

/** Compose files in required deployment order. */
export const REPAIR_COMPOSE_FILES = ['docker-compose.example.yml', 'docker-compose.mobile.yml'];
const COMPOSE_FILE_FLAGS = REPAIR_COMPOSE_FILES.map((file) => `-f ${file}`).join(' ');

/** Stopped-container diagnostic command. */
export const REPAIR_COMMAND = `docker compose ${COMPOSE_FILE_FLAGS} run --rm --no-deps --entrypoint node companion src/mobile/repair.js`;

/** Stopped-container certificate rotation command. */
const ROTATE_OUT_OF_BAND = `docker compose ${COMPOSE_FILE_FLAGS} run --rm --no-deps --entrypoint node companion src/mobile/rotate-cert.js --confirm`;

/** Panel-state MAC context for non-mutating verification. */
const STATE_MAC_CONTEXT = 'qm-companion:state:v2\0';

const STATE_FILE = join(config.dataDir, 'qm-companion.json');
const ACCESS_FILE = join(config.dataDir, 'qm-docker-access-v1.json');
const MARKER_FILE = join(config.dataDir, 'qm-companion.v1-migration-used');
const ACCESS_CONTEXT = 'qm-companion:docker-access:v1\0';
const MARKER_CONTEXT = 'qm-companion:state:v1-migration-consumed\0';

const out = (line) => process.stdout.write(`${line}\n`);
const row = (label, value) => out(`${label.padEnd(24)} ${value}`);

/** Stable diagnostic identifiers. */
const FAILURE_ID = Object.freeze({
  companionLegacy: 'S01',
  companionCron: 'S02',
  companionAuth: 'S03',
  companionFormat: 'S04',
  companionRead: 'S05',
  accessRead: 'S06',
  markerRead: 'S07',
  listenerPlan: 'C01',
  tlsLock: 'T01',
  tlsWriteInterrupted: 'T02',
  tlsInstallPending: 'T03',
  tlsCertificateInvalid: 'T04',
  tlsCertificateRead: 'T05',
  tlsKeyMissing: 'T06',
  tlsKeyRead: 'T07',
  tlsKeyMismatch: 'T08',
  tlsExpired: 'T09',
  tlsNotYetValid: 'T10',
  tlsHostMismatch: 'T11',
  tlsContext: 'T12',
  mobileCronHeld: 'M01',
  mobileLegacyHeld: 'M02',
  mobileBindingMissing: 'M03',
  mobilePanelBlocked: 'M04',
  mobileAuth: 'M05',
  mobileRead: 'M06',
  mobileTlsReset: 'M07',
  keyMismatch: 'A01',
  keyOrDamage: 'A02',
  fileDamage: 'A03',
  singleFileAmbiguous: 'A04',
  readOnlyViolation: 'R01',
});

/** Diagnostic failures without stored values. */
const failures = [];
const fail = (id, reason) => failures.push({ id, reason });
/** Set when mobile support is not provisioned. */
let unprovisioned = false;

/** Files checked for mutation before exit. */
const WATCHED = [STATE_FILE, MOBILE_STATE_FILE, ACCESS_FILE, MARKER_FILE];
const digestOf = (path) => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'absent';
  }
};
const before = WATCHED.map(digestOf);

/** Extract a bounded store error reason. */
const detailOf = (error) => {
  const found = /unreadable \(([^)]*)\)/.exec((error && error.message) || '');
  return found ? found[1] : 'the reason was not named';
};
// Track authentication separately from structural read failures.
const ledger = [];
const record = (label, verdict, detail) => {
  ledger.push({ label, verdict });
  row(`${label}:`, detail);
};
const names = (rows) => rows.map((entry) => entry.label).join(', ');

/** Verify an envelope MAC without loading its payload. */
function envelopeVerdict(path, context) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { verdict: 'absent' };
    return { verdict: 'broken', detail: `could not be read (${error.code || 'error'})` };
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { verdict: 'broken', detail: 'is not valid JSON' };
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string'
    || !/^[0-9a-f]{64}$/i.test(envelope.mac)) {
    return { verdict: 'broken', detail: 'does not have the expected envelope shape' };
  }
  return macVerdict(createHmac('sha256', config.stateKey).update(context).update(envelope.payload, 'utf8').digest(), envelope.mac);
}

/** The v1 migration marker is a bare authenticated tag rather than an envelope. */
function markerVerdict(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (error && error.code === 'ENOENT') return { verdict: 'absent' };
    return { verdict: 'broken', detail: `could not be read (${error.code || 'error'})` };
  }
  if (!/^[0-9a-f]{64}$/i.test(text)) return { verdict: 'broken', detail: 'is not a 64 character marker' };
  return macVerdict(createHmac('sha256', config.stateKey).update(MARKER_CONTEXT).digest(), text);
}

function macVerdict(expected, suppliedHex) {
  const supplied = Buffer.from(suppliedHex, 'hex');
  const ok = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  return { verdict: ok ? 'healthy' : 'auth' };
}

function reportSidecar(label, file, verdict, readFailureId) {
  if (verdict.verdict === 'absent') {
    ledger.push({ label, verdict: 'absent' });
    row(`${label}:`, `none on this volume (${file})`);
    return;
  }
  if (verdict.verdict === 'broken') {
    record(label, 'broken', `unreadable; the file ${verdict.detail}`);
    fail(readFailureId, `The ${label.toLowerCase()} at ${file} ${verdict.detail}.`);
    return;
  }
  record(label, verdict.verdict, verdict.verdict === 'healthy'
    ? 'healthy; it authenticates with this SECRET_KEY'
    : 'present; authentication failed for this SECRET_KEY');
}

/** Detect v1 state without invoking migration. */
function isLegacyV1(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).version === 1;
  } catch {
    return false;
  }
}

/** Detect v2 state that a loader would rewrite. */
function plaintextCronEnvelope(path) {
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.version !== 2
    || typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string') {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(envelope.payload);
  } catch {
    return null;
  }
  return payload && typeof payload === 'object' && Array.isArray(payload.cron) ? envelope : null;
}

/** Classify tls/pending as none, incomplete, or complete without taking the lock. */
function pendingGenerationState(paths) {
  if (!existsSync(paths.pendingDir)) return 'none';
  if (!existsSync(paths.pendingKeyPath) || !existsSync(paths.pendingCertPath) || !existsSync(paths.pendingRecordPath)) {
    return 'incomplete';
  }
  let certPem;
  let keyPem;
  let recordText;
  try {
    certPem = readFileSync(paths.pendingCertPath, 'utf8');
    keyPem = readFileSync(paths.pendingKeyPath, 'utf8');
    recordText = readFileSync(paths.pendingRecordPath, 'utf8');
  } catch {
    return 'incomplete';
  }
  let fingerprint;
  try {
    checkMaterial(certPem, keyPem);
    fingerprint = fingerprintOf(certPem);
  } catch {
    return 'incomplete';
  }
  let record;
  try {
    record = JSON.parse(recordText);
  } catch {
    return 'incomplete';
  }
  if (!record || typeof record !== 'object' || record.generated !== true || record.fingerprint !== fingerprint) {
    return 'incomplete';
  }
  return 'complete';
}

function certificateRecord(recordPath) {
  if (!existsSync(recordPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Classify certificate files only when no certificate lock exists. */
function describeCertificateReadOnly(paths) {
  const unread = { present: false, fingerprint: null, source: null, record: null, paths };
  if (existsSync(paths.lockPath)) return { ...unread, pending: 'unknown', locked: true };
  const pending = pendingGenerationState(paths);
  if (!existsSync(paths.certPath)) return { ...unread, pending, locked: false };
  let fingerprint = null;
  try {
    fingerprint = fingerprintOf(readFileSync(paths.certPath));
  } catch {
    fingerprint = null;
  }
  const record = certificateRecord(paths.recordPath);
  const generated = fingerprint !== null && record !== null && record.generated === true
    && record.fingerprint === fingerprint;
  return {
    present: true,
    fingerprint,
    source: generated ? 'generated' : 'owner',
    record: generated ? record : null,
    pending,
    locked: false,
    paths,
  };
}

out('Repair command for a stopped or crash-looping container:');
out(`  ${REPAIR_COMMAND}`);
out('Use the deployment\'s -f files in the same order, with docker-compose.mobile.yml last.');
out('The mobile overlay supplies MOBILE_API_ENABLED, MOBILE_PORT and QM_ADVERTISED_ORIGIN; omitting');
out('it produces an incomplete listener diagnosis. Use `docker compose run`; `docker exec` requires');
out('a running container.');
out('');

// Companion state and installation binding.
let panelReadable = false;
/** Set when opening state would trigger a rewrite. */
let panelHeldForPlaintextCron = false;
const plaintextCron = existsSync(STATE_FILE) ? plaintextCronEnvelope(STATE_FILE) : null;
if (!existsSync(STATE_FILE)) {
  record('Companion state', 'absent', `none yet (${STATE_FILE} is created on the first start)`);
  unprovisioned = true;
} else if (isLegacyV1(STATE_FILE)) {
  record('Companion state', 'held', 'present; legacy v1 state is not opened by this read-only check');
  fail(FAILURE_ID.companionLegacy, `Companion state at ${STATE_FILE} uses legacy v1 format. Start Companion once with MIGRATE_V1_STATE=true, then rerun this check.`);
} else if (plaintextCron !== null) {
  // Verify only the MAC when loader access would rewrite state.
  const verdict = /^[0-9a-f]{64}$/i.test(plaintextCron.mac)
    ? macVerdict(
      createHmac('sha256', config.stateKey).update(STATE_MAC_CONTEXT).update(plaintextCron.payload, 'utf8').digest(),
      plaintextCron.mac,
    )
    : { verdict: 'broken' };
  if (verdict.verdict === 'healthy') {
    panelHeldForPlaintextCron = true;
    record('Companion state', 'healthy', 'authenticated; not opened because loading would rewrite legacy plaintext cron data');
    out('Action: Start Companion once to seal cron data, then rerun this check. No data or phone pairings are removed.');
    fail(FAILURE_ID.companionCron, `Companion state at ${STATE_FILE} still has legacy plaintext cron data and requires one normal start.`);
  } else if (verdict.verdict === 'auth') {
    record('Companion state', 'auth', 'present; authentication failed for this SECRET_KEY');
    fail(FAILURE_ID.companionAuth, `Companion state at ${STATE_FILE} rejected this SECRET_KEY.`);
  } else {
    record('Companion state', 'broken', 'unreadable; invalid authenticated-envelope structure');
    fail(FAILURE_ID.companionFormat, `Companion state at ${STATE_FILE} has an invalid authenticated-envelope structure.`);
  }
} else {
  try {
    getInstallationId();
    panelReadable = true;
    record('Companion state', 'healthy', 'readable and authenticated with this SECRET_KEY');
  } catch (error) {
    const code = (error && error.code) || 'error';
    const detail = code === 'QM_STATE_INVALID' ? detailOf(error) : `could not be opened (${code})`;
    const wrongKey = detail === 'authentication failed';
    record('Companion state', wrongKey ? 'auth' : 'broken', `unreadable (${detail})`);
    fail(wrongKey ? FAILURE_ID.companionAuth : FAILURE_ID.companionRead, wrongKey
      ? `Companion state at ${STATE_FILE} rejected this SECRET_KEY.`
      : `Companion state at ${STATE_FILE} is unreadable (${detail}).`);
  }
}

reportSidecar('Docker access sidecar', ACCESS_FILE, envelopeVerdict(ACCESS_FILE, ACCESS_CONTEXT), FAILURE_ID.accessRead);
reportSidecar('V1 migration marker', MARKER_FILE, markerVerdict(MARKER_FILE), FAILURE_ID.markerRead);

// Listener plan, using the same configuration validation as startup.
const plan = mobileListenerPlan();
if (!plan.ok) {
  row('Mobile listener plan:', 'refused');
  row('Reason:', plan.reason);
  fail(FAILURE_ID.listenerPlan, `Listener configuration was refused: ${plan.reason}`);
} else {
  row('Mobile listener plan:', panelReadable
    ? 'would start'
    : panelHeldForPlaintextCron
      ? 'not assessed; configuration is valid, but authenticated Companion state was left unopened'
      : 'not assessed; configuration is valid, but Companion state is unreadable');
  row('Advertised origin:', plan.origin);
  row('Listen address:', `${plan.bind}:${plan.port}`);
  if (panelReadable) row('Pairing enabled:', plan.enrolment ? 'yes' : 'no');
}
const origin = plan.ok ? { ok: true, origin: plan.origin, host: plan.host } : { ok: false };

// TLS material does not depend on SECRET_KEY.
let tlsLoads = false;
const tls = describeCertificateReadOnly(tlsPaths(config.dataDir));
if (tls.locked) {
  // Lock ownership cannot be classified without mutation.
  row('TLS material:', `not read; certificate lock present at ${tls.paths.lockPath}`);
  out('Cause: A certificate transaction is active or a previous process left its lock behind.');
  out('Action: Wait for an active rotation, or start Companion to clear an abandoned lock, then rerun.');
  fail(FAILURE_ID.tlsLock, `TLS material is unverified while the certificate lock exists at ${tls.paths.lockPath}.`);
} else if (tls.pending === 'incomplete') {
  row('TLS write pending:', `yes; an interrupted certificate write is staged under ${tls.paths.pendingDir} and is discarded on the next start`);
  fail(FAILURE_ID.tlsWriteInterrupted, 'An interrupted certificate write is staged; start Companion to discard it.');
} else if (tls.pending === 'complete') {
  row('TLS write pending:', `yes; a committed certificate generation under ${tls.paths.pendingDir} is installed on the next start`);
  fail(FAILURE_ID.tlsInstallPending, 'A committed certificate generation is awaiting installation; start Companion to install it.');
}

if (tls.locked) {
  // Do not classify material that could not be read.
} else if (!tls.present) {
  row('TLS certificate:', `none yet under ${tls.paths.dir} (generated on the listener's first start)`);
  unprovisioned = true;
} else if (tls.fingerprint === null) {
  row('TLS certificate:', `${tls.paths.certPath} is not a readable X.509 certificate; replace it (owner-supplied) or remove the pair so one is generated`);
  fail(FAILURE_ID.tlsCertificateInvalid, 'mobile.crt is not a readable X.509 certificate.');
} else {
  row('TLS leaf fingerprint:', tls.fingerprint);
  row('TLS source:', tls.source === 'generated' ? `generated by Companion for ${tls.record.host}` : 'owner-supplied (mobile.crt + mobile.key)');
  // Use the out-of-band rotation command for stopped containers.
  const remedy = tls.source === 'generated' ? `rotate it with \`${ROTATE_OUT_OF_BAND}\`` : 'replace mobile.crt and mobile.key';

  let certPem = null;
  let keyPem = null;
  try {
    certPem = readFileSync(tls.paths.certPath, 'utf8');
  } catch (error) {
    fail(FAILURE_ID.tlsCertificateRead, `mobile.crt could not be read (${error.code || 'error'}).`);
  }
  if (!existsSync(tls.paths.keyPath)) {
    row('TLS private key:', `missing at ${tls.paths.keyPath}; ${remedy} and re-pair every phone`);
    fail(FAILURE_ID.tlsKeyMissing, 'The private key mobile.key is missing.');
  } else {
    try {
      keyPem = readFileSync(tls.paths.keyPath, 'utf8');
    } catch (error) {
      row('TLS private key:', `unreadable (${error.code || 'error'})`);
      fail(FAILURE_ID.tlsKeyRead, `The private key mobile.key could not be read (${error.code || 'error'}).`);
    }
  }

  if (certPem !== null && keyPem !== null) {
    try {
      checkMaterial(certPem, keyPem);
      row('TLS key matches cert:', 'yes');
    } catch (error) {
      row('TLS key matches cert:', `no; ${error.message}`);
      fail(FAILURE_ID.tlsKeyMismatch, `TLS key check failed: ${error.message}.`);
    }
  }

  let leaf = null;
  try {
    leaf = new X509Certificate(certPem ?? '');
    row('TLS valid until:', new Date(leaf.validTo).toISOString());
  } catch {
    row('TLS valid until:', 'unknown (the certificate did not parse)');
    if (certPem !== null) fail(FAILURE_ID.tlsCertificateInvalid, 'mobile.crt is not a readable X.509 certificate.');
  }
  if (leaf) {
    const now = Date.now();
    const validTo = Date.parse(leaf.validTo);
    const validFrom = Date.parse(leaf.validFrom);
    if (Number.isFinite(validTo) && validTo < now) {
      row('TLS expiry:', `expired on ${new Date(validTo).toISOString()}; ${remedy} and re-pair every phone`);
      fail(FAILURE_ID.tlsExpired, `The certificate expired on ${new Date(validTo).toISOString()}.`);
    } else if (Number.isFinite(validFrom) && validFrom > now) {
      row('TLS expiry:', `not valid until ${new Date(validFrom).toISOString()}; check the server clock`);
      fail(FAILURE_ID.tlsNotYetValid, `The certificate is not valid until ${new Date(validFrom).toISOString()}.`);
    }
    if (origin.ok) {
      const covers = certificateCoversHost(leaf.toString(), origin.host);
      row('TLS names the origin:', covers ? 'yes' : `no; ${remedy} and re-pair every phone`);
      if (!covers) fail(FAILURE_ID.tlsHostMismatch, 'The certificate does not name the advertised host in its SAN.');
    }
  }

  // Validate material with the listener's TLS context shape.
  if (certPem !== null && keyPem !== null) {
    try {
      createSecureContext({ cert: certPem, key: keyPem, minVersion: 'TLSv1.2' });
      tlsLoads = true;
      row('TLS context loads:', 'yes');
    } catch (error) {
      row('TLS context loads:', `no; the HTTPS server would refuse this material (${error.code || 'error'})`);
      fail(FAILURE_ID.tlsContext, `The HTTPS server would refuse this TLS material (${error.code || 'error'}).`);
    }
  }
}

// Mobile sidecar and installation binding.
let state = null;
if (!existsSync(MOBILE_STATE_FILE)) {
  ledger.push({ label: 'Mobile state', verdict: 'absent' });
  row('Mobile state:', `none yet (${MOBILE_STATE_FILE} is created on the first start with the mobile profile)`);
  row('Installation binding:', 'nothing to bind yet; no mobile sidecar exists on this volume');
  unprovisioned = true;
} else if (panelHeldForPlaintextCron) {
  // Avoid sidecar loading when panel state would be rewritten.
  record('Mobile state', 'held', `present; not opened because ${STATE_FILE} requires a normal start before a read-only binding check`);
  row('Installation binding:', 'not assessed; the mobile sidecar has not been read and is not identified as faulty');
  fail(FAILURE_ID.mobileCronHeld, `Mobile state was left unopened until Companion seals legacy cron data in ${STATE_FILE}.`);
} else if (isLegacyV1(STATE_FILE)) {
  // Avoid the panel-state v1 migration path.
  record('Mobile state', 'held', `present; not opened because ${STATE_FILE} still uses legacy v1 format`);
  row('Installation binding:', 'not assessed; migrate Companion state before checking the sidecar binding');
  fail(FAILURE_ID.mobileLegacyHeld, `Mobile state was left unopened until legacy v1 state at ${STATE_FILE} is migrated.`);
} else if (!existsSync(STATE_FILE)) {
  record('Mobile state', 'held', 'present; not opened because its Companion state file is absent');
  row('Installation binding:', 'not available; the bound Companion state is missing');
  fail(FAILURE_ID.mobileBindingMissing, `Mobile state is present but ${STATE_FILE} is missing. Restore Companion state; keep the mobile sidecar.`);
} else {
  try {
    state = loadMobileState();
    record('Mobile state', 'healthy', 'readable, authenticated and consistent');
    row('Installation binding:', 'healthy; the mobile sidecar is bound to this Companion installation');
  } catch (error) {
    if (error && error.code === 'QM_STATE_INVALID') {
      // Authentication succeeded before binding resolution failed.
      record('Mobile state', 'healthy', 'authenticated; binding check stopped at unreadable Companion state');
      row('Installation binding:', 'not assessed; Companion state is unreadable, but the mobile sidecar authenticated');
      fail(FAILURE_ID.mobilePanelBlocked, 'Mobile state authenticated, but unreadable Companion state blocks its binding check.');
    } else {
      const detail = detailOf(error);
      const wrongKey = detail === 'authentication failed';
      const binding = detail === 'legacyInstallationId does not match this installation';
      record('Mobile state', wrongKey ? 'auth' : 'broken', `unreadable (${detail})`);
      row('Installation binding:', binding
        ? 'mismatch; this sidecar belongs to another Companion installation and requires deliberate clone-as-new replacement'
        : 'not assessed; the sidecar could not be opened far enough to check it');
      fail(wrongKey ? FAILURE_ID.mobileAuth : FAILURE_ID.mobileRead, wrongKey
        ? `Mobile state at ${MOBILE_STATE_FILE} rejected this SECRET_KEY.`
        : 'Mobile state could not be read.');
    }
    const detail = detailOf(error);
    out(`Mobile state error: ${detail}.`);
    if (!error || error.code !== 'QM_STATE_INVALID') {
      out('Scope: Owner account, browser and QMC1 are unaffected.');
    }
    if (detail !== 'authentication failed' && detail !== 'legacyInstallationId does not match this installation') {
      out('Action: Confirm the original SECRET_KEY first, then restore the file from this volume\'s backup if needed.');
    }
  }
}

if (state) {
  const active = state.devices.filter((device) => device.revokedAt === null).length;
  row('Mobile installation id:', state.mobileInstallationId);
  row('Identity fingerprint:', `${state.identity.fingerprint} (Ed25519, SHA-256 of the public key)`);
  row('Devices:', `${state.devices.length} (${active} active, ${state.devices.length - active} revoked)`);
  row('Spent pairing keys:', String(state.spentCapabilities.length));
  // Report nonce use without its value.
  row('Clone-as-new:', state.consumedCloneNonce ? 'a nonce has been consumed on this volume' : 'never reset');
  row('TLS reset pending:', state.tlsResetPending ? 'yes; the mobile listener stays off until a start finishes the clone-as-new TLS step' : 'no');
  if (state.tlsResetPending) fail(FAILURE_ID.mobileTlsReset, 'A clone-as-new TLS reset is unfinished; start Companion to finish it.');
}

// Cross-file authentication pattern.
const opened = ledger.filter((entry) => entry.verdict !== 'absent' && entry.verdict !== 'held');
const healthy = opened.filter((entry) => entry.verdict === 'healthy');
const rejected = opened.filter((entry) => entry.verdict === 'auth');
const broken = opened.filter((entry) => entry.verdict === 'broken');
// Structural damage is distinct from a MAC rejection.
row('Authenticated files:', opened.length === 0
  ? 'none opened on this volume yet, so the SECRET_KEY has not been tested against anything'
  : healthy.length
    ? `${names(healthy)} (${healthy.length} of the ${opened.length} opened here)`
    : rejected.length
      ? `none: ${names(rejected)} failed authentication${broken.length ? `, and ${names(broken)} could not be read far enough to try` : ''}`
      : `none tested: ${names(broken)} could not be read far enough to reach authentication`);

// Multiple MAC failures identify a key mismatch only when no file authenticates.
if (healthy.length === 0 && rejected.length > 1 && broken.length === 0) {
  out('');
  out('Diagnosis: SECRET_KEY mismatch; authenticated files are not corrupt.');
  out(`Cause: The current key was rejected by ${names(rejected)}.`);
  if (tlsLoads) out('Evidence: Key-independent TLS material loaded successfully.');
  out('Warning: Keep qm-mobile-v1.json. Deleting it destroys every phone pairing and cannot fix a key mismatch.');
  out('Action: Restore this installation\'s original SECRET_KEY and start Companion. If it is lost, restore a backup made with that key.');
  fail(FAILURE_ID.keyMismatch, 'All authenticated files rejected the current SECRET_KEY. Restore the original key.');
} else if (healthy.length === 0 && rejected.length > 0 && broken.length > 0) {
  // Preserve ambiguity between key mismatch and structural damage.
  out('');
  out('Diagnosis: SECRET_KEY mismatch and file damage are both possible.');
  out(`Cause: ${names(rejected)} failed authentication; ${names(broken)} was unreadable before authentication.`);
  if (tlsLoads) out('Evidence: Key-independent TLS material loaded successfully.');
  out('Warning: Keep qm-mobile-v1.json. Deleting it destroys every phone pairing and does not resolve either cause.');
  out('Action: Check the original SECRET_KEY first. If it is correct, restore the damaged files from a backup made with that key.');
  fail(FAILURE_ID.keyOrDamage, `No file authenticated and ${names(broken)} is damaged. Check the key before restoring files.`);
} else if (healthy.length > 0 && (rejected.length > 0 || broken.length > 0)) {
  // A successful authentication confirms the key.
  const damaged = [...rejected, ...broken];
  out('');
  out('Diagnosis: File-specific damage; SECRET_KEY is valid for this volume.');
  out(`Evidence: ${names(healthy)} authenticated; ${names(damaged)} did not.`);
  out(`Action: Restore ${names(damaged)} from this volume's backup before removing anything.`);
  fail(FAILURE_ID.fileDamage, `${names(damaged)} failed while other files authenticated, indicating file-specific damage.`);
} else if (rejected.length === 1 && opened.length === 1 && broken.length === 0) {
  out('');
  out('Diagnosis: SECRET_KEY mismatch or file damage; one file cannot distinguish them.');
  out(`Cause: ${names(rejected)} is the only authenticated file present and rejected the key.`);
  out('Action: Confirm the original SECRET_KEY first. Restore or remove the file only after the key is ruled out.');
  fail(FAILURE_ID.singleFileAmbiguous, `${names(rejected)} is the only authenticated file and rejected the current key.`);
}

finish();

function finish() {
  WATCHED.forEach((path, index) => {
    if (before[index] !== digestOf(path)) {
      fail(FAILURE_ID.readOnlyViolation, `${path} changed during this read-only check. Treat earlier results as unverified, restore the file, and rerun against a copy of the volume.`);
    }
  });
  if (failures.length > 0) {
    out('');
    out(`Status: blocked by ${failures.length} issue${failures.length === 1 ? '' : 's'}.`);
    for (const { id, reason } of failures) out(`  [${id}] ${reason}`);
    process.exit(1);
  }
  if (unprovisioned) {
    out('');
    out('Status: not provisioned; no mobile state is available to verify.');
    process.exit(2);
  }
  out('');
  out('Status: ready; the mobile listener would start with this configuration and material.');
  process.exit(0);
}
