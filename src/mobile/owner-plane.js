// HTTPS owner panel sharing the mobile listener with transport-bound browser sessions.

import { createAuthPlane } from '../auth-plane.js';
import { config } from '../config.js';
import { parseCookies } from '../http.js';
import { createPanelSurface } from '../server.js';
import { handleDevicesPage, handleMobileOwnerApi } from './owner-routes.js';

export const MOBILE_SESSION_COOKIE = 'qm_mobile_sess';
export const MOBILE_LOGIN_FORM_COOKIE = 'qm_mobile_login_form';

/** HSTS stays off while HTTP and HTTPS listeners share a hostname on different ports. */
export const HSTS_SENT = false;

const OWNER_ID_RE = '[A-Za-z0-9_-]{22}';
const ENROLMENT_ONE = new RegExp(`^/api/mobile/v1/enrolments/(${OWNER_ID_RE})(/approve|/reject)?$`);
const DEVICE_ONE = new RegExp(`^/api/mobile/v1/devices/(${OWNER_ID_RE})/(rename|revoke|forget)$`);

/** Handle browser-panel paths and leave device-facing paths to the default-deny router. */
export function isOwnerPath(path, method) {
  if (!path.startsWith('/api/mobile/v1/')) return true;
  if (path === '/api/mobile/v1/enrolments' && method === 'POST') return true;
  if (path === '/api/mobile/v1/devices' && method === 'GET') return true;
  if (ENROLMENT_ONE.test(path)) return true;
  if (DEVICE_ONE.test(path)) return true;
  return false;
}

const authPlane = createAuthPlane({
  sessionCookie: MOBILE_SESSION_COOKIE,
  formCookie: MOBILE_LOGIN_FORM_COOKIE,
  secure: () => true,
  tls: true,
  home: '/',
  sessionTtlMs: config.sessionTtlMs,
});

export { authPlane as mobileOwnerAuthPlane };

/** Build the HTTPS panel, returning false only for device-facing routes. */
export function createOwnerSurface() {
  const servePanel = createPanelSurface({
    authPlane,
    secure: true,
    handleDevicesPage,
    handleMobileOwnerApi,
  });
  return async function serveOwner(req, res) {
    const url = new URL(req.url, 'https://x');
    if (!isOwnerPath(url.pathname, req.method)) return false;
    await servePanel(req, res);
    return true;
  };
}

/** Read the cookie name from a request. */
export function mobileSessionCookieOf(req) {
  return parseCookies(req.headers.cookie)[MOBILE_SESSION_COOKIE] || '';
}
