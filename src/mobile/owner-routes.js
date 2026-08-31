// Session- and CSRF-protected mobile owner operations on the HTTPS surface.

import { json, readBody, redirect, html } from '../http.js';
import { checkCsrf } from '../auth.js';
import { mobileFeatures } from './features.js';
import { mobileListenerStatus } from './listener.js';
import { createEnrolment, deleteEnrolment, enrolmentForOwner, listEnrolmentsForOwner, rejectEnrolment } from './enrolment-owner.js';
import { approveEnrolment } from './enrolment.js';
import { forgetDevice, listDevices, renameDevice, revokeDevice } from './devices.js';
import { loadMobileState } from './store.js';
import { devicesPage, devicesGrid } from '../ui/pages/devices.js';
import { renderQrEnrolment } from './qr-render.js';

const ID_RE = /^[A-Za-z0-9_-]{22}$/;

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function deviceModel(secure) {
  return {
    plane: mobileListenerStatus(),
    // Pending enrolments are excluded from plaintext rendering.
    enrolments: secure ? safe(listEnrolmentsForOwner, []) : [],
    devices: safe(listDevices, []),
    identity: safe(() => ({ fingerprint: loadMobileState().identity.fingerprint }), null),
    secure,
  };
}

function renderDevices(res, csrf, flash = null, freshKey = null, freshQr = null, secure = true) {
  html(res, 200, devicesPage(deviceModel(secure), csrf, flash, freshKey, freshQr));
}

/** Legacy plaintext view used only when secure owner access is disabled. */
export function renderDevicesReadOnly(res, csrf) {
  renderDevices(res, csrf, null, null, null, false);
}

function errorJson(res, status, code, message) {
  json(res, status, { v: 1, error: { code, message } });
}

function answer(res, outcome, okBody) {
  if (!outcome.ok) errorJson(res, outcome.status || 400, outcome.code, outcome.message);
  else json(res, 200, { v: 1, ...okBody(outcome) });
}

/** JSON rows of the route matrix. Returns true when the request was handled. */
export async function handleMobileOwnerApi(req, res, path, method) {
  const flags = mobileFeatures();
  if (path === '/api/mobile/v1/enrolments' && method === 'POST') {
    const plan = mobileListenerStatus();
    if (!flags.enrolment) errorJson(res, 404, 'not_found', 'Pairing is not enabled.');
    else if (!plan.ok) errorJson(res, 409, 'listener_off', plan.reason);
    else if ((await readBody(req, 4 * 1024)).mode === 'qr') answer(res, await renderQrEnrolment(plan.origin), (o) => ({ enrolmentId: o.enrolmentId, expiresAt: o.expiresAt, origin: plan.origin, qr: o.qr, qrPng: o.qrPng }));
    else answer(res, createEnrolment(), (o) => ({ enrolmentId: o.enrolmentId, pairingKey: o.pairingKey, expiresAt: o.expiresAt, origin: plan.origin }));
    return true;
  }
  const one = /^\/api\/mobile\/v1\/enrolments\/([A-Za-z0-9_-]{22})(\/approve|\/reject)?$/.exec(path);
  if (one) {
    const [, id, action] = one;
    if (!action && method === 'GET') {
      const view = flags.enrolment ? enrolmentForOwner(id) : null;
      if (view) json(res, 200, { v: 1, ...view });
      else errorJson(res, 404, 'not_found', flags.enrolment ? 'No such pairing.' : 'Pairing is not enabled.');
      return true;
    }
    if (!action && method === 'DELETE') {
      answer(res, deleteEnrolment(id), () => ({ deleted: true }));
      return true;
    }
    if (action === '/approve' && method === 'POST') {
      if (!flags.enrolment) errorJson(res, 404, 'not_found', 'Pairing is not enabled.');
      else answer(res, await approveEnrolment(id), (o) => ({ state: 'grant_ready', deviceId: o.deviceId }));
      return true;
    }
    if (action === '/reject' && method === 'POST') {
      answer(res, rejectEnrolment(id), (o) => ({ state: o.state }));
      return true;
    }
  }
  if (path === '/api/mobile/v1/devices' && method === 'GET') {
    json(res, 200, { v: 1, devices: safe(listDevices, []) });
    return true;
  }
  const dev = /^\/api\/mobile\/v1\/devices\/([A-Za-z0-9_-]{22})\/(rename|revoke|forget)$/.exec(path);
  if (dev && method === 'POST') {
    const [, id, action] = dev;
    if (action === 'revoke') answer(res, revokeDevice(id), () => ({ revoked: true }));
    else if (action === 'forget') answer(res, forgetDevice(id), () => ({ forgotten: true }));
    else if (!flags.api) errorJson(res, 404, 'not_found', 'The mobile plane is off.');
    else answer(res, renameDevice(id, (await readBody(req, 4 * 1024)).name), () => ({ renamed: true }));
    return true;
  }
  return false;
}

/** The Devices page and its form posts (body csrf). Returns true when handled. */
export async function handleDevicesPage(req, res, path, method, token, csrf, plane = 'tls') {
  if (path === '/devices' && method === 'GET') {
    renderDevices(res, csrf);
    return true;
  }
  // Use the page renderer for authenticated poll responses.
  if (path === '/devices/live' && method === 'GET') {
    html(res, 200, devicesGrid(deviceModel(true), csrf));
    return true;
  }
  if (!path.startsWith('/devices/') || method !== 'POST') return false;
  const body = await readBody(req, 8 * 1024);
  if (!checkCsrf(token, String(body.csrf || ''), plane)) {
    json(res, 403, { error: 'bad csrf token' });
    return true;
  }
  const id = ID_RE.test(String(body.id || '')) ? String(body.id) : null;
  const flags = mobileFeatures();
  const plan = mobileListenerStatus();
  const flashOf = (o, good) => (o.ok ? good : o.message);
  if (path === '/devices/pair') {
    if (!flags.enrolment || !plan.ok) {
      renderDevices(res, csrf, plan.ok ? 'Pairing is not enabled.' : plan.reason);
      return true;
    }
    const made = createEnrolment();
    if (made.ok) renderDevices(res, csrf, null, { pairingKey: made.pairingKey, expiresAt: made.expiresAt, origin: plan.origin });
    else renderDevices(res, csrf, made.message);
    return true;
  }
  if (path === '/devices/pair-qr') {
    if (!flags.enrolment || !plan.ok) {
      renderDevices(res, csrf, plan.ok ? 'Pairing is not enabled.' : plan.reason);
      return true;
    }
    const made = await renderQrEnrolment(plan.origin);
    // Return the QR image without embedding capability text in HTML.
    if (made.ok) renderDevices(res, csrf, null, null, { qrPng: made.qrPng, expiresAt: made.expiresAt, origin: plan.origin });
    else renderDevices(res, csrf, made.message);
    return true;
  }
  if (!id) {
    redirect(res, '/devices');
    return true;
  }
  if (path === '/devices/approve') {
    if (!flags.enrolment) redirect(res, '/devices');
    else renderDevices(res, csrf, flashOf(await approveEnrolment(id), 'Approved. The phone is finishing the pairing.'));
    return true;
  }
  if (path === '/devices/reject') {
    const rejected = rejectEnrolment(id);
    if (rejected.ok) deleteEnrolment(id);
    renderDevices(res, csrf, flashOf(rejected, 'Pairing removed.'));
    return true;
  }
  if (path === '/devices/revoke') {
    renderDevices(res, csrf, flashOf(revokeDevice(id), 'Device revoked. Its next request is refused.'));
    return true;
  }
  if (path === '/devices/forget') {
    renderDevices(res, csrf, flashOf(forgetDevice(id), 'Device forgotten.'));
    return true;
  }
  if (path === '/devices/rename') {
    renderDevices(res, csrf, flags.api ? flashOf(renameDevice(id, body.name), 'Renamed.') : 'The mobile plane is off.');
    return true;
  }
  return false;
}
