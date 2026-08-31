// Authenticated monotonic facts for mobile-sidecar rollback detection.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { config } from '../config.js';
import { mobileEpochKey } from './keys.js';

export const MOBILE_EPOCH_FILE = join(config.dataDir, 'qm-mobile-epoch-v1.json');
const FORMAT = 1;
const MAC_CONTEXT = 'qm-companion:mobile-epoch:v1\0';
const HEX64_RE = /^[0-9a-f]{64}$/;
/** Maximum retained revoked device families. */
export const MAX_REVOKED = 512;
/** Device ids are base64url of 16 bytes (schema.js B64URL16_RE). */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_EPOCH_BYTES = 64 * 1024;

function macFor(payload) {
  return createHmac('sha256', mobileEpochKey).update(MAC_CONTEXT).update(payload, 'utf8').digest('hex');
}

/** Canonical representation used for authentication. */
function canonical(epoch) {
  return JSON.stringify({
    devicesSeen: epoch.devicesSeen === true,
    originBound: epoch.originBound === true,
    revoked: [...epoch.revoked].sort(),
  });
}

/** Read the high-water file as `none`, `unreadable`, or `ok`. */
export function readEpoch() {
  if (!existsSync(MOBILE_EPOCH_FILE)) return { state: 'none' };
  let raw;
  try {
    raw = readFileSync(MOBILE_EPOCH_FILE);
  } catch (cause) {
    return { state: 'unreadable', detail: `it could not be read (${cause?.code || 'error'})` };
  }
  if (raw.length > MAX_EPOCH_BYTES) return { state: 'unreadable', detail: 'it is too large' };
  let envelope;
  try {
    envelope = JSON.parse(raw.toString('utf8'));
  } catch {
    return { state: 'unreadable', detail: 'it is not valid JSON' };
  }
  if (
    !envelope
    || Object.getPrototypeOf(envelope) !== Object.prototype
    || Object.keys(envelope).length !== 3
    || envelope.version !== FORMAT
    || typeof envelope.payload !== 'string'
    || typeof envelope.mac !== 'string'
    || !HEX64_RE.test(envelope.mac)
  ) {
    return { state: 'unreadable', detail: 'its format is invalid' };
  }
  const expected = Buffer.from(macFor(envelope.payload), 'hex');
  const supplied = Buffer.from(envelope.mac, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { state: 'unreadable', detail: 'authentication failed, so it does not match this SECRET_KEY' };
  }
  let parsed;
  try {
    parsed = JSON.parse(envelope.payload);
  } catch {
    return { state: 'unreadable', detail: 'its payload is not valid JSON' };
  }
  if (
    !parsed
    || Object.getPrototypeOf(parsed) !== Object.prototype
    || Object.keys(parsed).sort().join(',') !== 'devicesSeen,originBound,revoked'
    || typeof parsed.devicesSeen !== 'boolean'
    || typeof parsed.originBound !== 'boolean'
    || !Array.isArray(parsed.revoked)
    || parsed.revoked.length > MAX_REVOKED
    || !parsed.revoked.every((d) => typeof d === 'string' && DEVICE_ID_RE.test(d))
  ) {
    return { state: 'unreadable', detail: 'its payload is not the expected shape' };
  }
  const epoch = {
    devicesSeen: parsed.devicesSeen,
    originBound: parsed.originBound,
    revoked: new Set(parsed.revoked),
  };
  if (canonical(epoch) !== envelope.payload) {
    return { state: 'unreadable', detail: 'its payload is not canonical' };
  }
  return { state: 'ok', epoch };
}

function atomicWrite(contents) {
  const tmp = join(config.dataDir, `.qm-mobile-epoch-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, MOBILE_EPOCH_FILE);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(tmp); } catch { /* nothing left behind */ }
    throw error;
  }
  try {
    const dir = openSync(config.dataDir, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    // Sidecar state may advance before this record after an fsync failure.
  }
}

/** Raise monotonic epoch facts. */
export function raiseEpoch({ revokedDevices = [], originBound = false, devicesSeen = false } = {}) {
  const current = readEpoch();
  // Preserve an unreadable record for the caller to report.
  if (current.state === 'unreadable') return current;
  const revoked = new Set(current.state === 'ok' ? current.epoch.revoked : []);
  for (const id of revokedDevices) {
    if (typeof id === 'string' && DEVICE_ID_RE.test(id)) revoked.add(id);
  }
  const next = {
    devicesSeen: (current.state === 'ok' && current.epoch.devicesSeen) || devicesSeen === true,
    originBound: (current.state === 'ok' && current.epoch.originBound) || originBound === true,
    // Refuse growth at the cap because canonical sorting provides no safe eviction order.
    revoked: revoked.size > MAX_REVOKED ? null : revoked,
  };
  if (next.revoked === null) {
    return { state: 'full', epoch: current.state === 'ok' ? current.epoch : { devicesSeen: next.devicesSeen, originBound: next.originBound, revoked: new Set() } };
  }
  const alreadyCurrent = current.state === 'ok'
    && current.epoch.devicesSeen === next.devicesSeen
    && current.epoch.originBound === next.originBound
    && current.epoch.revoked.size === next.revoked.size
    && [...next.revoked].every((d) => current.epoch.revoked.has(d));
  if (alreadyCurrent) return { state: 'ok', epoch: next };
  const payload = canonical(next);
  atomicWrite(`${JSON.stringify({ version: FORMAT, payload, mac: macFor(payload) }, null, 2)}\n`);
  return { state: 'ok', epoch: next };
}

/** Compare a loaded sidecar with the high-water mark and return a mismatch reason, if any. */
export function rollbackReason(state, epoch) {
  for (const device of state.devices) {
    if (device.revokedAt !== null) continue;
    if (epoch.revoked.has(device.deviceId)) {
      return `device ${device.deviceId} is recorded as revoked but the sidecar presents it as live`;
    }
  }
  return null;
}

/** Report whether state contains any current or revoked device. */
export function hasEverPairedIn(state) {
  return Array.isArray(state?.devices) && state.devices.length > 0;
}

/** Return all revoked device IDs recorded by state. */
export function revokedDevicesOf(state) {
  const ids = [];
  for (const device of state.devices) {
    if (device.revokedAt !== null && typeof device.deviceId === 'string') ids.push(device.deviceId);
  }
  return ids;
}
