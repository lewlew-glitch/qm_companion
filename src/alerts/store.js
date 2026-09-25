// Sealed alerts state with locked atomic writes.

import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync,
  readSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { config } from '../config.js';
import { withFileLock } from '../lock.js';
import { open, seal } from '../secrets.js';
import {
  ALERT_RECEIPT_TTL_MS, MAX_ALERT_HISTORY, MAX_ALERT_RECEIPTS, MAX_ALERT_SAMPLES,
  MAX_ALERTS_STATE_BYTES, validateAlertsState,
} from './schema.js';

export const ALERTS_STATE_FILE = join(config.dataDir, 'qm-alerts-v1.json');
const ALERTS_STATE_LOCK = join(config.dataDir, '.qm-alerts-state.lock');
const MAC_CONTEXT = 'qm-alerts:v1\0';
const SEAL_CONTEXT = 'qm-alerts:v1';
const ENVELOPE_BYTES = Buffer.byteLength(`${JSON.stringify({
  version: 1, sealed: `${'0'.repeat(24)}:${'0'.repeat(32)}:`, mac: '0'.repeat(64),
}, null, 2)}\n`, 'utf8');
const MAX_PAYLOAD_BYTES = Math.floor((MAX_ALERTS_STATE_BYTES - ENVELOPE_BYTES) / 2);

let cached = null;
let sourceIndex = null;
let updating = false;
let poisoned = false;

function stateError(message, cause) {
  const error = new Error(message);
  error.code = 'QM_ALERTS_STATE_INVALID';
  error.status = 503;
  if (cause) error.cause = cause;
  return error;
}

function assertUsable() {
  if (poisoned) throw stateError('Alerts state durability is uncertain. Restart Companion before changing alerts.');
}

function stampOf(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function fileStamp() {
  return stampOf(statSync(ALERTS_STATE_FILE, { bigint: true }));
}

function indexSources(state, stamp) {
  sourceIndex = stamp === null ? null : {
    stamp,
    entries: state.sources.map(({ id, kind, label, secret }) => ({
      digest: createHash('sha256').update(secret).digest(), source: { id, kind, label },
    })),
    error: null,
  };
}

function macFor(sealed) {
  return createHmac('sha256', config.stateKey).update(MAC_CONTEXT).update(sealed, 'utf8').digest('hex');
}

function encode(payload) {
  const sealed = seal(payload, SEAL_CONTEXT);
  return `${JSON.stringify({ version: 1, sealed, mac: macFor(sealed) }, null, 2)}\n`;
}

function decode(raw) {
  if (raw.length > MAX_ALERTS_STATE_BYTES) throw stateError('Alerts state exceeds the size cap.');
  let envelope;
  try {
    envelope = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw stateError('Alerts state is invalid JSON.', error);
  }
  if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype ||
      Object.keys(envelope).length !== 3 || envelope.version !== 1 ||
      typeof envelope.sealed !== 'string' || !/^[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2})+$/.test(envelope.sealed) ||
      typeof envelope.mac !== 'string' || !/^[0-9a-f]{64}$/i.test(envelope.mac)) {
    throw stateError('Alerts state format is invalid.');
  }
  if (!timingSafeEqual(Buffer.from(macFor(envelope.sealed), 'hex'), Buffer.from(envelope.mac, 'hex'))) {
    throw stateError('Alerts state authentication failed. Check the file and SECRET_KEY belong together.');
  }
  const payload = open(envelope.sealed, SEAL_CONTEXT);
  if (payload === null) throw stateError('Alerts state could not be opened.');
  let state;
  try {
    state = JSON.parse(payload);
  } catch (error) {
    throw stateError('Alerts state payload is invalid JSON.', error);
  }
  const verdict = validateAlertsState(state);
  if (!verdict.ok) throw stateError(verdict.message);
  return state;
}

// Rename commits the state; directory fsync confirms its durability.
function atomicWrite(contents) {
  const temporary = join(config.dataDir, `.qm-alerts-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  let written;
  try {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700);
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    chmodSync(temporary, 0o600);
    written = fstatSync(fd, { bigint: true });
    renameSync(temporary, ALERTS_STATE_FILE);
  } catch (cause) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(temporary); } catch { /* already gone */ }
    throw stateError('Alerts state could not be written. The stored file is unchanged.', cause);
  }
  let stamp = null;
  try {
    const committed = fstatSync(fd, { bigint: true });
    if (committed.size === written.size && committed.mtimeNs === written.mtimeNs) stamp = stampOf(committed);
    closeSync(fd);
    fd = undefined;
    const directory = openSync(config.dataDir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (cause) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    return { durable: false, cause };
  }
  return { durable: true, stamp };
}

function prune(state) {
  if (Array.isArray(state.history)) state.history.sort((a, b) => b?.at - a?.at).splice(MAX_ALERT_HISTORY);
  const sourceIds = Array.isArray(state.sources) ? new Set(state.sources.map((source) => source?.id)) : null;
  if (state.samples && Object.getPrototypeOf(state.samples) === Object.prototype) {
    for (const [id, samples] of Object.entries(state.samples)) {
      if (sourceIds && !sourceIds.has(id)) delete state.samples[id];
      else if (Array.isArray(samples)) samples.sort((a, b) => b?.at - a?.at).splice(MAX_ALERT_SAMPLES);
    }
  }
  if (state.throttle && Object.getPrototypeOf(state.throttle) === Object.prototype && sourceIds) {
    for (const key of Object.keys(state.throttle)) {
      if (!sourceIds.has(key.split(':')[0])) delete state.throttle[key];
    }
  }
  if (Array.isArray(state.receipts)) {
    state.receipts = state.receipts.filter((receipt) => !Number.isSafeInteger(receipt?.at) || receipt.at < 0 ||
      receipt.at > Date.now() - ALERT_RECEIPT_TTL_MS).sort((a, b) => b?.at - a?.at).slice(0, MAX_ALERT_RECEIPTS);
  }
  return state;
}

function boundedPayload(state) {
  const payload = JSON.stringify(state);
  let bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes <= MAX_PAYLOAD_BYTES) return payload;
  const oldest = Object.entries(state.samples).flatMap(([sourceId, samples]) =>
    samples.map((sample, index) => ({ sourceId, sample, index })))
    .sort((a, b) => a.sample.at - b.sample.at || b.index - a.index);
  // GCM preserves byte length; the envelope stores ciphertext as hex.
  for (const { sourceId, sample } of oldest) {
    const samples = state.samples[sourceId];
    bytes -= Buffer.byteLength(JSON.stringify(sample), 'utf8') + (samples.length > 1 ? 1 : 0);
    samples.pop();
    if (bytes <= MAX_PAYLOAD_BYTES) return JSON.stringify(state);
  }
  throw stateError('Alerts state exceeds the size cap.');
}

function commit(candidate) {
  assertUsable();
  if (!candidate || typeof candidate !== 'object' || typeof candidate.then === 'function') {
    throw stateError('Alerts state must be a synchronous payload.');
  }
  const next = prune(candidate);
  const verdict = validateAlertsState(next);
  if (!verdict.ok) throw stateError(verdict.message);
  const encoded = encode(boundedPayload(next));
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ALERTS_STATE_BYTES) throw stateError('Alerts state exceeds the size cap.');
  const outcome = atomicWrite(encoded);
  cached = structuredClone(next);
  if (!outcome.durable) {
    poisoned = true;
    throw stateError('Alerts state was committed, but directory fsync failed. Restart Companion before changing alerts.', outcome.cause);
  }
  indexSources(next, outcome.stamp);
  return structuredClone(cached);
}

function withStateLock(run) {
  try {
    return withFileLock({
      lockPath: ALERTS_STATE_LOCK,
      lockDir: config.dataDir,
      timeoutCode: 'QM_ALERTS_LOCK_TIMEOUT',
      failedCode: 'QM_ALERTS_LOCK_FAILED',
      contendedMessage: 'another process is holding the alerts state lock; nothing was changed',
    }, run);
  } catch (error) {
    if (error?.code === 'QM_ALERTS_LOCK_TIMEOUT' || error?.code === 'QM_ALERTS_LOCK_FAILED') {
      throw stateError('Alerts state could not be locked. Nothing was changed.', error);
    }
    throw error;
  }
}

function readState() {
  let fd;
  let stamp = null;
  try {
    fd = openSync(ALERTS_STATE_FILE, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    stamp = stampOf(before);
    if (!before.isFile()) throw stateError('Alerts state is not a regular file.');
    if (before.size > BigInt(MAX_ALERTS_STATE_BYTES)) throw stateError('Alerts state exceeds the size cap.');
    const raw = Buffer.allocUnsafe(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < raw.length) {
      const count = readSync(fd, raw, bytes, raw.length - bytes, bytes);
      if (count === 0) break;
      bytes += count;
    }
    const after = fstatSync(fd, { bigint: true });
    closeSync(fd);
    fd = undefined;
    if (stampOf(after) !== stamp) {
      stamp = null;
      throw stateError('Alerts state changed while it was being read. Try again.');
    }
    const state = decode(raw.subarray(0, bytes));
    if (fileStamp() !== stamp) {
      stamp = null;
      throw stateError('Alerts state changed while it was being read. Try again.');
    }
    indexSources(state, stamp);
    return state;
  } catch (error) {
    const failure = error?.code === 'ENOENT' || error?.code === 'QM_ALERTS_STATE_INVALID'
      ? error : stateError('Alerts state could not be read.', error);
    sourceIndex = null;
    try {
      if (stamp !== null && fileStamp() === stamp) sourceIndex = { stamp, entries: [], error: failure };
    } catch { /* changed or removed files cannot retain a cached refusal */ }
    throw failure;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function internalLoad() {
  try {
    cached = readState();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return withStateLock(() => {
      try {
        cached = readState();
      } catch (again) {
        if (again?.code !== 'ENOENT') throw again;
        commit({ sources: [], devices: [], history: [], samples: {}, throttle: {}, receipts: [] });
      }
      return cached;
    });
  }
  return cached;
}

function transact(run) {
  assertUsable();
  if (updating) throw stateError('Alerts state update is already in progress.');
  return withStateLock(() => {
    updating = true;
    cached = null;
    try { return run(); } finally { updating = false; }
  });
}

export function loadAlertsState() {
  assertUsable();
  return structuredClone(internalLoad());
}

export function findAlertSource(secret) {
  assertUsable();
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  try {
    const stamp = fileStamp();
    if (sourceIndex?.stamp !== stamp) readState();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sourceIndex = null;
      return null;
    }
    if (error?.code === 'QM_ALERTS_STATE_INVALID') throw error;
    sourceIndex = null;
    throw stateError('Alerts state could not be read.', error);
  }
  if (sourceIndex.error) throw sourceIndex.error;
  const digest = createHash('sha256').update(secret).digest();
  let matched = null;
  for (const entry of sourceIndex.entries) {
    if (timingSafeEqual(digest, entry.digest)) matched = entry.source;
  }
  return matched ? { ...matched } : null;
}

export function saveAlertsState(state) {
  return transact(() => {
    internalLoad();
    return commit(structuredClone(state));
  });
}

export function updateAlertsState(mutate) {
  return transact(() => {
    const working = structuredClone(internalLoad());
    return commit(mutate(working) ?? working);
  });
}

export function removeAlertsDevice(deviceId) {
  if (!existsSync(ALERTS_STATE_FILE)) return null;
  return updateAlertsState((state) => {
    state.devices = state.devices.filter((device) => device.deviceId !== deviceId);
    state.receipts = state.receipts.filter((receipt) => receipt.deviceId !== deviceId);
  });
}

export function removeAllAlertsDevices() {
  if (!existsSync(ALERTS_STATE_FILE)) return null;
  return updateAlertsState((state) => {
    state.devices = [];
    state.receipts = [];
  });
}
