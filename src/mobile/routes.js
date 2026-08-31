// Default-deny HTTPS device router with bounded no-store responses.

import { json, peerIp, readBody, send } from '../http.js';
import { loadMobileState } from './store.js';
import { openPrivateKey } from './identity.js';
import { API_MAJOR, identitySignedBytes, signIdentity } from './protocol.js';
import { acknowledgeEnrolment, claimEnrolment, enrolmentStatus, retrieveGrant } from './enrolment.js';
import { authenticateAccess, refreshTokens } from './devices.js';
import { containerDetailDto, containersDto, eventsDto, stacksDto, summaryDto, updatesDto } from './summary.js';
import { createLimiter } from './ratelimit.js';

const ENROLMENT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const CAPS = { identity: 2048, claim: 8192, status: 4096, grant: 32768, ack: 2048, refresh: 4096 };
const limiters = {
  ip: createLimiter({ windowMs: 60_000, max: 120 }),
  identity: createLimiter({ windowMs: 60_000, max: 30 }),
  claim: createLimiter({ windowMs: 60_000, max: 10 }),
  enrolment: createLimiter({ windowMs: 60_000, max: 60 }),
  refresh: createLimiter({ windowMs: 60_000, max: 20 }),
  auth: createLimiter({ windowMs: 60_000, max: 60 }),
};

const HEADERS = { 'cache-control': 'no-store, max-age=0', 'referrer-policy': 'no-referrer' };

function error(res, status, code, message, extra = {}) {
  return json(res, status, { v: 1, error: { code, message } }, { ...HEADERS, ...extra });
}

function failure(res, outcome) {
  return error(res, outcome.status || 400, outcome.code, outcome.message);
}

function capped(res, body, cap) {
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text, 'utf8') > cap) return error(res, 500, 'response_too_large', 'The response exceeded its cap.');
  return send(res, 200, text, { 'content-type': 'application/json', ...HEADERS });
}

function limited(res, verdict) {
  return error(res, 429, 'rate_limited', 'Too many requests. Try again shortly.', { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) });
}

function strictString(value, re) {
  return typeof value === 'string' && re.test(value) ? value : null;
}

async function handleIdentity(res, url) {
  const challengeText = strictString(url.searchParams.get('challenge'), /^[A-Za-z0-9_-]{43}$/);
  const challenge = challengeText ? Buffer.from(challengeText, 'base64url') : null;
  if (!challenge || challenge.length !== 32 || challenge.toString('base64url') !== challengeText) {
    return error(res, 400, 'invalid_challenge', 'The challenge must be exactly 32 random bytes, base64url.');
  }
  const state = loadMobileState();
  const key = openPrivateKey(state.identity.sealedPrivateKey, state.mobileInstallationId);
  if (!key) return error(res, 503, 'unavailable', 'The server identity is unavailable.');
  const issuedAt = Date.now();
  const publicKeyRaw = Buffer.from(state.identity.publicKey, 'base64url');
  const signature = signIdentity(key, identitySignedBytes({ mobileInstallationId: state.mobileInstallationId, publicKeyRaw, challenge, issuedAt }));
  return capped(res, {
    v: 1,
    apiMajor: API_MAJOR,
    mobileInstallationId: state.mobileInstallationId,
    legacyInstallationId: state.legacyInstallationId,
    serverSigningPublicKey: state.identity.publicKey,
    serverSigningFingerprint: state.identity.fingerprint,
    challenge: challengeText,
    issuedAt,
    signature: Buffer.from(signature).toString('base64url'),
  }, CAPS.identity);
}

async function handleClaim(req, res, ip, server) {
  if (limiters.claim.hit(ip).limited) return limited(res, limiters.claim.hit(ip));
  const body = await readBody(req, 8 * 1024);
  if (body.v !== 1) return error(res, 400, 'invalid_request', 'Unsupported claim version.');
  const outcome = claimEnrolment(server, {
    pairingKey: body.pairingKey,
    claimEncryptionPublicKey: body.claimEncryptionPublicKey,
    clientNonce: body.clientNonce,
    deviceName: body.deviceName,
    requestedScopes: body.requestedScopes,
    candidateOrigin: typeof body.candidateOrigin === 'string' ? body.candidateOrigin : undefined,
    candidateFingerprint: typeof body.candidateFingerprint === 'string' ? body.candidateFingerprint : undefined,
  });
  if (!outcome.ok) return failure(res, outcome);
  return capped(res, outcome.body, CAPS.claim);
}

async function enrolmentIdFrom(req) {
  const body = await readBody(req, 4 * 1024);
  return { body, enrolmentId: body.v === 1 ? strictString(body.enrolmentId, ENROLMENT_ID_RE) : null };
}

async function handleStatus(req, res, ip) {
  const { enrolmentId } = await enrolmentIdFrom(req);
  if (!enrolmentId) return error(res, 400, 'invalid_request', 'An enrolment id is required.');
  if (limiters.enrolment.hit(`${ip}:${enrolmentId}`).limited) return limited(res, limiters.enrolment.hit(`${ip}:${enrolmentId}`));
  return capped(res, enrolmentStatus(enrolmentId), CAPS.status);
}

async function handleGrant(req, res, ip) {
  const { enrolmentId } = await enrolmentIdFrom(req);
  if (!enrolmentId) return error(res, 400, 'invalid_request', 'An enrolment id is required.');
  if (limiters.enrolment.hit(`${ip}:${enrolmentId}`).limited) return limited(res, limiters.enrolment.hit(`${ip}:${enrolmentId}`));
  const outcome = retrieveGrant(enrolmentId);
  if (!outcome.ok) return failure(res, outcome);
  return capped(res, outcome.body, CAPS.grant);
}

async function handleAcknowledge(req, res, ip, server) {
  const { body, enrolmentId } = await enrolmentIdFrom(req);
  if (!enrolmentId) return error(res, 400, 'invalid_request', 'An enrolment id is required.');
  if (limiters.enrolment.hit(`${ip}:${enrolmentId}`).limited) return limited(res, limiters.enrolment.hit(`${ip}:${enrolmentId}`));
  const outcome = acknowledgeEnrolment(enrolmentId, body.ackSecret, server.tlsLeafFingerprint);
  if (!outcome.ok) return failure(res, outcome);
  return capped(res, outcome.body, CAPS.ack);
}

async function handleRefresh(req, res, ip) {
  if (limiters.refresh.hit(ip).limited) return limited(res, limiters.refresh.hit(ip));
  const body = await readBody(req, 4 * 1024);
  if (body.v !== 1) return error(res, 400, 'invalid_request', 'Unsupported refresh version.');
  const outcome = refreshTokens(body.refreshGrant, body.rotationRequestId);
  if (!outcome.ok) return failure(res, outcome);
  return capped(res, outcome.body, CAPS.refresh);
}

/** Advertise optional route capabilities for client-side feature gating. */
export const MOBILE_CAPABILITIES = ['containers.detail'];

const READ_ROUTES = {
  '/api/mobile/v1/summary': { scope: 'summary.read', load: () => summaryDto() },
  '/api/mobile/v1/containers': { scope: 'containers.read', load: () => containersDto() },
  '/api/mobile/v1/stacks': { scope: 'stacks.read', load: () => stacksDto() },
  '/api/mobile/v1/updates': { scope: 'updates.read', load: () => updatesDto() },
  '/api/mobile/v1/events': { scope: 'events.read', load: (url) => eventsDto(Number(url.searchParams.get('after')), Number(url.searchParams.get('limit'))) },
};

/** Build a device router with an injected owner surface. */
export function createMobileRouter(server, flags, ownerSurface = null) {
  return async function route(req, res) {
    const url = new URL(req.url, 'https://x');
    const path = url.pathname;
    const method = req.method;
    if (ownerSurface && await ownerSurface(req, res)) return undefined;
    const ip = peerIp(req);
    const verdict = limiters.ip.hit(ip);
    if (verdict.limited) return limited(res, verdict);

    if (path === '/api/mobile/v1/identity' && method === 'GET') {
      const v = limiters.identity.hit(ip);
      if (v.limited) return limited(res, v);
      return handleIdentity(res, url);
    }
    if (path.startsWith('/api/mobile/v1/enrolments/') && method === 'POST') {
      if (!flags.enrolment) return error(res, 404, 'not_found', 'Pairing is not enabled on this server.');
      if (path === '/api/mobile/v1/enrolments/claim') return handleClaim(req, res, ip, server);
      if (path === '/api/mobile/v1/enrolments/status') return handleStatus(req, res, ip);
      if (path === '/api/mobile/v1/enrolments/grant') return handleGrant(req, res, ip);
      if (path === '/api/mobile/v1/enrolments/acknowledge') return handleAcknowledge(req, res, ip, server);
      return error(res, 404, 'not_found', 'No such route.');
    }
    if (path === '/api/mobile/v1/token/refresh' && method === 'POST') return handleRefresh(req, res, ip);

    // Detail remains allow-listed telemetry for a container already present in the list.
    const detail = method === 'GET' ? /^\/api\/mobile\/v1\/containers\/([0-9a-f]{12})$/.exec(path) : null;
    if (detail) {
      const v = limiters.auth.hit(ip);
      if (v.limited) return limited(res, v);
      const auth = authenticateAccess(req.headers.authorization, 'containers.read');
      if (!auth.ok) return failure(res, auth);
      return json(res, 200, await containerDetailDto(detail[1]), HEADERS);
    }
    if (method === 'GET' && (path === '/api/mobile/v1/meta' || READ_ROUTES[path])) {
      const v = limiters.auth.hit(ip);
      if (v.limited) return limited(res, v);
      const auth = authenticateAccess(req.headers.authorization, path === '/api/mobile/v1/meta' ? null : READ_ROUTES[path].scope);
      if (!auth.ok) return failure(res, auth);
      if (path === '/api/mobile/v1/meta') {
        // Capability names gate optional routes without protocol-version inference.

        const state = loadMobileState();
        return capped(res, { v: 1, apiMajor: API_MAJOR, mobileInstallationId: state.mobileInstallationId, origin: server.origin, device: auth.device, capabilities: MOBILE_CAPABILITIES }, CAPS.status);
      }
      return json(res, 200, await READ_ROUTES[path].load(url), HEADERS);
    }
    return error(res, 404, 'not_found', 'No such route.');
  };
}

export function resetMobileLimitersForTest() {
  for (const limiter of Object.values(limiters)) limiter.reset();
}
