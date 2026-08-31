// Authenticated Docker-access policy stored independently from the main state envelope.

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
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { config } from './config.js';
import { getInstallationId } from './store.js';

const FILE = join(config.dataDir, 'qm-docker-access-v1.json');
const FORMAT = 1;
const MAX_BYTES = 4096;
const MAC_CONTEXT = 'qm-companion:docker-access:v1\0';

export const DOCKER_ACCESS_MODES = Object.freeze(['read', 'manage', 'shell']);
export const DOCKER_ACCESS_LABELS = Object.freeze({
  read: 'Read only',
  manage: 'Management',
  shell: 'Management + shell',
});
export const DOCKER_ACCESS_SHORT_LABELS = Object.freeze({
  read: 'Read only',
  manage: 'Manage',
  shell: 'Shell',
});

const RANK = Object.freeze({ read: 0, manage: 1, shell: 2 });
let cachedMode = null;
// Refuse further operations after a committed write whose directory fsync failed.
let poisoned = false;

// Recovery guidance validates key length without printing the key.
const KEY_LENGTH_CHECK = 'docker compose run --rm --no-deps --entrypoint node companion -e "process.stdout.write(String((process.env.SECRET_KEY || \'\').length))"';
// Describe the effect of resetting this sidecar alone.
const ACCESS_LOSS = `removing ${FILE} resets only the Docker access mode to Read only; it does not remove `
  + 'accounts, services, credentials, API tokens or paired phones';

function typedAccessError(message, cause) {
  const error = new Error(message);
  error.code = 'QM_DOCKER_ACCESS_INVALID';
  if (cause) error.cause = cause;
  return error;
}

// Structural corruption requires restoring the sidecar or resetting its policy.
function accessError(detail, cause) {
  return typedAccessError([
    `Docker access state is unreadable (${detail}).`,
    `File: ${FILE}.`,
    `Check: ${KEY_LENGTH_CHECK} prints 64 for a complete SECRET_KEY and 0 when unset.`,
    `Action: Confirm the key belongs to this data directory, then restore ${FILE} from backup.`,
    `Fallback: If no backup is available, ${ACCESS_LOSS}.`,
  ].join(' '), cause);
}

// Authentication failure indicates a sidecar/key mismatch.
function accessKeyMismatchError() {
  return typedAccessError([
    'Docker access state is unreadable (authentication failed).',
    `File: ${FILE}. The file and configured SECRET_KEY do not authenticate together. This cannot`,
    'distinguish a changed key from a damaged or replaced file; a changed or regenerated key is the usual cause.',
    'Action: Restore the SECRET_KEY previously used with this data directory, then restart.',
    `Check: ${KEY_LENGTH_CHECK} prints 64 for a complete key and 0 when unset.`,
    `Fallback: Only if that key cannot be recovered, ${ACCESS_LOSS}.`,
  ].join(' '));
}

// Before rename, the previous mode remains live and unchanged.
function accessWriteError(cause) {
  return typedAccessError([
    `The Docker access mode could not be saved to ${FILE} (${(cause && cause.code) || 'write failed'}).`,
    'The previously selected mode is still in force, on disk and in memory, and no partial file was left behind.',
    'Make the data directory writable and check it has free space, then choose the mode again.',
  ].join(' '), cause);
}

// A committed but unconfirmed write has its own fail-stop error.
function failStoppedError() {
  return typedAccessError([
    'Docker access is fail-stopped after a mode write whose durability could not be confirmed.',
    `The selected mode is committed in ${FILE} and is the mode in force.`,
    'Restart Companion before changing the mode again.',
  ].join(' '));
}

// After rename, retain the committed mode and report uncertain durability separately.
function durabilityError(cause) {
  const error = new Error(
    'Docker access mode was committed, but durability is uncertain (directory fsync failed). The new mode is active, the access sidecar is fail-stopped, and Companion must be restarted before further mode changes.',
  );
  error.code = 'QM_DOCKER_ACCESS_DURABILITY_UNCERTAIN';
  if (cause) error.cause = cause;
  return error;
}

function assertUsable() {
  if (poisoned) throw failStoppedError();
}

function configuredCeiling() {
  const raw = process.env.DOCKER_ACCESS_MAX;
  if (raw === undefined) {
    // DOCKER_WRITE compatibility enables management and shell together.
    return { mode: config.dockerControl ? 'shell' : 'read', explicit: false };
  }
  if (!DOCKER_ACCESS_MODES.includes(raw)) {
    throw new Error('DOCKER_ACCESS_MAX must be exactly read, manage or shell');
  }
  return { mode: raw, explicit: true };
}

const CEILING = configuredCeiling();

export function dockerModeRank(mode) {
  return Object.hasOwn(RANK, mode) ? RANK[mode] : -1;
}

export function dockerModeAllows(mode, needed) {
  return dockerModeRank(mode) >= dockerModeRank(needed) && dockerModeRank(needed) >= 0;
}

function payloadFor(mode) {
  return JSON.stringify({ installationId: getInstallationId(), mode });
}

function macFor(payload) {
  return createHmac('sha256', config.stateKey).update(MAC_CONTEXT).update(payload, 'utf8').digest('hex');
}

function encode(mode) {
  const payload = payloadFor(mode);
  return `${JSON.stringify({ version: FORMAT, payload, mac: macFor(payload) }, null, 2)}\n`;
}

function decode(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    throw accessError('file is invalid JSON', error);
  }
  if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype
    || Object.keys(envelope).length !== 3
    || envelope.version !== FORMAT
    || typeof envelope.payload !== 'string'
    || typeof envelope.mac !== 'string'
    || !/^[0-9a-f]{64}$/i.test(envelope.mac)) {
    throw accessError('format is invalid');
  }
  const expected = Buffer.from(macFor(envelope.payload), 'hex');
  const supplied = Buffer.from(envelope.mac, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw accessKeyMismatchError();
  }
  let parsed;
  try {
    parsed = JSON.parse(envelope.payload);
  } catch (error) {
    throw accessError('payload is invalid JSON', error);
  }
  const canonical = parsed && Object.getPrototypeOf(parsed) === Object.prototype
    && Object.keys(parsed).length === 2
    && parsed.installationId === getInstallationId()
    && DOCKER_ACCESS_MODES.includes(parsed.mode)
    && JSON.stringify({ installationId: parsed.installationId, mode: parsed.mode }) === envelope.payload;
  if (!canonical) throw accessError('payload has an invalid structure');
  return parsed.mode;
}

// Rename is the commit point; a later directory-fsync failure reports uncertain durability.
function atomicWrite(contents) {
  const tmp = join(config.dataDir, `.qm-docker-access-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700);
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, FILE);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(tmp); } catch { /* no temporary file left */ }
    throw accessWriteError(error);
  }
  // Confirm durability after the committed rename.
  try {
    const dir = openSync(config.dataDir, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) {
    return { durable: false, cause: error };
  }
  return { durable: true };
}

function writeMode(mode) {
  assertUsable();
  const outcome = atomicWrite(encode(mode));
  // Keep memory aligned with the committed rename.
  cachedMode = mode;
  if (!outcome.durable) {
    poisoned = true;
    throw durabilityError(outcome.cause);
  }
}

function selectedMode() {
  assertUsable();
  if (cachedMode) return cachedMode;
  let raw;
  try {
    raw = readFileSync(FILE);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw accessError('read failed', error);
    cachedMode = CEILING.explicit ? 'read' : CEILING.mode;
    return cachedMode;
  }
  if (raw.length > MAX_BYTES) throw accessError('file is too large');
  const selected = decode(raw.toString('utf8'));
  if (dockerModeRank(selected) > dockerModeRank(CEILING.mode)) {
    // Persist ceiling-driven downgrades.
    writeMode(CEILING.mode);
    return cachedMode;
  }
  cachedMode = selected;
  return cachedMode;
}

export function dockerAccessState() {
  const mode = selectedMode();
  return {
    mode,
    label: DOCKER_ACCESS_LABELS[mode],
    shortLabel: DOCKER_ACCESS_SHORT_LABELS[mode],
    ceiling: CEILING.mode,
    ceilingLabel: DOCKER_ACCESS_LABELS[CEILING.mode],
    explicitCeiling: CEILING.explicit,
    canManage: dockerModeAllows(mode, 'manage'),
    canShell: dockerModeAllows(mode, 'shell'),
  };
}

export function setDockerAccessMode(mode) {
  if (!DOCKER_ACCESS_MODES.includes(mode)) {
    return { ok: false, error: 'Choose read, manage or shell.' };
  }
  if (dockerModeRank(mode) > dockerModeRank(CEILING.mode)) {
    return { ok: false, error: `${DOCKER_ACCESS_LABELS[mode]} is above this installation's ${DOCKER_ACCESS_LABELS[CEILING.mode]} maximum.` };
  }
  try {
    writeMode(mode);
  } catch (error) {
    if (!error || error.code !== 'QM_DOCKER_ACCESS_INVALID') throw error;
    return { ok: false, status: 500, error: 'Docker access mode could not be saved.' };
  }
  return { ok: true, state: dockerAccessState() };
}

export function canManageDocker() {
  return dockerAccessState().canManage;
}

export function canUseDockerShell() {
  return dockerAccessState().canShell;
}
