// Authenticated mobile state with canonical payloads and sealed identity.

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { config } from '../config.js';
import { withFileLock } from '../lock.js';
import { MOBILE_EPOCH_FILE, hasEverPairedIn, raiseEpoch, readEpoch, revokedDevicesOf, rollbackReason } from './epoch.js';
import { getInstallationId } from '../store.js';
import { mobileStateKey } from './keys.js';
import { createIdentity, fingerprintOf, openPrivateKey, publicKeyFromPrivate } from './identity.js';
import {
  MAX_STATE_BYTES,
  MOBILE_STATE_VERSION,
  canonicalMobilePayload,
  validateMobilePayload,
} from './schema.js';

export const MOBILE_STATE_FILE = join(config.dataDir, 'qm-mobile-v1.json');
const MOBILE_STATE_LOCK = join(config.dataDir, '.qm-mobile-state.lock');
const FORMAT = 1;
const MAC_CONTEXT = 'qm-companion:mobile-state:v1\0';

let cached = null; // the authoritative in-memory state; never handed out, only cloned
let updating = false;
// Refuse further operations after a committed write whose directory fsync failed.
let poisoned = false;

// Recovery guidance validates key length without printing the key.
const KEY_LENGTH_CHECK = 'docker compose run --rm --no-deps --entrypoint node companion -e "process.stdout.write(String((process.env.SECRET_KEY || \'\').length))"';
const SCOPE = 'Mobile access stays disabled; the owner account, browser and QMC1 are unaffected.';
const MOBILE_LOSS = `removing ${MOBILE_STATE_FILE} deletes only the mobile identity and pairings; every phone must pair again`;

function typedMobileError(message, cause) {
  const error = new Error(message);
  error.code = 'QM_MOBILE_STATE_INVALID';
  if (cause) error.cause = cause;
  return error;
}

// Structural corruption requires restoring or resetting the sidecar.
function mobileError(detail, cause) {
  return typedMobileError([
    `Mobile state is unreadable (${detail}).`,
    `File: ${MOBILE_STATE_FILE}. ${SCOPE}`,
    `Check: ${KEY_LENGTH_CHECK} prints 64 for a complete SECRET_KEY and 0 when unset.`,
    `Action: Confirm the key belongs to this data directory, then restore ${MOBILE_STATE_FILE} from backup.`,
    `Warning: ${MOBILE_LOSS}; no other data is lost.`,
  ].join(' '), cause);
}

// Authentication failure indicates a sidecar/key mismatch.
function mobileKeyMismatchError() {
  return typedMobileError([
    'Mobile state is unreadable (authentication failed).',
    `File: ${MOBILE_STATE_FILE}. The file and configured SECRET_KEY do not authenticate together. This cannot`,
    'distinguish a changed key from a damaged or replaced file; a changed or regenerated key is the usual cause.',
    SCOPE,
    'Action: Restore the SECRET_KEY previously used with this data directory, then restart; existing pairings remain.',
    `Check: ${KEY_LENGTH_CHECK} prints 64 for a complete key and 0 when unset.`,
    `Warning: Do not remove ${MOBILE_STATE_FILE} while the original key may be recoverable. If it cannot be`,
    `recovered, ${MOBILE_LOSS}; no other data is lost.`,
  ].join(' '));
}

// Before rename, the stored sidecar remains byte-identical.
function mobileWriteError(cause) {
  return typedMobileError([
    `Mobile state could not be written to ${MOBILE_STATE_FILE} (${(cause && cause.code) || 'write failed'}).`,
    'The stored sidecar is unchanged and every paired phone is intact, and no partial file was left behind.',
    SCOPE,
    'Make the data directory writable and check it has free space, then try again.',
  ].join(' '), cause);
}

// A committed but unconfirmed write has its own fail-stop error.
function mobileFailStoppedError() {
  return typedMobileError([
    'Mobile state is fail-stopped after a write whose durability could not be confirmed.',
    `The last committed state is in ${MOBILE_STATE_FILE} and is the state in force.`,
    SCOPE,
    'Restart Companion before making further mobile-state changes.',
  ].join(' '));
}

// After rename, retain the committed state and report uncertain durability separately.
function durabilityError(cause) {
  const error = new Error(
    `Mobile state was committed, but durability is uncertain (directory fsync failed). The new state is active in memory and on disk, the sidecar is fail-stopped, and Companion must be restarted before further mobile-state changes.`,
  );
  error.code = 'QM_MOBILE_STATE_DURABILITY_UNCERTAIN';
  if (cause) error.cause = cause;
  return error;
}

function assertUsable() {
  if (poisoned) throw mobileFailStoppedError();
}

function macFor(payload) {
  return createHmac('sha256', mobileStateKey).update(MAC_CONTEXT).update(payload, 'utf8').digest('hex');
}

function encode(state) {
  const payload = canonicalMobilePayload(state);
  return `${JSON.stringify({ version: FORMAT, payload, mac: macFor(payload) }, null, 2)}\n`;
}

// Verify that the sealed private key derives the recorded public identity.
function checkIdentity(state) {
  const key = openPrivateKey(state.identity.sealedPrivateKey, state.mobileInstallationId);
  if (!key) throw mobileError('identity is unreadable');
  const raw = publicKeyFromPrivate(key);
  if (
    Buffer.from(raw).toString('base64url') !== state.identity.publicKey ||
    fingerprintOf(raw) !== state.identity.fingerprint
  ) {
    throw mobileError('identity is inconsistent');
  }
}

function decode(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    throw mobileError('file is invalid JSON', error);
  }
  if (
    !envelope ||
    Object.getPrototypeOf(envelope) !== Object.prototype ||
    Object.keys(envelope).length !== 3 ||
    envelope.version !== FORMAT ||
    typeof envelope.payload !== 'string' ||
    typeof envelope.mac !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(envelope.mac)
  ) {
    throw mobileError('format is invalid');
  }
  const expected = Buffer.from(macFor(envelope.payload), 'hex');
  const supplied = Buffer.from(envelope.mac, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw mobileKeyMismatchError();
  }
  let parsed;
  try {
    parsed = JSON.parse(envelope.payload);
  } catch (error) {
    throw mobileError('payload is invalid JSON', error);
  }
  const verdict = validateMobilePayload(parsed, getInstallationId());
  if (!verdict.ok) throw mobileError(verdict.error);
  if (canonicalMobilePayload(parsed) !== envelope.payload) {
    throw mobileError('payload is not canonical');
  }
  checkIdentity(parsed);
  return parsed;
}

// Rename commits the sidecar; directory fsync confirms durability.
function atomicWrite(contents) {
  const tmp = join(config.dataDir, `.qm-mobile-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700); // mobile-owned enforcement even when the dir pre-existed
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, MOBILE_STATE_FILE);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // no temporary file left behind
    }
    throw mobileWriteError(error);
  }
  // Confirm durability after the committed rename.
  try {
    const dir = openSync(config.dataDir, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    return { durable: false, cause: error };
  }
  return { durable: true };
}

/** Build a fresh sidecar identity with no devices or spent capabilities. */
export function freshMobileState({ consumedCloneNonce = null, tlsResetPending = false } = {}) {
  const mobileInstallationId = randomUUID();
  return {
    version: MOBILE_STATE_VERSION,
    mobileInstallationId,
    legacyInstallationId: getInstallationId(),
    identity: createIdentity(mobileInstallationId),
    devices: [],
    spentCapabilities: [],
    consumedCloneNonce,
    tlsResetPending,
  };
}

function freshState() {
  return freshMobileState();
}

// Validate and write a candidate, swapping the cache only after the rename commit point.
function commit(candidate) {
  assertUsable();
  const verdict = validateMobilePayload(candidate, getInstallationId());
  if (!verdict.ok) throw mobileError(verdict.error);
  checkIdentity(candidate);
  const encoded = encode(candidate);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES) {
    throw mobileError('state exceeds the size cap');
  }
  const outcome = atomicWrite(encoded); // throws only in the pre-rename controlled zone
  cached = structuredClone(candidate);
  if (!outcome.durable) {
    poisoned = true;
    throw durabilityError(outcome.cause);
  }
  // Raise epoch state only after durable sidecar storage.
  try {
    withMobileStateLock(() => raiseEpoch({ revokedDevices: revokedDevicesOf(candidate), devicesSeen: hasEverPairedIn(candidate) }));
  } catch {
    // Best effort. The next commit raises it again from the same state.
  }
  return structuredClone(cached);
}

function internalLoad() {
  if (cached) return cached;
  let raw;
  try {
    raw = readFileSync(MOBILE_STATE_FILE);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw mobileError('read failed', error);
    // First-boot creation uses the same re-entrant interprocess lock as updates.
    return withMobileStateLock(() => {
      // Adopt sidecar state created while waiting for the lock.
      try {
        const raw = readFileSync(MOBILE_STATE_FILE);
        if (raw.length > MAX_STATE_BYTES) throw mobileError('file is too large');
        const decoded = decode(raw.toString('utf8'));
        guardRollback(decoded);
        cached = decoded;
        return cached;
      } catch (again) {
        if (!again || again.code !== 'ENOENT') throw again;
      }
      commit(freshState());
      return cached;
    });
  }
  if (raw.length > MAX_STATE_BYTES) throw mobileError('file is too large');
  const decoded = decode(raw.toString('utf8'));
  // Compare authenticated state with the high-water record before caching it.
  guardRollback(decoded);
  cached = decoded;
  return cached;
}

// Reject sidecar state older than the adjacent epoch record.
function rollbackError(detail) {
  return typedMobileError([
    `Mobile state is older than this installation's authority record (${detail}).`,
    SCOPE,
    `The sidecar is ${MOBILE_STATE_FILE} and the record is ${MOBILE_EPOCH_FILE}.`,
    'The sidecar authenticates, but it predates a recorded revocation.',
    `Restore ${MOBILE_STATE_FILE} from a backup made after that revocation. To accept the older state,`,
    `delete ${MOBILE_EPOCH_FILE}; this accepts every grant in the sidecar.`,
  ].join(' '));
}

// An unverifiable existing authority record closes the mobile plane.
function epochUnreadableError(detail) {
  return typedMobileError([
    `The mobile authority record is unreadable (${detail}).`,
    SCOPE,
    `The file is ${MOBILE_EPOCH_FILE}.`,
    'This record prevents a restored sidecar from re-enabling revoked grants.',
    `Confirm SECRET_KEY is the original key (${KEY_LENGTH_CHECK} prints 64 when set), then restore the`,
    `record from backup. Deleting ${MOBILE_EPOCH_FILE} accepts every grant in the current sidecar.`,
  ].join(' '));
}

// Compare with epoch state and adopt only when no epoch record exists.
function guardRollback(state) {
  const current = readEpoch();
  if (current.state === 'unreadable') throw epochUnreadableError(current.detail);
  if (current.state === 'ok') {
    const reason = rollbackReason(state, current.epoch);
    if (reason) throw rollbackError(reason);
    return;
  }
  try {
    // Serialize the read-modify-write through the shared re-entrant lock.
    withMobileStateLock(() => raiseEpoch({ revokedDevices: revokedDevicesOf(state), devicesSeen: hasEverPairedIn(state) }));
  } catch {
    // Initial record creation is best effort until the next successful commit.
  }
}

// Treat lock timeout as contention and do not write unlocked.
function lockRefusalError(error) {
  const contended = error?.code === 'QM_MOBILE_LOCK_TIMEOUT';
  return typedMobileError([
    contended
      ? 'Mobile state is busy: another Companion process is holding the sidecar transaction lock.'
      : `Mobile state could not be locked for writing (${error?.fsCode || error?.code || 'error'}).`,
    SCOPE,
    `The lock file is ${MOBILE_STATE_LOCK}.`,
    contended
      ? 'Nothing was changed. Try again in a moment.'
      : 'Nothing was changed. Check the data volume is writable and owned by the container user, then try again.',
  ].join(' '), error);
}

// Reload authoritative disk state after acquiring the shared lock.
/** Shared lock for sidecar creation, updates, and epoch changes. */
function withMobileStateLock(run) {
  try {
    return withFileLock(
      {
        lockPath: MOBILE_STATE_LOCK,
        lockDir: config.dataDir,
        timeoutCode: 'QM_MOBILE_LOCK_TIMEOUT',
        failedCode: 'QM_MOBILE_LOCK_FAILED',
        contendedMessage: `another process is holding the mobile state lock at ${MOBILE_STATE_LOCK}; nothing was changed`,
      },
      run,
    );
  } catch (error) {
    if (error?.code === 'QM_MOBILE_LOCK_TIMEOUT' || error?.code === 'QM_MOBILE_LOCK_FAILED') {
      throw lockRefusalError(error);
    }
    throw error;
  }
}

function transact(run) {
  if (updating) throw mobileError('reentrant update');
  assertUsable();
  return withMobileStateLock(
      () => {
        updating = true;
        cached = null;
        try {
          return run();
        } finally {
          updating = false;
        }
      },
  );
}

/** Raise epoch facts under the sidecar lock. */
export function raiseMobileEpoch(facts) {
  return withMobileStateLock(() => raiseEpoch(facts));
}

/** Return a detached current-state copy, creating the sidecar on first boot. */
export function loadMobileState() {
  assertUsable();
  return structuredClone(internalLoad());
}

/** Replace the stored state with a validated candidate and return a detached copy. */
export function saveMobileState(state) {
  return transact(() => commit(structuredClone(state)));
}

/** Serialize a clone-mutate-validate-write transaction. */
export function updateMobileState(mutate) {
  return transact(() => {
    const working = structuredClone(internalLoad());
    const next = mutate(working) ?? working;
    return commit(next);
  });
}
