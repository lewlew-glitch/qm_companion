// Login, sessions, CSRF, and peer-address throttling.

import { scryptSync, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { claimOwner, getOwner, setOwner, hasOwner } from './store.js';
import { seal, open } from './secrets.js';
import { verifyTotp } from './totp.js';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const MAX_PASSWORD_CHARS = 256;

function eq(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Passwords.

function passwordRecord(pw, previous = {}) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pw).normalize('NFKC'), salt, 64, SCRYPT);
  return {
    ...previous,
    saltHex: salt.toString('hex'),
    hashHex: hash.toString('hex'),
    createdAt: previous.createdAt || Date.now(),
  };
}

// Atomically claim the empty owner slot during setup.
export function claimPassword(pw) {
  // Avoid password hashing after the owner slot has been claimed.
  if (hasOwner()) return false;
  const value = String(pw);
  if (value.length === 0 || value.length > MAX_PASSWORD_CHARS) return false;
  return claimOwner(passwordRecord(value));
}

export function setPassword(pw) {
  const previous = getOwner();
  if (!previous) throw new Error('owner must be claimed before changing its password');
  const value = String(pw);
  if (value.length === 0 || value.length > MAX_PASSWORD_CHARS) throw new Error('password is outside the allowed length');
  setOwner(passwordRecord(value, previous));
  revokeAuthenticationState();
}

// Preserve other owner fields during password changes.
export function changePassword(current, next, opts = {}) {
  const value = String(next);
  if (!checkPassword(current) || value.length === 0 || value.length > MAX_PASSWORD_CHARS) return null;
  setPassword(value);
  return { session: createSession(opts) };
}

export function setDisplayName(name) {
  const owner = getOwner();
  if (!owner) return;
  setOwner({ ...owner, name: String(name || '').slice(0, 40) });
}

export function ownerInfo() {
  const o = getOwner() || {};
  return { name: o.name || 'Admin', createdAt: o.createdAt || null, lastLoginAt: o.lastLoginAt || null };
}

function stampLogin() {
  const owner = getOwner();
  if (owner) setOwner({ ...owner, lastLoginAt: Date.now() });
}

function checkPassword(pw) {
  const owner = getOwner();
  if (!owner) return false;
  const value = String(pw);
  if (value.length === 0 || value.length > MAX_PASSWORD_CHARS) return false;
  const hash = scryptSync(value.normalize('NFKC'), Buffer.from(owner.saltHex, 'hex'), 64, SCRYPT);
  return eq(hash, Buffer.from(owner.hashHex, 'hex'));
}

// Require password reauthentication and current MFA before raising Docker access.
export async function verifyOwnerStepUp(pw, code, ip) {
  noteIp(ip);
  if (ipThrottled(ip) || !checkPassword(pw)) {
    await delay(200);
    return false;
  }
  if (mfaEnabled()) {
    const mfa = readMfa();
    if (!mfa || (!verifyTotp(Buffer.from(mfa.secretHex, 'hex'), code) && !consumeRecovery(mfa, code))) {
      await delay(200);
      return false;
    }
  }
  clearIp(ip);
  return true;
}

// In-memory sessions keyed by token hash.
const sessions = new Map();

function tokenId(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession({ tls = false } = {}) {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  sessions.set(tokenId(token), { created: Date.now(), csrf, tls: tls === true });
  return { token, csrf, tls: tls === true };
}

/** Return a session only on the transport plane that created it. */
export function sessionFor(token, plane) {
  if (plane !== 'http' && plane !== 'tls') {
    throw new Error("sessionFor requires the plane it is being asked for: 'http' or 'tls'");
  }
  if (!token) return null;
  const s = sessions.get(tokenId(token));
  if (!s) return null;
  if (Date.now() - s.created > config.sessionTtlMs) {
    sessions.delete(tokenId(token));
    return null;
  }
  // Enforce the session's stored transport plane.
  if ((s.tls === true) !== (plane === 'tls')) return null;
  return s;
}

export function destroySession(token) {
  if (token) sessions.delete(tokenId(token));
}

/** Check CSRF against a session on the same transport plane. */
export function checkCsrf(token, sent, plane) {
  const s = sessionFor(token, plane);
  return !!s && !!sent && eq(s.csrf, sent);
}

function revokeAuthenticationState() {
  sessions.clear();
  tickets.clear();
}

// Login throttle keyed by socket address.

const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX = 30;
const MAX_TRACKED_IPS = 10_000;

const ipHits = new Map(); // ip -> { count, resetAt }

function ipKey(ip) {
  return String(ip || 'unknown').slice(0, 128);
}

export function ipThrottled(ip) {
  const now = Date.now();
  const key = ipKey(ip);
  const rec = ipHits.get(key);
  if (!rec || now >= rec.resetAt) {
    if (rec) ipHits.delete(key);
    return false;
  }
  return rec.count >= IP_MAX;
}

function noteIp(ip) {
  const now = Date.now();
  const key = ipKey(ip);
  const rec = ipHits.get(key);
  if (!rec || now >= rec.resetAt) {
    if (ipHits.size >= MAX_TRACKED_IPS) {
      for (const [candidate, value] of ipHits) {
        if (now >= value.resetAt) ipHits.delete(candidate);
      }
      if (ipHits.size >= MAX_TRACKED_IPS) ipHits.delete(ipHits.keys().next().value);
    }
    ipHits.set(key, { count: 1, resetAt: now + IP_WINDOW_MS });
  } else {
    rec.count += 1;
  }
  return key;
}

function clearIp(ip) {
  ipHits.delete(ipKey(ip));
}

// Use one failure shape and comparable password-check work for invalid logins.
export async function attemptLogin(pw, ip, opts = {}) {
  noteIp(ip);
  if (ipThrottled(ip) || !hasOwner()) {
    await delay(200);
    return null;
  }
  const ok = checkPassword(pw);
  if (!ok) {
    await delay(200);
    return null;
  }
  if (mfaEnabled()) return { mfa: createMfaTicket(ip) };
  clearIp(ip);
  stampLogin();
  return { session: createSession(opts) };
}

// TOTP and recovery codes.

const MFA_AAD = 'owner-mfa';
const TICKET_TTL_MS = 5 * 60 * 1000;
const TICKET_MAX_TRIES = 5;
const tickets = new Map(); // sha256(ticket) -> { created, tries, ip }

export function mfaEnabled() {
  const owner = getOwner();
  return !!(owner && owner.mfaEnc);
}

function readMfa() {
  const owner = getOwner();
  if (!owner || !owner.mfaEnc) return null;
  try {
    return JSON.parse(open(owner.mfaEnc, MFA_AAD));
  } catch {
    return null;
  }
}

function createMfaTicket(ip) {
  const ticket = randomBytes(32).toString('hex');
  tickets.set(tokenId(ticket), { created: Date.now(), tries: 0, ip: ipKey(ip) });
  return ticket;
}

// Exchange a valid MFA or recovery code for a session and consume the ticket.
export async function completeMfa(ticket, code, ip, opts = {}) {
  noteIp(ip);
  if (ipThrottled(ip)) {
    await delay(200);
    return null;
  }
  const id = tokenId(ticket || '');
  const t = tickets.get(id);
  if (!t || Date.now() - t.created > TICKET_TTL_MS) {
    tickets.delete(id);
    await delay(200);
    return null;
  }
  if (t.ip !== ipKey(ip)) {
    await delay(200);
    return null;
  }
  t.tries += 1;
  if (t.tries > TICKET_MAX_TRIES) {
    tickets.delete(id);
    await delay(200);
    return null;
  }
  const mfa = readMfa();
  if (!mfa) {
    tickets.delete(id);
    // Fail closed if MFA state changes after password verification.
    await delay(200);
    return null;
  }
  if (verifyTotp(Buffer.from(mfa.secretHex, 'hex'), code)) {
    tickets.delete(id);
    clearIp(ip);
    stampLogin();
    return createSession(opts);
  }
  const burned = consumeRecovery(mfa, code);
  if (burned) {
    tickets.delete(id);
    clearIp(ip);
    stampLogin();
    return createSession(opts);
  }
  await delay(200);
  return null;
}

function consumeRecovery(mfa, code) {
  const cleaned = String(code || '').replace(/[\s-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{10}$/.test(cleaned)) return false;
  const hash = createHash('sha256').update(cleaned).digest('hex');
  const at = (mfa.recovery || []).indexOf(hash);
  if (at === -1) return false;
  mfa.recovery.splice(at, 1);
  const owner = getOwner();
  setOwner({ ...owner, mfaEnc: seal(JSON.stringify(mfa), MFA_AAD) });
  return true;
}

// Verify and seal a new MFA secret, returning recovery codes once.
export function enableMfa(secretHex, code, opts = {}) {
  if (mfaEnabled()) return null;
  if (!verifyTotp(Buffer.from(secretHex, 'hex'), code)) return null;
  const plain = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
  const recovery = plain.map((c) => createHash('sha256').update(c).digest('hex'));
  const owner = getOwner();
  setOwner({ ...owner, mfaEnc: seal(JSON.stringify({ secretHex, recovery }), MFA_AAD) });
  revokeAuthenticationState();
  return { recoveryCodes: plain, session: createSession(opts) };
}

// Require a current code to disable MFA.
export function disableMfa(code, opts = {}) {
  const mfa = readMfa();
  if (!mfa) return null;
  const okCode = verifyTotp(Buffer.from(mfa.secretHex, 'hex'), code) || consumeRecovery(mfa, code);
  if (!okCode) return null;
  const owner = getOwner();
  delete owner.mfaEnc;
  setOwner({ ...owner });
  revokeAuthenticationState();
  return { session: createSession(opts) };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Remove expired sessions and MFA tickets hourly.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.created > config.sessionTtlMs) sessions.delete(id);
  for (const [id, t] of tickets) if (now - t.created > TICKET_TTL_MS) tickets.delete(id);
}, 60 * 60 * 1000).unref();
