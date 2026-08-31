// TLS material for the mobile listener under DATA_DIR/tls/.
// Generated certificates use a recoverable transaction and a shared file lock.
// Paired devices pin the certificate and advertised origin, so changes require rotation.

import { X509Certificate, createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

import { LOCK_TIMEOUT_MS as SHARED_LOCK_TIMEOUT_MS, withFileLock } from '../lock.js';
import { unusableHostReason } from './origin.js';
import { buildSelfSignedCertificate } from './x509.js';

// These commands use the fixed container name.
export const ROTATE_COMMAND = 'docker exec qm-companion node src/mobile/rotate-cert.js --confirm';
export const RESTART_COMMAND = 'docker restart qm-companion';
export const ROTATE_REMEDY = `Rotate it explicitly with \`${ROTATE_COMMAND}\`: that regenerates the certificate and revokes every paired device, so re-pair every phone afterwards.`;
export const ORIGIN_BINDING_FILE = 'mobile-origin.json';
export const ORIGIN_REMEDY = `Approve the change with \`${ROTATE_COMMAND}\`: that binds the new origin and revokes every paired device, so re-pair every phone afterwards. It regenerates the certificate only when Companion issued it; owner-supplied material is left exactly as found.`;
export const DEFAULT_VALIDITY_DAYS = 825;
export const EXPIRY_WARNING_DAYS = 30;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const LOCK_TIMEOUT_MS = SHARED_LOCK_TIMEOUT_MS;

export function tlsPaths(dataDir) {
  const dir = join(dataDir, 'tls');
  const pendingDir = join(dir, 'pending');
  return {
    dir,
    lockDir: dataDir,
    lockPath: join(dataDir, '.mobile-tls.lock'),
    // Keep the writable origin record outside a potentially read-only certificate directory.
    bindingPath: join(dataDir, ORIGIN_BINDING_FILE),
    certPath: join(dir, 'mobile.crt'),
    keyPath: join(dir, 'mobile.key'),
    recordPath: join(dir, 'mobile.json'),
    pendingDir,
    pendingCertPath: join(pendingDir, 'mobile.crt'),
    pendingKeyPath: join(pendingDir, 'mobile.key'),
    pendingRecordPath: join(pendingDir, 'mobile.json'),
  };
}

// One-shot fault injection for transaction recovery checks.
let faultPoint = null;
export function __setCertificateFault(point = null) {
  faultPoint = point;
}
function cut(point) {
  if (faultPoint !== point) return;
  faultPoint = null;
  const error = new Error(`certificate transaction interrupted at ${point}`);
  error.code = 'QM_TEST_FAULT';
  throw error;
}

function fsyncDir(dir) {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Run with the shared lock, stored outside a potentially read-only tls directory. */
export function withCertificateLock(dataDir, fn) {
  const paths = tlsPaths(dataDir);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return withFileLock(
    {
      lockPath: paths.lockPath,
      lockDir: paths.lockDir,
      timeoutCode: 'QM_CERT_LOCK_TIMEOUT',
      failedCode: 'QM_CERT_LOCK_FAILED',
      contendedMessage: `another process is holding the TLS lock under ${paths.lockDir}; nothing was changed`,
    },
    fn,
  );
}

/** Map lock contention and filesystem errors to the caller's failure shape. */
function lockRefusal(error, paths) {
  if (error?.code === 'QM_CERT_LOCK_TIMEOUT') {
    return { ok: false, code: 'locked', reason: error.message };
  }
  return { ok: false, code: 'generate', reason: `could not generate a certificate under ${paths.dir} (${error?.fsCode || error?.code || 'error'})` };
}

export function fingerprintOf(certPem) {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex');
}

function readRecord(recordPath) {
  if (!existsSync(recordPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function bare(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Match IP literals against IP SANs and names against DNS SANs. */
export function certificateCoversHost(certPem, host) {
  const cert = new X509Certificate(certPem);
  const h = bare(host);
  return isIP(h) ? cert.checkIP(h) === h : cert.checkHost(h, { subject: 'never' }) === h;
}

/** Parse and verify a certificate-key pair. */
export function checkMaterial(certPem, keyPem) {
  let cert;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    throw new Error('mobile.crt is not a readable X.509 certificate');
  }
  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new Error('mobile.key is not a readable private key');
  }
  if (!cert.checkPrivateKey(key)) throw new Error('mobile.key does not match mobile.crt');
  return { cert, key };
}

function writeAtomic(path, contents, mode) {
  // PID 1 is reused in containers, so temporary names require a random suffix.
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', mode);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* already absent */ }
    if (error && typeof error === 'object') error.tmpPath = tmp;
    throw error;
  }
}

/** Classify pending certificate state. */
function readPendingGeneration(paths) {
  if (!existsSync(paths.pendingDir)) return { state: 'none' };
  if (!existsSync(paths.pendingKeyPath) || !existsSync(paths.pendingCertPath) || !existsSync(paths.pendingRecordPath)) {
    return { state: 'incomplete' };
  }
  let certPem;
  let keyPem;
  let recordText;
  try {
    certPem = readFileSync(paths.pendingCertPath, 'utf8');
    keyPem = readFileSync(paths.pendingKeyPath, 'utf8');
    recordText = readFileSync(paths.pendingRecordPath, 'utf8');
  } catch {
    return { state: 'incomplete' };
  }
  let fingerprint;
  try {
    checkMaterial(certPem, keyPem);
    fingerprint = fingerprintOf(certPem);
  } catch {
    return { state: 'incomplete' };
  }
  let record;
  try {
    record = JSON.parse(recordText);
  } catch {
    return { state: 'incomplete' };
  }
  // Require one matching staged generation.
  if (!record || typeof record !== 'object' || record.generated !== true || record.fingerprint !== fingerprint) {
    return { state: 'incomplete' };
  }
  return { state: 'complete', certPem, keyPem, recordText, record, fingerprint };
}

/** Install complete staged material or discard an incomplete pre-commit set. */
export function recoverPendingMaterial(dataDir) {
  const paths = tlsPaths(dataDir);
  try {
    return withCertificateLock(dataDir, () => settlePendingGeneration(paths));
  } catch (error) {
    return lockRefusal(error, paths);
  }
}

function settlePendingGeneration(paths) {
  const pending = readPendingGeneration(paths);
  if (pending.state === 'none') return { ok: true, outcome: 'none' };
  if (pending.state === 'incomplete') {
    // Incomplete staging has not committed.
    try {
      rmSync(paths.pendingDir, { recursive: true, force: true });
      fsyncDir(paths.dir);
    } catch (error) {
      return { ok: false, code: 'pending', reason: `an interrupted certificate write under ${paths.pendingDir} could not be cleared (${describeWriteError(error)}); remove that directory and start again` };
    }
    return { ok: true, outcome: 'discarded' };
  }
  try {
    cut('install-key');
    writeAtomic(paths.keyPath, pending.keyPem, 0o600);
    cut('install-cert');
    writeAtomic(paths.certPath, pending.certPem, 0o644);
    cut('install-record');
    writeAtomic(paths.recordPath, pending.recordText, 0o600);
    cut('install-fsync');
    fsyncDir(paths.dir);
    cut('install-cleanup');
    rmSync(paths.pendingDir, { recursive: true, force: true });
    fsyncDir(paths.dir);
  } catch (error) {
    return { ok: false, code: 'pending', reason: `a committed certificate generation under ${paths.pendingDir} could not be installed (${describeWriteError(error)}); it is retried on the next start` };
  }
  return { ok: true, outcome: 'installed', fingerprint: pending.fingerprint, record: pending.record };
}

function writeMaterial(paths, host, built) {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  const fingerprint = fingerprintOf(built.certPem);
  const record = { generated: true, host: bare(host), sanKind: built.sanKind, createdAt: new Date().toISOString(), notAfter: built.notAfter.toISOString(), fingerprint };
  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  // Recovery and generation share the certificate lock.
  rmSync(paths.pendingDir, { recursive: true, force: true });
  mkdirSync(paths.pendingDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.pendingDir, 0o700);
  cut('prepare-key');
  writeAtomic(paths.pendingKeyPath, built.keyPem, 0o600);
  cut('prepare-cert');
  writeAtomic(paths.pendingCertPath, built.certPem, 0o644);
  cut('prepare-record');
  writeAtomic(paths.pendingRecordPath, recordText, 0o600);
  // A synced staging directory is recoverable after interruption.
  fsyncDir(paths.pendingDir);
  cut('prepare-fsync');
  const installed = settlePendingGeneration(paths);
  if (!installed.ok) {
    const error = new Error(installed.reason);
    error.code = 'QM_PENDING_INSTALL';
    throw error;
  }
  return record;
}

/** Resolve TLS material for the advertised host without exposing key details. */
export function ensureMobileCertificate({ dataDir, host, days = DEFAULT_VALIDITY_DAYS }) {
  const paths = tlsPaths(dataDir);
  try {
    return withCertificateLock(dataDir, () => ensureLocked({ paths, dataDir, host, days }));
  } catch (error) {
    return lockRefusal(error, paths);
  }
}

function ensureLocked({ paths, host, days }) {
  // Reject bind-only addresses as certificate identities.
  const unusable = unusableHostReason(host);
  if (unusable) {
    return { ok: false, code: 'host_unusable', reason: `a certificate cannot be issued for ${bare(host)}: it ${unusable}` };
  }
  // Settle pending generation before classifying live material.
  const recovered = settlePendingGeneration(paths);
  if (!recovered.ok) return { ok: false, code: recovered.code, reason: recovered.reason };
  const haveCert = existsSync(paths.certPath);
  const haveKey = existsSync(paths.keyPath);
  const record = readRecord(paths.recordPath);
  if (haveCert !== haveKey) {
    return { ok: false, code: 'partial', reason: `TLS material is incomplete under ${paths.dir}: expected both mobile.crt and mobile.key; add the missing file or remove both so a certificate can be generated.` };
  }
  if (!haveCert) {
    let built;
    let written;
    try {
      built = buildSelfSignedCertificate({ host, days });
      written = writeMaterial(paths, host, built);
    } catch (error) {
      return { ok: false, code: 'generate', reason: `could not generate a certificate under ${paths.dir} (${describeWriteError(error)})` };
    }
    return { ok: true, cert: Buffer.from(built.certPem), key: Buffer.from(built.keyPem), source: 'generated', fingerprint: written.fingerprint, record: written, created: true, notAfter: built.notAfter.toISOString(), expiresSoon: false };
  }
  let cert;
  let key;
  try {
    cert = readFileSync(paths.certPath);
    key = readFileSync(paths.keyPath);
  } catch (error) {
    return { ok: false, code: 'unreadable', reason: `TLS material unreadable under ${paths.dir} (${error.code || 'error'})` };
  }
  let parsed;
  try {
    parsed = checkMaterial(cert, key).cert;
  } catch (error) {
    return { ok: false, code: 'invalid', reason: error.message };
  }
  const fingerprint = fingerprintOf(cert);
  // Generated records are fingerprint-bound.
  const generated = isGeneratedRecord(record, fingerprint);
  const label = generated ? 'the generated certificate' : 'mobile.crt';
  const validity = checkValidity(parsed, label, generated);
  if (validity) return validity;
  const coversHost = certificateCoversHost(cert, host);
  if (generated) {
    if (record.host !== bare(host)) {
      return { ok: false, code: 'host_changed', reason: `the advertised origin changed: the generated certificate was issued for ${record.host} but QM_ADVERTISED_ORIGIN now names ${bare(host)}. ${ROTATE_REMEDY}` };
    }
    if (!coversHost) {
      return { ok: false, code: 'host_changed', reason: `the generated certificate no longer names ${bare(host)} in its SAN. ${ROTATE_REMEDY}` };
    }
  } else if (!coversHost) {
    return { ok: false, code: 'host_mismatch', reason: `mobile.crt does not name ${bare(host)} in its SAN; replace it with one that does, then re-pair every phone.` };
  }
  const notAfter = new Date(parsed.validTo).toISOString();
  return { ok: true, cert, key, source: generated ? 'generated' : 'owner', fingerprint, record: generated ? record : null, created: false, notAfter, expiresSoon: expiresWithin(parsed, EXPIRY_WARNING_DAYS) };
}

function isGeneratedRecord(record, fingerprint) {
  return record?.generated === true && typeof record.fingerprint === 'string' && record.fingerprint === fingerprint;
}

/** Classify live certificate material without generating a certificate. */
export function describeMobileCertificate(dataDir) {
  const paths = tlsPaths(dataDir);
  try {
    return withCertificateLock(dataDir, () => describeLocked(paths));
  } catch (error) {
    // Do not classify source without the lock.
    return { present: false, fingerprint: null, source: null, record: null, pending: 'unknown', locked: error.code, paths };
  }
}

/** Settle a pending transaction before classifying material for a mutating operation. */
export function classifyMobileCertificate(dataDir) {
  const paths = tlsPaths(dataDir);
  try {
    return withCertificateLock(dataDir, () => {
      const settled = settlePendingGeneration(paths);
      if (!settled.ok) {
        return { present: false, fingerprint: null, source: null, record: null, pending: 'unsettled', locked: settled.code, paths };
      }
      return describeLocked(paths);
    });
  } catch (error) {
    return { present: false, fingerprint: null, source: null, record: null, pending: 'unknown', locked: error.code, paths };
  }
}

function describeLocked(paths) {
  // Read-only diagnostics report but do not settle staging.
  const pending = readPendingGeneration(paths).state;
  if (!existsSync(paths.certPath)) return { present: false, fingerprint: null, source: null, record: null, pending, paths };
  let fingerprint = null;
  try {
    fingerprint = fingerprintOf(readFileSync(paths.certPath));
  } catch {
    fingerprint = null;
  }
  const record = readRecord(paths.recordPath);
  const generated = fingerprint !== null && isGeneratedRecord(record, fingerprint);
  return { present: true, fingerprint, source: generated ? 'generated' : 'owner', record: generated ? record : null, pending, paths };
}

// Track origin changes not covered by certificate SANs.

function bindingRefusal(error, paths, origin) {
  if (error?.code === 'QM_CERT_LOCK_TIMEOUT') {
    return { ok: false, code: 'locked', reason: error.message };
  }
  return { ok: false, code: 'bind', reason: `the advertised origin ${origin} could not be recorded in ${paths.bindingPath} (${error?.fsCode || error?.code || 'error'})` };
}

/** Classify the origin-binding record. */
function readBinding(paths) {
  if (!existsSync(paths.bindingPath)) return { state: 'none' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(paths.bindingPath, 'utf8'));
  } catch {
    return { state: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.origin !== 'string' || parsed.origin.length === 0 || parsed.origin.length > 255) {
    return { state: 'unreadable' };
  }
  return {
    state: 'bound',
    binding: {
      origin: parsed.origin,
      fingerprint: typeof parsed.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(parsed.fingerprint) ? parsed.fingerprint : null,
      boundAt: Number.isSafeInteger(parsed.boundAt) && parsed.boundAt > 0 ? parsed.boundAt : 0,
      approved: parsed.approved === true,
    },
  };
}

function writeBinding(paths, binding) {
  mkdirSync(paths.lockDir, { recursive: true, mode: 0o700 });
  writeAtomic(paths.bindingPath, `${JSON.stringify({ version: 1, ...binding }, null, 2)}\n`, 0o600);
  fsyncDir(paths.lockDir);
}

/** Bind the advertised origin using current sidecar and epoch state. */
export function bindAdvertisedOrigin({ dataDir, origin, fingerprint = null, pairedDevices = 0, everBound = false, grantsExist = undefined }) {
  const paths = tlsPaths(dataDir);
  const grants = grantsExist === undefined ? pairedDevices > 0 : grantsExist;
  try {
    return withCertificateLock(dataDir, () => bindLocked({ paths, origin, fingerprint, pairedDevices, everBound, grants }));
  } catch (error) {
    return bindingRefusal(error, paths, origin);
  }
}

function bindLocked({ paths, origin, fingerprint, pairedDevices, everBound, grants }) {
  const stored = readBinding(paths);
  if (stored.state === 'bound' && stored.binding.origin === origin) {
    // A leaf-only change does not alter the origin cutoff.
    if (fingerprint !== null && stored.binding.fingerprint !== fingerprint) {
      try {
        writeBinding(paths, { ...stored.binding, fingerprint });
      } catch (error) {
        return bindingRefusal(error, paths, origin);
      }
    }
    return { ok: true, origin, boundAt: stored.binding.boundAt, adopted: false };
  }
  // Epoch history prevents sidecar loss from authorizing an origin change.
  const phones = pairedDevices > 0
    ? `${pairedDevices} paired device famil${pairedDevices === 1 ? 'y is' : 'ies are'}`
    : 'device families that this installation has recorded are';
  // A prior epoch binding makes a missing file an error.
  if (stored.state === 'none' && grants && everBound) {
    return { ok: false, code: 'origin_binding_missing', reason: `the advertised origin binding at ${paths.bindingPath} is missing, but ${phones} still bound to its previous origin. Restore the file from a backup. ${ORIGIN_REMEDY}` };
  }
  if (stored.state === 'unreadable' && grants) {
    return { ok: false, code: 'origin_unreadable', reason: `the advertised origin binding in ${paths.bindingPath} is unreadable, and ${phones} bound to its recorded origin. Restore the file, or delete it to adopt ${origin} while keeping paired devices.` };
  }
  // Unknown fingerprints do not bypass origin checks.
  const sameLeaf = fingerprint === null || stored.binding?.fingerprint === null || stored.binding?.fingerprint === fingerprint;
  if (stored.state === 'bound' && grants && sameLeaf) {
    return { ok: false, code: 'origin_changed', reason: `the advertised origin changed: ${phones} bound to ${stored.binding.origin}, but QM_ADVERTISED_ORIGIN now names ${origin}. Phones pin the scheme, host and port. ${ORIGIN_REMEDY}` };
  }
  // Stamp adopted moves so restored grants remain invalid.
  const originMoved = stored.state === 'bound' && stored.binding.origin !== origin && grants;
  const boundAt = originMoved ? Date.now() : (stored.state === 'bound' ? stored.binding.boundAt : 0);
  try {
    writeBinding(paths, { origin, fingerprint, boundAt, approved: false });
  } catch (error) {
    return bindingRefusal(error, paths, origin);
  }
  return { ok: true, origin, boundAt, adopted: true };
}

/** Approve an origin after verifying the current certificate covers its host. */
export function approveAdvertisedOrigin({ dataDir, origin, host }) {
  const paths = tlsPaths(dataDir);
  try {
    return withCertificateLock(dataDir, () => approveLocked({ paths, origin, host }));
  } catch (error) {
    return bindingRefusal(error, paths, origin);
  }
}

function approveLocked({ paths, origin, host }) {
  const unusable = unusableHostReason(host);
  if (unusable) {
    return { ok: false, code: 'host_unusable', reason: `${origin} cannot be advertised: it ${unusable}` };
  }
  const settled = settlePendingGeneration(paths);
  if (!settled.ok) return { ok: false, code: settled.code, reason: settled.reason };
  let fingerprint = null;
  let source = null;
  if (existsSync(paths.certPath)) {
    let certPem;
    let keyPem;
    try {
      certPem = readFileSync(paths.certPath);
      keyPem = readFileSync(paths.keyPath);
    } catch (error) {
      return { ok: false, code: 'unreadable', reason: `TLS material unreadable under ${paths.dir} (${error.code || 'error'})` };
    }
    try {
      checkMaterial(certPem, keyPem);
    } catch (error) {
      return { ok: false, code: 'invalid', reason: error.message };
    }
    fingerprint = fingerprintOf(certPem);
    source = isGeneratedRecord(readRecord(paths.recordPath), fingerprint) ? 'generated' : 'owner';
    if (!certificateCoversHost(certPem, host)) {
      return { ok: false, code: 'host_mismatch', reason: `mobile.crt under ${paths.dir} does not name ${bare(host)} in its SAN. Replace mobile.crt and mobile.key with a certificate that names ${bare(host)}, then try again.` };
    }
  }
  const previous = readBinding(paths);
  const boundAt = Date.now();
  try {
    writeBinding(paths, { origin, fingerprint, boundAt, approved: true });
  } catch (error) {
    return bindingRefusal(error, paths, origin);
  }
  return { ok: true, origin, boundAt, fingerprint, source, previousOrigin: previous.state === 'bound' ? previous.binding.origin : null };
}

/** Read an unlocked snapshot; mutating callers must revalidate under the lock. */
export function readMobileCertificateFacts(dataDir) {
  const paths = tlsPaths(dataDir);
  const facts = existsSync(paths.dir)
    ? describeLocked(paths)
    : { present: false, fingerprint: null, source: null, record: null, pending: 'none', paths };
  const stored = readBinding(paths);
  return { ...facts, bindingState: stored.state, boundOrigin: stored.state === 'bound' ? stored.binding.origin : null };
}

function describeWriteError(error) {
  const code = error?.code || error?.message || 'error';
  return error?.code === 'EEXIST' && error.tmpPath ? `${code}: a leftover temporary file ${error.tmpPath} is in the way; remove it` : code;
}

function expiresWithin(cert, days) {
  return Date.parse(cert.validTo) - Date.now() < days * 86_400_000;
}

/** Reject expired or not-yet-valid material. */
function checkValidity(cert, label, generated) {
  const validTo = Date.parse(cert.validTo);
  const validFrom = Date.parse(cert.validFrom);
  const now = Date.now();
  const remedy = generated ? ROTATE_REMEDY : 'Replace mobile.crt and mobile.key, then re-pair every phone.';
  if (Number.isFinite(validTo) && validTo < now) {
    return { ok: false, code: 'expired', reason: `${label} expired on ${new Date(validTo).toISOString()}. ${remedy}` };
  }
  if (Number.isFinite(validFrom) && validFrom > now + CLOCK_SKEW_MS) {
    return { ok: false, code: 'not_yet_valid', reason: `${label} is not valid until ${new Date(validFrom).toISOString()}; check the server clock. ${remedy}` };
  }
  return null;
}

/** Regenerate Companion-managed material; reject operator-managed certificates. */
export function rotateMobileCertificate({ dataDir, host, days = DEFAULT_VALIDITY_DAYS }) {
  const paths = tlsPaths(dataDir);
  try {
    return withCertificateLock(dataDir, () => rotateLocked({ paths, host, days }));
  } catch (error) {
    return lockRefusal(error, paths);
  }
}

function rotateLocked({ paths, host, days }) {
  const unusable = unusableHostReason(host);
  if (unusable) {
    return { ok: false, code: 'host_unusable', reason: `a certificate cannot be issued for ${bare(host)}: it ${unusable}` };
  }
  // Settle staging before classifying certificate ownership.
  const recovered = settlePendingGeneration(paths);
  if (!recovered.ok) return { ok: false, code: recovered.code, reason: recovered.reason };
  const record = readRecord(paths.recordPath);
  if (existsSync(paths.certPath)) {
    let current;
    try {
      current = fingerprintOf(readFileSync(paths.certPath));
    } catch {
      current = null;
    }
    if (!isGeneratedRecord(record, current)) {
      return { ok: false, code: 'owner', reason: `mobile.crt under ${paths.dir} is owner-supplied (no generated record matches it), and Companion never regenerates owner material. Replace mobile.crt and mobile.key yourself with a certificate that names ${bare(host)}, restart Companion, then re-pair every phone.` };
    }
  }
  try {
    const built = buildSelfSignedCertificate({ host, days });
    const written = writeMaterial(paths, host, built);
    // Report the installed certificate fingerprint.
    const installed = fingerprintOf(readFileSync(paths.certPath));
    if (installed !== written.fingerprint) {
      return { ok: false, code: 'generate', reason: `the rotated certificate under ${paths.dir} is not the one that was written; nothing may rely on this rotation` };
    }
    // Rotation clears the old leaf binding; clone reset leaves it for next-start adoption.
    try { unlinkSync(paths.bindingPath); } catch { /* already absent */ }
    return { ok: true, fingerprint: installed, record: written, previousFingerprint: record?.fingerprint || null };
  } catch (error) {
    return { ok: false, code: 'generate', reason: `could not write the rotated certificate under ${paths.dir} (${describeWriteError(error)})` };
  }
}
