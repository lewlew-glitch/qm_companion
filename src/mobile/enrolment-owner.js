// Browser-session controls for mobile enrolment.

import { randomBytes } from 'node:crypto';

import { loadMobileState } from './store.js';
import { digestToken, mintToken, parseToken } from './token-family.js';
import {
  ENROLMENT_TTL_MS, MAX_LIVE_ENROLMENTS, TERMINAL, enrolments, fail, isLive, now, pruneSpent, sweep,
} from './enrolment-registry.js';

const FAMILIES = Object.freeze(['qmp', 'qme']);

/** Create a typed or scanned pairing capability and retain only its digest. */
export function createEnrolment({ family = 'qmp' } = {}) {
  if (!FAMILIES.includes(family)) throw new Error('unknown enrolment family');
  const at = now();
  sweep(at);
  const live = [...enrolments.values()].filter(isLive);
  if (live.length >= MAX_LIVE_ENROLMENTS) return fail('too_many_enrolments', 'Finish or reject the pending pairings first.', 409);
  const state = loadMobileState();
  if (!pruneSpent(state, at)) return fail('spent_records_full', 'The spent pairing record table is full; wait for old records to expire.', 503);
  const pairingKey = mintToken(family);
  const parsed = parseToken(pairingKey);
  const enrolmentId = randomBytes(16).toString('base64url');
  enrolments.set(enrolmentId, {
    enrolmentId,
    state: 'created',
    createdAt: at,
    expiresAt: at + ENROLMENT_TTL_MS,
    capability: { family, digest: digestToken(family, parsed.bytes) },
  });
  return { ok: true, enrolmentId, family, pairingKey, expiresAt: at + ENROLMENT_TTL_MS };
}

export function rejectEnrolment(enrolmentId) {
  sweep();
  const rec = enrolments.get(enrolmentId);
  if (!rec) return fail('not_found', 'No such pairing.', 404);
  if (rec.state === 'acknowledged' || rec.state === 'consumed') return fail('already_active', 'That pairing already activated a device; revoke the device instead.', 409);
  if (!TERMINAL.includes(rec.state)) rec.state = 'rejected';
  return { ok: true, state: rec.state };
}

export function deleteEnrolment(enrolmentId) {
  const rec = enrolments.get(enrolmentId);
  if (!rec) return fail('not_found', 'No such pairing.', 404);
  if (rec.state === 'acknowledged' && now() < rec.ackRecoveryExpiresAt) return fail('recovery_window', 'That pairing is inside its acknowledgement recovery window.', 409);
  enrolments.delete(enrolmentId);
  return { ok: true };
}

/** Owner approval facts: transcript facts and the server-derived SAS only. */
export function enrolmentForOwner(enrolmentId) {
  sweep();
  const rec = enrolments.get(enrolmentId);
  if (!rec) return null;
  return {
    enrolmentId,
    state: rec.state,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    transcript: rec.transcript ? {
      deviceName: rec.transcript.deviceName,
      origin: rec.transcript.origin,
      serverSigningFingerprint: rec.transcript.serverSigningFingerprint,
      tlsLeafFingerprint: rec.transcript.tlsLeafFingerprint,
      requestedScopes: rec.transcript.requestedScopes,
    } : null,
    sasWords: rec.sas ? rec.sas.words : null,
  };
}

export function listEnrolmentsForOwner() {
  sweep();
  return [...enrolments.keys()].map(enrolmentForOwner);
}
