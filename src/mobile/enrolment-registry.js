// Process-local pending enrolments with durable state in the mobile sidecar.

import { MAX_SPENT_CAPABILITIES } from './schema.js';

export const ENROLMENT_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
export const REFRESH_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const ACK_RECOVERY_MS = 24 * 60 * 60 * 1000;
export const SPENT_SKEW_MS = 48 * 60 * 60 * 1000;
export const MAX_LIVE_ENROLMENTS = 8;

export const TERMINAL = Object.freeze(['expired', 'rejected', 'cancelled', 'consumed']);

export const enrolments = new Map(); // enrolmentId -> enrolment record

export function now() {
  return Date.now();
}

export function fail(code, message, status = 400) {
  return { ok: false, code, message, status };
}

export function sweep(at = now()) {
  for (const rec of enrolments.values()) {
    if (TERMINAL.includes(rec.state)) continue;
    if (rec.state === 'acknowledged') {
      if (at >= rec.ackRecoveryExpiresAt) rec.state = 'consumed';
      continue;
    }
    if (at >= rec.expiresAt) rec.state = 'expired';
  }
}

/** Prune expired spent records, returning false at capacity. */
export function pruneSpent(state, at) {
  state.spentCapabilities = state.spentCapabilities.filter((entry) => at < entry.expiresAt + SPENT_SKEW_MS);
  return state.spentCapabilities.length < MAX_SPENT_CAPABILITIES;
}

export function isLive(rec) {
  return !TERMINAL.includes(rec.state) && rec.state !== 'acknowledged';
}

/** Clear process-local enrolment state. */
export function resetEnrolmentsForTest() {
  enrolments.clear();
}
