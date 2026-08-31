// Mint a QMC2 capability and render its PNG data URL without logging or storage.

import QRCode from 'qrcode';

import { createEnrolment } from './enrolment-owner.js';
import { loadMobileState } from './store.js';
import { buildQrPayload } from './qr.js';

export async function renderQrEnrolment(origin) {
  let fingerprint;
  try {
    fingerprint = loadMobileState().identity.fingerprint;
  } catch {
    return { ok: false, code: 'identity_unavailable', message: 'The server identity is not available yet.', status: 503 };
  }
  const made = createEnrolment({ family: 'qme' });
  if (!made.ok) return made;
  const qr = buildQrPayload(origin, made.pairingKey, fingerprint);
  const qrPng = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
  return { ok: true, enrolmentId: made.enrolmentId, expiresAt: made.expiresAt, qr, qrPng };
}
