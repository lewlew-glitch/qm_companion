// Browser authentication plane with double-submit protection and transport-bound sessions.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { attemptLogin, claimPassword, completeMfa, createSession, destroySession, ipThrottled, MAX_PASSWORD_CHARS, sessionFor } from './auth.js';
import { appendCookie, cookie, html, parseCookies, peerIp, readBody, redirect, send } from './http.js';
import { clearSetupToken, setupTokenMatches } from './setup-token.js';
import { loginPage, mfaPage, setupPage } from './ui/views.js';

const LOGIN_FORM_TTL_MS = 10 * 60 * 1000;
const MAX_LOGIN_FORMS = 1_000;

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validLoginToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

/**
 * @param {object} spec
 * @param {string} spec.sessionCookie   cookie name for this plane's session
 * @param {string} spec.formCookie      cookie name for this plane's sign-in form guard
 * @param {() => boolean} spec.secure   whether cookies carry Secure (a function: config is live)
 * @param {boolean} [spec.tls]          true when this plane is HTTPS-only; marks and requires it
 * @param {string} [spec.home]          redirect target after sign-in
 * @param {number} spec.sessionTtlMs
 */
export function createAuthPlane({ sessionCookie, formCookie, secure, tls = false, home = '/', sessionTtlMs }) {
  const loginForms = new Map();

  const issueLoginForm = (req, res, purpose) => {
    const now = Date.now();
    for (const [id, record] of loginForms) {
      if (record.expiresAt <= now) loginForms.delete(id);
    }
    while (loginForms.size >= MAX_LOGIN_FORMS) loginForms.delete(loginForms.keys().next().value);
    const cookies = parseCookies(req.headers.cookie);
    const browserToken = validLoginToken(cookies[formCookie]) ? cookies[formCookie] : randomBytes(32).toString('base64url');
    const formToken = randomBytes(32).toString('base64url');
    loginForms.set(tokenHash(formToken), {
      browserHash: tokenHash(browserToken),
      expiresAt: now + LOGIN_FORM_TTL_MS,
      purpose,
    });
    appendCookie(res, cookie(formCookie, browserToken, { secure: secure(), maxAge: LOGIN_FORM_TTL_MS / 1000 }));
    return formToken;
  };

  const consumeLoginForm = (req, candidate, purpose) => {
    const formToken = String(candidate || '');
    const browserToken = parseCookies(req.headers.cookie)[formCookie];
    if (!validLoginToken(formToken) || !validLoginToken(browserToken)) return false;
    const id = tokenHash(formToken);
    const record = loginForms.get(id);
    // Consume the form token before password or MFA work.
    loginForms.delete(id);
    if (!record || record.expiresAt <= Date.now() || record.purpose !== purpose) return false;
    const expected = Buffer.from(record.browserHash, 'hex');
    const supplied = Buffer.from(tokenHash(browserToken), 'hex');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };

  const clearLoginForms = (req, res) => {
    const browserToken = parseCookies(req.headers.cookie)[formCookie];
    if (validLoginToken(browserToken)) {
      const browserHash = tokenHash(browserToken);
      for (const [id, record] of loginForms) {
        if (record.browserHash === browserHash) loginForms.delete(id);
      }
    }
    appendCookie(res, cookie(formCookie, '', { secure: secure(), expire: true }));
  };

  const sessionToken = (req) => parseCookies(req.headers.cookie)[sessionCookie] || '';

  const setSessionCookie = (res, token) => {
    appendCookie(res, cookie(sessionCookie, token, { secure: secure(), maxAge: sessionTtlMs / 1000 }));
  };

  /** Clear a cookie using its original attributes. */
  const clearSessionCookie = (res) => {
    appendCookie(res, cookie(sessionCookie, '', { secure: secure(), expire: true }));
  };

  /** Resolve a session for this transport plane. */
  const sessionOf = (token) => sessionFor(token, tls ? 'tls' : 'http');

  const renderLoginForm = (req, res, status, error = null) =>
    html(res, status, loginPage(error, issueLoginForm(req, res, 'login')));

  const renderMfaForm = (req, res, status, ticket, error = null) =>
    html(res, status, mfaPage(ticket, error, issueLoginForm(req, res, 'mfa')));

  const handleLogin = async (req, res, method) => {
    if (method === 'GET') return renderLoginForm(req, res, 200);
    if (method !== 'POST') return send(res, 404, 'Not found');
    const body = await readBody(req);
    if (!consumeLoginForm(req, body.formToken, 'login')) {
      return renderLoginForm(req, res, 403, 'This sign-in page expired. Reload it and try again.');
    }
    const ip = peerIp(req);
    if (ipThrottled(ip)) return renderLoginForm(req, res, 429, 'Too many attempts. Wait a few minutes.');
    const result = await attemptLogin(String(body.password || ''), ip, { tls });
    if (!result) return renderLoginForm(req, res, 401, 'Wrong password.');
    if (result.mfa) return renderMfaForm(req, res, 200, result.mfa);
    clearLoginForms(req, res);
    setSessionCookie(res, result.session.token);
    return redirect(res, home);
  };

  const handleLoginMfa = async (req, res) => {
    const body = await readBody(req);
    if (!consumeLoginForm(req, body.formToken, 'mfa')) {
      return renderLoginForm(req, res, 403, 'This two-factor page expired. Sign in again.');
    }
    const ip = peerIp(req);
    if (ipThrottled(ip)) return renderLoginForm(req, res, 429, 'Too many attempts. Wait a few minutes.');
    const ticket = String(body.ticket || '');
    const session = await completeMfa(ticket, String(body.code || ''), ip, { tls });
    if (!session) return renderMfaForm(req, res, 401, ticket, 'Wrong code. After too many tries, start again.');
    clearLoginForms(req, res);
    setSessionCookie(res, session.token);
    return redirect(res, home);
  };

  /** First-run setup shared by whichever browser plane currently owns authentication. */
  const handleSetup = async (req, res, method) => {
    if (method === 'GET') return html(res, 200, setupPage());
    if (method !== 'POST') return send(res, 404, 'Not found');
    const body = await readBody(req);
    if (!setupTokenMatches(body.setupToken)) return html(res, 403, setupPage('The setup token did not match. Check the Companion server log.'));
    const pw = String(body.password || '');
    if (pw.length < 10) return html(res, 400, setupPage('Use at least 10 characters.'));
    if (pw.length > MAX_PASSWORD_CHARS) return html(res, 400, setupPage(`Use at most ${MAX_PASSWORD_CHARS} characters.`));
    if (!claimPassword(pw)) {
      clearSetupToken();
      return send(res, 409, 'Setup has already been completed. Sign in instead.');
    }
    clearSetupToken();
    const { token } = createSession({ tls });
    setSessionCookie(res, token);
    return redirect(res, home);
  };

  const handleLogout = (req, res) => {
    destroySession(sessionToken(req));
    clearSessionCookie(res);
    return redirect(res, '/login');
  };

  return {
    sessionCookie,
    formCookie,
    tls,
    issueLoginForm,
    consumeLoginForm,
    clearLoginForms,
    sessionToken,
    sessionOf,
    setSessionCookie,
    clearSessionCookie,
    renderLoginForm,
    renderMfaForm,
    handleSetup,
    handleLogin,
    handleLoginMfa,
    handleLogout,
    newSession: () => createSession({ tls }),
  };
}
