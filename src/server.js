// Route access is deny-by-default and keyed by method and path.

import { createServer } from 'node:http';
import QRCode from 'qrcode';

import { config } from './config.js';
import { createAuthPlane } from './auth-plane.js';
import { hasOwner } from './store.js';
import { bootstrapSetupToken, setupTokenWasGenerated } from './setup-token.js';
import {
  changePassword,
  setDisplayName,
  ownerInfo,
  enableMfa,
  disableMfa,
  mfaEnabled,
  checkCsrf,
  verifyOwnerStepUp,
  MAX_PASSWORD_CHARS,
} from './auth.js';
import { newSecret, base32, otpauthUrl } from './totp.js';
import { gatherStack, readMountedConfigFile, applyMintedKeys, resolveContainerForInstance, extractContainerApiKey } from './detect.js';
import { getPrefs, setPrefs, listApiTokens, addApiToken, removeApiToken, findApiToken, getInstallationId, getManagedStacks, saveManagedStack, getTemplateSources, addTemplateSource, removeTemplateSource, getMintedKeys, setMintedKey, forgetMintedKey, addAudit, getAuditLog } from './store.js';
import { fetchTemplateSource, writeTemplateCache, dropTemplateCache, templateSourcesView } from './templates.js';
import { listJobs, setJobEnabled, setJobSchedule, runJob, addJob, updateJob, deleteJob, clearHistory, suspendJobsAboveMode, requiredDockerModeForAction, requiredDockerModeForJob, requiredDockerModeForJobEdit } from './cron.js';
import { dockerAccessState, dockerModeRank, dockerModeAllows, setDockerAccessMode, canManageDocker, canUseDockerShell } from './docker-access.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { gatherLive } from './live.js';
import { buildBundle, defaultPairDraft, suggestedBaseUrl, PairingValidationError } from './build.js';
import { mintKey, MINT_ENABLED_KINDS, isMintEnabled, mintTransportOk } from './mint.js';
import { isSafeInspectableEnvValue, isSafeInspectableLabelValue } from './secretscan.js';
import { isProtectedContainer } from './protect.js';
import { pairingCredentialState } from './kinds.js';
import { OneTimeTransfers, qmc1Payload } from './qmbackup.js';
import { listContainers, containerLogs, containerActionResult, removeContainer, execInContainer, dockerAvailable, dockerCounts, dockerInfo, dockerStats, listImages, pullImage, removeImage, pruneImages, prune, pruneContainersGuarded, protectedContainerReason, listVolumes, listNetworks, createNetwork, removeNetwork, recentEvents, allContainerStats, listStacks, updateContainer, inspectContainer, systemDf, removeVolume } from './docker.js';
import { createHub, HUB_TOPICS } from './hub.js';
import { renderDevicesReadOnly } from './mobile/owner-routes.js';
import { prepareMobilePlane, secureOwnerConfiguration, startMobileListener } from './mobile/listener.js';
import { checkUpdates, clearUpdateCache, UPDATE_CACHE_MS } from './registry.js';
import { updatesState, decorateUpdates, checkRef, dismissRefs } from './updates.js';
import { deployStack, composeSkeleton } from './compose.js';
import { lintCompose } from './lint.js';
import { basename, dirname } from 'node:path';
import { getIcon, getLogo, getFont } from './icons.js';
import {
  parseCookies,
  cookie,
  peerIp,
  readBody,
  readFormBody,
  html,
  json,
  redirect,
  send,
  escapeHtml,
} from './http.js';
import { styles } from './ui/styles.js';
import { loginPage, setupPage, mfaPage, mfaSetupPage, mfaRecoveryPage, dashboardPage, pairPage, containersPage, consolePage, settingsPage, imagesPage, volumesPage, networksPage, activityPage, stacksPage, cataloguePage, profilePage, cronPage } from './ui/views.js';

const SESSION_COOKIE = 'qm_sess';
const PAIR_TTL_MS = 3 * 60 * 1000;
const NO_STORE = {
  'cache-control': 'no-store, max-age=0',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
};
const pairTransfers = new OneTimeTransfers();
// Short-lived drafts support transfer reissue after credentials change.
const pairDrafts = new Map(); // session token -> { draft, origin, bundleId, at }
const PAIR_DRAFT_TTL_MS = 15 * 60 * 1000;
const PAIR_DRAFT_MAX = 16;
const MANUAL_KEY_MAX_CHARS = 16_384;
const MANUAL_KEY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// Rate-limit credential-based key creation per session.
const mintHits = new Map(); // session digest -> recent attempt timestamps
const MINT_WINDOW_MS = 60_000;
const MINT_MAX = 5;
const LOGIN_FORM_COOKIE = 'qm_login_form';
const BEARER_READ_PATHS = new Set([
  '/api/services',
  '/api/updates',
  '/api/docker/stats',
  '/api/containers/stats',
  '/api/docker/df',
]);

// Poll Docker only while a live stream has subscribers.
const hub = createHub({
  fetchers: {
    counts: () => dockerCounts(),
    // Treat proxy refusals as unavailable data.
    events: async () => {
      const events = await recentEvents(24, 12);
      return Array.isArray(events) ? events : null;
    },
    updates: async () => {
      const [containers, images] = await Promise.all([listContainers(), listImages()]);
      return updatesState(containers || [], Array.isArray(images) ? images : []);
    },
  },
});

// The HTTP and mobile HTTPS panels use separate session cookies.
const browserPlane = createAuthPlane({
  sessionCookie: SESSION_COOKIE,
  formCookie: LOGIN_FORM_COOKIE,
  secure: () => config.cookieSecure,
  tls: false,
  home: '/',
  sessionTtlMs: config.sessionTtlMs,
});

// Request handlers.

function authContext(authPlane) {
  return {
    authPlane,
    plane: authPlane.tls ? 'tls' : 'http',
    sessionOptions: { tls: authPlane.tls === true },
  };
}

const browserAuth = authContext(browserPlane);

// Keep enrolment secrets server-side until confirmation.
const enrolStash = new Map(); // session token -> { secretHex, at }

async function handleMfaSetup(req, res, token, csrf) {
  if (mfaEnabled()) return redirect(res, '/settings');
  const secret = newSecret();
  enrolStash.set(token, { secretHex: secret.toString('hex'), at: Date.now() });
  const qr = await QRCode.toDataURL(otpauthUrl(secret, 'Companion', 'Quartermaster'), { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
  return html(res, 200, mfaSetupPage(qr, base32(secret), csrf));
}

async function handleMfaEnable(req, res, token, csrf, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  const stash = enrolStash.get(token);
  if (!stash || Date.now() - stash.at > 10 * 60 * 1000) return redirect(res, '/settings/mfa');
  const enabled = enableMfa(stash.secretHex, String(body.code || ''), auth.sessionOptions);
  if (!enabled) {
    const qr = await QRCode.toDataURL(otpauthUrl(Buffer.from(stash.secretHex, 'hex'), 'Companion', 'Quartermaster'), { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
    return html(res, 200, mfaSetupPage(qr, base32(Buffer.from(stash.secretHex, 'hex')), csrf, 'That code did not match. Codes rotate every 30 seconds.'));
  }
  enrolStash.delete(token);
  auth.authPlane.setSessionCookie(res, enabled.session.token);
  return html(res, 200, mfaRecoveryPage(enabled.recoveryCodes, enabled.session.csrf));
}

function renderProfile(res, csrf, flash, freshToken) {
  return html(res, 200, profilePage(ownerInfo(), mfaEnabled(), listApiTokens(), csrf, flash, freshToken));
}

async function handleProfileName(req, res, token, csrf, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  setDisplayName(String(body.name || ''));
  return renderProfile(res, csrf, 'Name saved.');
}

async function handleProfilePassword(req, res, token, csrf, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  const next = String(body.next || '');
  if (next.length < 10) return renderProfile(res, csrf, 'New password needs at least 10 characters.');
  if (next.length > MAX_PASSWORD_CHARS) return renderProfile(res, csrf, `New password must be at most ${MAX_PASSWORD_CHARS} characters.`);
  const changed = changePassword(String(body.current || ''), next, auth.sessionOptions);
  if (!changed) return renderProfile(res, csrf, 'Current password was wrong.');
  enrolStash.delete(token);
  auth.authPlane.setSessionCookie(res, changed.session.token);
  return renderProfile(res, changed.session.csrf, 'Password changed. Other signed-in browsers were signed out.');
}

// API tokens are shown once and stored as hashes.
async function handleTokenNew(req, res, token, csrf, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  const name = String(body.name || 'token').slice(0, 30);
  const plain = 'qmc_' + randomBytes(24).toString('hex');
  addApiToken({
    id: randomBytes(8).toString('hex'),
    name,
    prefix: plain.slice(0, 10),
    hashHex: createHash('sha256').update(plain).digest('hex'),
    createdAt: Date.now(),
    lastUsedAt: null,
  });
  return renderProfile(res, csrf, null, plain);
}

async function handleTokenRevoke(req, res, token, csrf, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  removeApiToken(String(body.id || ''));
  return renderProfile(res, csrf, 'Token revoked.');
}

async function handlePrefs(req, res, token, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  setPrefs(body);
  return redirect(res, '/settings?tab=general');
}

async function handleDockerAccessMode(req, res) {
  const body = await readBody(req);
  const mode = String(body.mode || '');
  const before = dockerAccessState();
  if (dockerModeRank(mode) < 0) return json(res, 400, { error: 'Choose read, manage or shell.' });
  if (dockerModeRank(mode) > dockerModeRank(before.ceiling)) {
    return json(res, 409, { error: `That mode is above this installation's ${before.ceilingLabel} maximum.` });
  }
  if (dockerModeRank(mode) > dockerModeRank(before.mode)) {
    const proved = await verifyOwnerStepUp(String(body.password || ''), String(body.code || ''), peerIp(req));
    if (!proved) return json(res, 403, { error: 'The owner password or authenticator code was not accepted.' });
  }
  if (mode === before.mode) {
    return json(res, 200, { ok: true, mode: before.mode, label: before.label, suspended: 0 });
  }

  // Persist job suspension before raising the access ceiling.
  if (dockerModeRank(mode) > dockerModeRank(before.mode)) {
    try {
      suspendJobsAboveMode(before.mode);
    } catch {
      return json(res, 500, { error: 'Scheduled jobs could not be checked, so Docker access was not changed.' });
    }
  }

  const changed = setDockerAccessMode(mode);
  if (!changed.ok) return json(res, changed.status || 409, { error: changed.error });

  let suspended = 0;
  if (dockerModeRank(mode) < dockerModeRank(before.mode)) {
    try {
      suspended = suspendJobsAboveMode(mode);
    } catch {
      // Restore the prior job selection when the mode update fails.
      const rolledBack = setDockerAccessMode(before.mode);
      if (rolledBack.ok) {
        return json(res, 500, { error: 'Scheduled jobs could not be disabled, so Docker access was not changed.' });
      }
      return json(res, 500, {
        error: 'Docker access was lowered, but scheduled jobs could not be disabled. Refresh before continuing.',
        mode: changed.state.mode,
      });
    }
  }

  try {
    addAudit(`changed Docker access to ${changed.state.label.toLowerCase()}`);
  } catch {
    return json(res, 200, {
      ok: true,
      mode: changed.state.mode,
      label: changed.state.label,
      suspended,
      warning: 'Docker access changed, but the audit entry could not be saved.',
    });
  }
  return json(res, 200, {
    ok: true,
    mode: changed.state.mode,
    label: changed.state.label,
    suspended,
  });
}

// Convert flat form fields to the cron job input shape.
function cronSchedule(b) {
  return { type: String(b.stype || b.type || ''), day: b.day, hour: b.hour, minute: b.minute, hours: b.hours };
}

function cronAction(b) {
  return { type: String(b.atype || ''), what: String(b.what || ''), op: String(b.op || ''), ref: String(b.ref || ''), cmd: String(b.cmd || '') };
}

async function handleCronPost(req, res, token, kind, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  const id = String(body.id || '');
  const access = dockerAccessState();
  let requiredMode = null;
  if (kind === 'toggle' && String(body.enabled) === 'true') requiredMode = requiredDockerModeForJob(id);
  if (kind === 'run') requiredMode = requiredDockerModeForJob(id);
  if (kind === 'new') requiredMode = requiredDockerModeForAction(cronAction(body));
  if (kind === 'edit') requiredMode = requiredDockerModeForJobEdit(id, cronAction(body));
  if (requiredMode && !dockerModeAllows(access.mode, requiredMode)) {
    return json(res, 403, { error: requiredMode === 'shell' ? 'Docker shell access is off' : 'Docker access is read only' });
  }
  let ok = true;
  if (kind === 'toggle') ok = setJobEnabled(id, String(body.enabled) === 'true');
  if (kind === 'run') await runJob(id, 'manual');
  if (kind === 'schedule') ok = setJobSchedule(id, cronSchedule(body));
  if (kind === 'new') ok = addJob(String(body.name || ''), cronAction(body), cronSchedule(body));
  if (kind === 'edit') ok = updateJob(id, String(body.name || ''), cronAction(body), cronSchedule(body));
  if (kind === 'delete') ok = deleteJob(id);
  if (kind === 'clear') ok = clearHistory(id);
  return redirect(res, ok ? '/cron' : '/cron?err=1');
}

// Template-source writes require a session and CSRF token but no Docker control mode.
async function handleTemplatePost(req, res, token, kind, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  if (kind === 'add') {
    const added = addTemplateSource(String(body.name || ''), String(body.url || ''));
    if (!added.ok) return json(res, 400, { ok: false, error: added.error });
    return json(res, 200, { ok: true, source: added.source });
  }
  if (kind === 'remove') {
    const removed = removeTemplateSource(String(body.id || ''));
    if (removed) dropTemplateCache(removed.url);
    return json(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: 'no such source' });
  }
  const row = getTemplateSources().find((source) => source.id === String(body.id || ''));
  if (!row) return json(res, 404, { ok: false, error: 'no such source' });
  const fetched = await fetchTemplateSource(row.url);
  // Cache failures to prevent stale source results.
  writeTemplateCache(row.url, {
    url: row.url,
    fetchedAt: Date.now(),
    error: fetched.ok ? null : fetched.error,
    entries: fetched.entries,
  });
  return json(res, fetched.ok ? 200 : 502, { ok: fetched.ok, error: fetched.error, entries: fetched.entries.length });
}

async function handleMfaDisable(req, res, token, csrf, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  const disabled = disableMfa(String(body.code || ''), auth.sessionOptions);
  if (!disabled) return renderProfile(res, csrf, 'That two-factor code did not match.');
  auth.authPlane.setSessionCookie(res, disabled.session.token);
  return renderProfile(res, disabled.session.csrf, 'Two-factor turned off. Other signed-in browsers were signed out.');
}

// Overlay stored credentials on the latest discovery result.
async function currentServices() {
  const detected = await gatherStack(config.stackDir, config.qmHost);
  const { services, stale } = applyMintedKeys(detected, getMintedKeys());
  for (const id of stale) forgetMintedKey(id);
  return services;
}

function mintThrottled(digest) {
  const now = Date.now();
  const recent = (mintHits.get(digest) || []).filter((at) => now - at < MINT_WINDOW_MS);
  if (recent.length >= MINT_MAX) { mintHits.set(digest, recent); return true; }
  recent.push(now);
  mintHits.set(digest, recent);
  while (mintHits.size > 1000) mintHits.delete(mintHits.keys().next().value);
  return false;
}

function retainPairDraft(token, record) {
  const now = Date.now();
  for (const [key, value] of pairDrafts) {
    if (now - value.at > PAIR_DRAFT_TTL_MS) pairDrafts.delete(key);
  }
  while (pairDrafts.size >= PAIR_DRAFT_MAX) pairDrafts.delete(pairDrafts.keys().next().value);
  pairDrafts.set(token, { ...record, at: now });
}

function takePairDraft(token) {
  const record = pairDrafts.get(token);
  pairDrafts.delete(token);
  if (!record || Date.now() - record.at > PAIR_DRAFT_TTL_MS) return null;
  return record;
}

async function handleDashboard(req, res, csrf) {
  const detected = await currentServices();
  const [live, counts, info, events, containers, images] = await Promise.all([
    gatherLive(detected), dockerCounts(), dockerInfo(), recentEvents(24, 12), listContainers(), listImages(),
  ]);
  // Use cached registry results for the shared update indicator.
  const s = updatesState(containers || [], Array.isArray(images) ? images : []);
  const updates = s.checkedAt ? { count: s.updateCount, at: s.checkedAt } : null;
  return html(res, 200, dashboardPage(detected, live, { counts, info, events, updates, containers }, csrf));
}

function pairHtml(res, status, page) {
  return html(res, status, page, NO_STORE);
}

function pairInputError(reason) {
  if (reason === 'too-large') return 'That setup form was too large. Shorten the addresses and try again.';
  if (reason === 'content-type') return 'The setup form was sent in an unexpected format. Reload this page and try again.';
  return 'The setup form could not be read. Reload this page and try again.';
}

function draftFromPairForm(detected, body) {
  const rows = [];
  const posted = new Set();
  for (let i = 0; i < 100; i += 1) {
    if (!Object.hasOwn(body, `service_${i}`)) continue;
    const instanceId = String(body[`service_${i}`] || '');
    if (posted.has(instanceId)) {
      rows.push({ instanceId, included: true, baseUrl: '', remoteBaseUrl: '' });
      continue;
    }
    posted.add(instanceId);
    rows.push({
      instanceId,
      included: body[`include_${i}`] === 'on',
      // buildBundle revalidates this reachability override.
      forced: body[`force_${i}`] === 'on',
      baseUrl: String(body[`base_${i}`] || ''),
      remoteBaseUrl: String(body[`remote_${i}`] || ''),
    });
  }

  // Preserve newly discovered rows without selecting them in a stale form submission.
  for (const d of detected) {
    if (d.instanceId && !posted.has(d.instanceId)) {
      rows.push({ instanceId: d.instanceId, included: false, baseUrl: '', remoteBaseUrl: '' });
    }
  }
  return {
    services: rows,
    edgeAccess: {
      domain: String(body.edge_domain || ''),
      clientId: String(body.edge_client_id || ''),
      clientSecret: String(body.edge_client_secret || ''),
    },
  };
}

function displayDraft(draft) {
  return {
    ...draft,
    edgeAccess: { ...(draft.edgeAccess || {}), clientSecret: '' },
  };
}

function companionOrigin(req) {
  const host = String(req.headers.host || '');
  if (!host || host.length > 300 || /[\s/@?#\\,]/u.test(host)) throw new Error('The browser address is not usable for pairing.');
  let authority;
  try {
    authority = new URL(`http://${host}`);
  } catch {
    throw new Error('The browser address is not usable for pairing.');
  }
  if (authority.username || authority.password || authority.pathname !== '/') throw new Error('The browser address is not usable for pairing.');
  let protocol = req.socket.encrypted ? 'https:' : 'http:';
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').trim().toLowerCase();
    if (forwarded !== 'http' && forwarded !== 'https') throw new Error('The proxy did not provide a usable request scheme.');
    protocol = `${forwarded}:`;
  }
  return `${protocol}//${authority.host}`;
}

function renderPairForm(res, status, detected, draft, csrf, issues = []) {
  return pairHtml(res, status, pairPage({
    stage: 'configure', detected, draft, issues, csrf,
    mintEnabledKinds: [...MINT_ENABLED_KINDS], canShell: canUseDockerShell(),
  }));
}

async function handlePairGet(res, csrf) {
  const detected = await currentServices();
  if (detected.length === 0) {
    return pairHtml(res, 200, pairPage({
      stage: 'empty',
      csrf,
      issues: ['No services found yet. Check the stack mount and Docker connection, then try again.'],
    }));
  }
  return renderPairForm(res, 200, detected, defaultPairDraft(detected, config), csrf);
}

async function handlePairPost(req, res, token, csrf, auth) {
  const read = await readFormBody(req, 96 * 1024);
  const detected = await currentServices();
  if (!read.ok) return renderPairForm(res, read.reason === 'too-large' ? 413 : 400, detected, defaultPairDraft(detected, config), csrf, [pairInputError(read.reason)]);
  const draft = draftFromPairForm(detected, read.value);
  if (!checkCsrf(token, String(read.value.csrf || ''), auth.plane)) {
    return renderPairForm(res, 403, detected, displayDraft(draft), csrf, ['This setup page expired. Reload it and try again.']);
  }

  const now = Date.now();
  const metadata = {
    bundleId: randomBytes(18).toString('base64url'),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PAIR_TTL_MS).toISOString(),
  };
  try {
    const origin = companionOrigin(req);
    const hasEdgeCredentials = Object.values(draft.edgeAccess || {}).some((value) => String(value || '').trim());
    if (hasEdgeCredentials && !origin.startsWith('https://')) {
      throw new Error('Cloudflare Access credentials can only be transferred from Companion over HTTPS. Use a TLS reverse proxy, or leave those fields empty and add the token on the phone.');
    }
    const bundle = buildBundle(detected, config, draft, getInstallationId(), metadata);
    const transfer = pairTransfers.create({
      envelopeJson: bundle.envelopeJson,
      sessionToken: token,
      bundleId: bundle.companion.bundleId,
      expiresAt: Date.parse(bundle.companion.expiresAt),
    });
    const scanValue = qmc1Payload(origin, transfer.redeemToken);
    let qrDataUrl;
    try {
      qrDataUrl = await QRCode.toDataURL(scanValue, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
    } catch (error) {
      pairTransfers.invalidateBundle(bundle.companion.bundleId);
      throw error;
    }
    // Retain the draft for a later credential-aware reissue.
    retainPairDraft(token, { draft, origin, bundleId: bundle.companion.bundleId });
    addAudit(`created a one-time transfer for ${bundle.summary.length} service${bundle.summary.length === 1 ? '' : 's'}`);
    return pairHtml(res, 200, pairPage({
      stage: 'ready',
      csrf,
      bundle,
      qrDataUrl,
      filePath: `/pair/file/${transfer.pairId}`,
    }));
  } catch (error) {
    const issues = error instanceof PairingValidationError
      ? error.issues
      : [error?.message === 'The browser address is not usable for pairing.' || error?.message === 'The proxy did not provide a usable request scheme.' || error?.message?.startsWith('Cloudflare Access credentials can only')
          ? error.message
          : 'The transfer could not be created. Check the addresses and try again.'];
    return renderPairForm(res, 400, detected, displayDraft(draft), csrf, issues);
  }
}

function transferResponse(res, envelopeJson, download = false) {
  if (!envelopeJson) return send(res, 404, 'Pairing transfer unavailable.', { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE });
  return send(res, 200, envelopeJson, {
    // QR redemption requires the qmbackup media type.
    'content-type': 'application/vnd.quartermaster.backup+json',
    ...(download ? { 'content-disposition': 'attachment; filename="quartermaster.qmcompanion"' } : {}),
    ...NO_STORE,
  });
}

function handlePairRedeem(res, redeemToken) {
  const envelopeJson = pairTransfers.consumeRedeem(redeemToken);
  if (envelopeJson) addAudit('a device redeemed the setup transfer');
  return transferResponse(res, envelopeJson);
}

function handlePairFile(res, token, pairId) {
  return transferResponse(res, pairTransfers.consumeFile(pairId, token), true);
}

async function handleApiServices(req, res) {
  const detected = await currentServices();
  // Return credential status without credential values.
  return json(res, 200, {
    services: detected.map((d) => ({
      instanceId: d.instanceId,
      kind: d.kind,
      name: d.name,
      port: d.port,
      up: d.up,
      url: d.url || null,
      // Include Docker state and derived availability.
      dockerState: d.dockerState || null,
      availability: d.availability || 'unverified',
      hasKey: !!d.apiKey,
      credentialState: pairingCredentialState(d.kind, d.apiKey, d.credentialConflict),
    })),
  });
}

// Setup credentials.

// Read credentials through the same bounded parser used by discovery.
async function handlePairKeysRead(req, res) {
  if (!canUseDockerShell()) return json(res, 403, { error: 'Docker shell access is off' });
  const body = await readBody(req);
  const instanceId = String(body.instanceId || '');
  const target = await resolveContainerForInstance(instanceId);
  if (!target || !target.rule) return json(res, 404, { ok: false, error: 'that service has no readable config file in its container' });
  // Recheck container protection immediately before Docker exec.
  const shielded = await protectedContainerReason(target.id);
  if (shielded) return json(res, 403, { ok: false, error: shielded });
  const result = await execInContainer(target.id, `cat ${target.rule.sourcePath}`);
  if (!result.ok) {
    addAudit(`could not read a key from ${target.kind}`);
    return json(res, 502, { ok: false, error: 'the container did not return its config file' });
  }
  const apiKey = extractContainerApiKey(target.kind, target.rule.sourcePath, Buffer.from(result.output || '', 'utf8'));
  if (!apiKey) {
    addAudit(`could not read a key from ${target.kind}`);
    return json(res, 422, { ok: false, error: 'no API key was found in that config file' });
  }
  setMintedKey(instanceId, { kind: target.kind, apiKey, createdBy: 'container' });
  addAudit(`read the ${target.kind} api key from its container`);
  return json(res, 200, { ok: true });
}

// Allow a path override only when scheme, host, and port match the detected service origin.
function mintBaseUrl(clientBase, found) {
  const suggested = suggestedBaseUrl(found, config);
  const raw = String(clientBase || '').trim();
  if (raw && raw.length <= 2048 && suggested) {
    try {
      const u = new URL(raw);
      const s = new URL(suggested);
      if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash
        && u.protocol === s.protocol && u.host === s.host) {
        return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '');
      }
    } catch { /* fall through to the detected base */ }
  }
  return suggested;
}

// Create an API key using credentials scoped to this request.
async function handlePairKeysMint(req, res, token) {
  const digest = createHash('sha256').update(token).digest('hex');
  if (mintThrottled(digest)) {
    return json(res, 429, { error: 'too many key attempts. Wait a minute, then try again.' }, { 'retry-after': '60' });
  }
  // Refuse before reading credentials when all key-creation flows are disabled.
  if (MINT_ENABLED_KINDS.size === 0) {
    const paused = ndjson(res);
    paused.send({ t: 'step', id: 'signin', state: 'fail', label: 'Automatic key creation is unavailable', note: 'Open the service, create a key there, then paste it into Companion.' });
    return paused.end({ ok: false, paused: true, note: 'Create the key in the service, then paste it into Companion.' });
  }
  const body = await readBody(req);
  const instanceId = String(body.instanceId || '');
  const creds = body.credentials && typeof body.credentials === 'object' ? body.credentials : {};
  const username = String(creds.username || '');
  const password = String(creds.password || '');
  const found = (await currentServices()).find((d) => d.instanceId === instanceId);
  const s = ndjson(res);
  if (!found) {
    s.send({ t: 'step', id: 'signin', state: 'fail', label: 'Signing in', note: 'that service is no longer detected' });
    return s.end({ ok: false, note: 'that service is no longer detected' });
  }
  // Disabled service kinds never reach the network.
  if (!isMintEnabled(found.kind)) {
    s.send({ t: 'step', id: 'signin', state: 'fail', label: 'Automatic key creation is unavailable', note: 'Create the key in the service, then paste it here.' });
    return s.end({ ok: false, paused: true, note: `Companion does not create ${found.kind} keys. Paste one you made in the service instead.` });
  }
  const base = mintBaseUrl(body.baseUrl, found);
  // Plain HTTP credential requests are limited to private addresses.
  const transport = await mintTransportOk(base);
  if (!transport.ok) {
    s.send({ t: 'step', id: 'signin', state: 'fail', label: 'Signing in', note: transport.reason });
    return s.end({ ok: false, note: transport.reason });
  }
  s.send({ t: 'step', id: 'signin', state: 'active', label: 'Signing in' });
  const result = await mintKey(found.kind, base, { username, password });
  if (!result.ok) {
    s.send({ t: 'step', id: 'signin', state: 'fail', note: result.reason });
    return s.end({ ok: false, note: result.reason });
  }
  s.send({ t: 'step', id: 'signin', state: 'ok', note: 'signed in' });
  s.send({ t: 'step', id: 'create', state: 'ok', label: 'Creating the key' });
  // Store only the created key and its source.
  setMintedKey(instanceId, { kind: found.kind, apiKey: result.apiKey, createdBy: 'mint' });
  addAudit(`created a ${found.kind} api key named Quartermaster`);
  s.send({ t: 'step', id: 'seal', state: 'ok', label: 'Sealing it' });
  return s.end({ ok: true, note: 'Key created just now' });
}

// Save a manually created key for a freshly detected service that currently needs one.
async function handlePairKeysManual(req, res) {
  const parsed = await readBody(req);
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId : '';
  const rawKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  if (!rawKey || rawKey.length > MANUAL_KEY_MAX_CHARS || MANUAL_KEY_CONTROL.test(rawKey)) {
    return json(res, 422, { error: 'Enter a non-empty key of at most 16384 characters without control characters.' });
  }
  const apiKey = rawKey.trim();
  if (!apiKey) return json(res, 422, { error: 'Enter a non-empty key of at most 16384 characters without control characters.' });

  const found = (await currentServices()).find((service) => service.instanceId === instanceId);
  if (!found) return json(res, 404, { error: 'That service is no longer detected.' });
  if (pairingCredentialState(found.kind, found.apiKey, found.credentialConflict) !== 'missing-key') {
    return json(res, 409, { error: 'That service no longer needs a manual key.' });
  }
  if (!setMintedKey(found.instanceId, { kind: found.kind, apiKey, createdBy: 'manual' })) {
    return json(res, 422, { error: 'That key could not be saved.' });
  }
  addAudit(`saved the ${found.kind} api key manually`);
  return json(res, 200, { ok: true });
}

async function handlePairKeysForget(req, res) {
  const body = await readBody(req);
  const instanceId = String(body.instanceId || '');
  forgetMintedKey(instanceId);
  addAudit('removed a stored key from the setup page');
  return json(res, 200, { ok: true });
}

// Reissue from the retained draft and invalidate the prior transfer.
async function handlePairReissue(req, res, token, csrf, auth) {
  const body = await readBody(req);
  if (!checkCsrf(token, String(body.csrf || ''), auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  const retained = takePairDraft(token);
  if (!retained) return renderPairForm(res, 409, await currentServices(), defaultPairDraft(await currentServices(), config), csrf, ['There is nothing to re-issue. Review the routes and create a fresh transfer.']);
  const now = Date.now();
  const metadata = {
    bundleId: randomBytes(18).toString('base64url'),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PAIR_TTL_MS).toISOString(),
  };
  try {
    const detected = await currentServices();
    const bundle = buildBundle(detected, config, retained.draft, getInstallationId(), metadata);
    const transfer = pairTransfers.create({
      envelopeJson: bundle.envelopeJson,
      sessionToken: token,
      bundleId: bundle.companion.bundleId,
      expiresAt: Date.parse(bundle.companion.expiresAt),
    });
    let qrDataUrl;
    try {
      qrDataUrl = await QRCode.toDataURL(qmc1Payload(retained.origin, transfer.redeemToken), { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
    } catch (error) {
      pairTransfers.invalidateBundle(bundle.companion.bundleId);
      throw error;
    }
    pairTransfers.invalidateBundle(retained.bundleId);
    retainPairDraft(token, { draft: retained.draft, origin: retained.origin, bundleId: bundle.companion.bundleId });
    addAudit('re-issued the setup transfer with a newly arrived key');
    return pairHtml(res, 200, pairPage({ stage: 'ready', csrf, bundle, qrDataUrl, filePath: `/pair/file/${transfer.pairId}` }));
  } catch (error) {
    const issues = error instanceof PairingValidationError ? error.issues : ['The transfer could not be re-issued. Open Set up and create a fresh one.'];
    return renderPairForm(res, 400, await currentServices(), defaultPairDraft(await currentServices(), config), csrf, issues);
  }
}

async function handleContainers(req, res, csrf) {
  const access = dockerAccessState();
  return html(res, 200, containersPage(await listContainers(), access.canManage, csrf, access.canShell));
}

async function handleConsole(req, res, csrf, sel) {
  const containers = await listContainers();
  const access = dockerAccessState();
  return html(res, 200, consolePage(containers, sel, access.canManage, csrf, access.canShell));
}

// Keep legacy log and terminal URLs as redirects.
function redirectConsole(res, url) {
  const id = url.searchParams.get('id');
  send(res, 302, '', { location: id ? `/console?id=${encodeURIComponent(id)}` : '/console' });
}

// Remove terminal control sequences before rendering.
function cleanLog(t) {
  return (t || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// Validate every stack member before starting a stack-wide operation.
async function stackProtectionReason(stack, verb) {
  for (const svc of stack.services) {
    const shielded = await protectedContainerReason(svc.id);
    if (shielded) return `${verb} refused for ${stack.name}: ${shielded}`;
  }
  return null;
}

async function handleContainerAction(req, res, id, action) {
  if (!canManageDocker()) return json(res, 403, { error: 'Docker access is read only' });
  const shielded = await protectedContainerReason(id);
  if (shielded) return json(res, 403, { ok: false, error: shielded });
  const result = await containerActionResult(id, action);
  return json(res, result.ok ? 200 : 400, result);
}

// Container removal has its own route and preserves the daemon response.
async function handleContainerRemove(req, res, id) {
  if (!canManageDocker()) return json(res, 403, { error: 'Docker access is read only' });
  const shielded = await protectedContainerReason(id);
  if (shielded) return json(res, 403, { ok: false, error: shielded });
  const r = await removeContainer(String(id || ''));
  return json(res, r.ok ? 200 : /still running/i.test(r.note || '') ? 409 : 400, r);
}

// Expose only allow-listed operational values from Docker inspect; hold all other values server-side.
async function handleContainerInspect(req, res, id) {
  const raw = await inspectContainer(String(id || ''));
  if (!raw) {
    // Distinguish an unavailable daemon from a missing container.
    return (await listContainers())
      ? json(res, 404, { error: 'no such container' })
      : json(res, 503, { error: 'Docker is unavailable' });
  }
  const cfg = raw.Config || {};
  const host = raw.HostConfig || {};
  const env = (Array.isArray(cfg.Env) ? cfg.Env : []).slice(0, 200).map((row) => {
    const s = String(row);
    const eq = s.indexOf('=');
    const name = eq === -1 ? s : s.slice(0, eq);
    const value = eq === -1 ? '' : s.slice(eq + 1);
    // Only allow-listed configuration values cross the wire.
    if (!isSafeInspectableEnvValue(name, value)) return { name, secret: true, hasValue: !!value };
    return { name, value };
  });
  const mounts = (Array.isArray(raw.Mounts) ? raw.Mounts : []).slice(0, 100).map((m) => ({
    source: String((m.Type === 'volume' ? m.Name || m.Source : m.Source) || ''),
    target: String(m.Destination || ''),
    ro: m.RW === false,
  }));
  // Sort qm.* labels first and redact credential-shaped values.
  const labels = Object.entries(cfg.Labels && typeof cfg.Labels === 'object' ? cfg.Labels : {})
    .slice(0, 200)
    .map(([k, v]) => {
      const val = String(v);
      if (!isSafeInspectableLabelValue(k, val)) return { k: String(k), secret: true, hasValue: !!val };
      return { k: String(k), v: val };
    })
    .sort((a, b) => {
      const qa = a.k.startsWith('qm.') ? 0 : 1;
      const qb = b.k.startsWith('qm.') ? 0 : 1;
      return qa - qb || a.k.localeCompare(b.k);
    });
  const policy = host.RestartPolicy || {};
  const limits = {
    cpus: typeof host.NanoCpus === 'number' && host.NanoCpus > 0 ? host.NanoCpus / 1e9 : null,
    memBytes: typeof host.Memory === 'number' && host.Memory > 0 ? host.Memory : null,
    restart: String(policy.Name || 'no'),
    maxRetries: typeof policy.MaximumRetryCount === 'number' && policy.MaximumRetryCount > 0 ? policy.MaximumRetryCount : null,
    networkMode: String(host.NetworkMode || 'default'),
  };
  return json(res, 200, { env, mounts, labels, limits });
}

// Normalize implicit `latest` tags before joining containers to images.
function refKey(ref) {
  const colon = ref.lastIndexOf(':');
  return colon > ref.lastIndexOf('/') ? ref : `${ref}:latest`;
}

// Index containers by image ID and image reference.
async function handleImages(req, res, csrf) {
  const [images, containers] = await Promise.all([listImages(), listContainers()]);
  const inUse = new Set();
  const byRef = Object.create(null);
  for (const c of containers || []) {
    if (c.imageId) inUse.add(c.imageId);
    if (!c.image) continue;
    const k = refKey(c.image);
    (byRef[k] || (byRef[k] = [])).push(c.name);
  }
  return html(res, 200, imagesPage(images, inUse, canManageDocker(), csrf, byRef));
}

// Stream progress for long-running writes.

// Stream newline-delimited JSON without proxy buffering.
function ndjson(res) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no', // nginx would otherwise hold every line back until the end
  });
  return {
    send(o) { if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`); },
    end(o) { if (!res.writableEnded) { res.write(`${JSON.stringify({ t: 'done', ...o })}\n`); res.end(); } },
  };
}

function mb(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

// Aggregate Docker pull events by layer and byte progress.
function pullFeed(send) {
  const layers = new Map();
  let phase = '';
  let last = 0;
  let shown = false;
  const line = (j) => {
    if (!j || typeof j !== 'object') return;
    if (typeof j.status === 'string' && j.status.startsWith('Digest:')) {
      send({ t: 'step', id: 'digest', state: 'ok', label: 'Manifest resolved', note: j.status.slice(7).trim().slice(0, 19), mono: true });
      return;
    }
    const d = j.progressDetail;
    if (j.id && d && typeof d.total === 'number' && d.total > 0) {
      layers.set(j.id, { cur: d.current || 0, tot: d.total });
      if (/^(Downloading|Extracting)$/.test(j.status || '')) phase = j.status;
    } else if (j.id && /complete|exists/i.test(j.status || '')) {
      const e = layers.get(j.id);
      if (e) e.cur = e.tot;
    }
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    let cur = 0;
    let tot = 0;
    for (const l of layers.values()) { cur += l.cur; tot += l.tot; }
    if (!tot) return;
    shown = true;
    send({
      t: 'step',
      id: 'layers',
      state: 'active',
      label: `${phase || 'Downloading'} ${layers.size} layer${layers.size === 1 ? '' : 's'}`,
      note: `${mb(cur)} of ${mb(tot)}`,
      pct: (cur / tot) * 100,
    });
  };
  // Close the throttled progress step when the pull resolves.
  line.done = (ok) => {
    if (!shown) return;
    let tot = 0;
    for (const l of layers.values()) tot += l.tot;
    send({ t: 'step', id: 'layers', state: ok ? 'ok' : 'fail', label: `${layers.size} layer${layers.size === 1 ? '' : 's'}`, note: ok ? `${mb(tot)} pulled` : 'stopped', pct: null });
  };
  return line;
}

async function handleImagePull(req, res) {
  if (!canManageDocker()) return json(res, 403, { error: 'Docker access is read only' });
  const body = await readBody(req);
  const ref = String(body.ref || '');
  const s = ndjson(res);
  s.send({ t: 'step', id: 'pull', state: 'active', label: `Pull ${ref}`, note: 'asking the registry' });
  const r = await pullImage(ref, pullFeed(s.send));
  s.send({ t: 'step', id: 'layers', state: r.ok ? 'ok' : 'fail', note: r.ok ? 'done' : '' });
  s.send({ t: 'step', id: 'pull', state: r.ok ? 'ok' : 'fail', note: r.ok ? 'pulled' : r.note });
  return s.end({ ok: r.ok, note: r.note });
}

// Stream update stages and rollback status.
async function handleContainerUpdate(req, res, id) {
  if (!canManageDocker()) return json(res, 403, { error: 'Docker access is read only' });
  const shielded = await protectedContainerReason(id);
  if (shielded) return json(res, 403, { ok: false, error: shielded });
  const s = ndjson(res);
  const feed = pullFeed(s.send);
  const r = await updateContainer(String(id || ''), (st) => {
    if (st.pull) return feed(st.pull);
    // Close the live layer step when the pull resolves.
    if (st.id === 'pull' && (st.state === 'ok' || st.state === 'fail')) feed.done(st.state === 'ok');
    return s.send({ t: 'step', ...st });
  });
  return s.end({ ok: r.ok, note: r.note, updated: r.updated, failed: r.failed || '', rolledBack: !!r.rolledBack, id: r.id || '' });
}

// Digest checks support forced refresh or cache-only reads.
async function handleApiUpdates(req, res, refresh, cachedOnly) {
  if (refresh) clearUpdateCache();
  const [containers, images] = await Promise.all([listContainers(), listImages()]);
  const imgs = Array.isArray(images) ? images : [];
  if (cachedOnly) {
    const s = updatesState(containers || [], imgs);
    // Return cache age data with the digest result.
    return json(res, 200, { cached: true, checkedAt: s.checkedAt, cacheMs: UPDATE_CACHE_MS, results: s.results });
  }
  const results = decorateUpdates(await checkUpdates(containers || [], imgs));
  return json(res, 200, { checkedAt: Date.now(), cacheMs: UPDATE_CACHE_MS, results });
}

// Refresh one running image reference.
const CHECK_REF_RE = /^[a-z0-9][a-z0-9._/:@-]{1,299}$/i;

async function handleUpdateCheckOne(req, res) {
  const body = await readBody(req);
  const ref = String(body.ref || '');
  if (!CHECK_REF_RE.test(ref) || ref.startsWith('sha256:')) return json(res, 400, { error: 'that does not look like an image reference' });
  const [containers, images] = await Promise.all([listContainers(), listImages()]);
  if (!containers) return json(res, 503, { error: 'Docker is unavailable' });
  // Restrict checks to images used by a container.
  if (!containers.some((c) => c.image === ref)) return json(res, 404, { error: 'no container runs that image' });
  const result = await checkRef(ref, Array.isArray(images) ? images : []);
  return json(res, 200, { result });
}

// Dismissals use the remote digest held by the server, so the body carries references only.
async function handleUpdateDismiss(req, res) {
  const body = await readBody(req);
  const refs = (Array.isArray(body.refs) ? body.refs : [])
    .filter((r) => typeof r === 'string' && r && r.length <= 300)
    .slice(0, 200);
  const [containers, images] = await Promise.all([listContainers(), listImages()]);
  const s = dismissRefs(refs, containers || [], Array.isArray(images) ? images : []);
  return json(res, 200, { checkedAt: s.checkedAt, updateCount: s.updateCount, results: s.results });
}

// Map in-use Docker write failures to HTTP 409.
async function handleDockerWrite(req, res, fn) {
  if (!canManageDocker()) return json(res, 403, { error: 'Docker access is read only' });
  const body = await readBody(req);
  const r = await fn(body || {});
  const status = r.ok ? 200 : /in use by a container|still attached/i.test(r.note || '') ? 409 : 400;
  return json(res, status, r);
}

// Validate and stream Marketplace deployments through the Docker write gate.
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

function deployRefused(res, note) {
  return json(res, 400, { ok: false, steps: [{ step: 'validate', ok: false, note }] });
}

async function handleStackDeploy(req, res) {
  if (!canManageDocker()) return json(res, 403, { error: 'Docker access is read only' });
  const body = await readBody(req, 128 * 1024);
  const name = String(body.name || '');
  const yaml = String(body.yaml || '');
  if (!STACK_NAME.test(name)) return deployRefused(res, 'stack names are letters, digits, dashes and underscores');
  if (!yaml.trim()) return deployRefused(res, 'the compose file is empty');
  if (yaml.length > 20000) return deployRefused(res, 'that compose file is over the 20000 character cap');
  const pairs = Object.entries(body.env && typeof body.env === 'object' ? body.env : {});
  if (pairs.length > 40) return deployRefused(res, '40 environment variables is the cap');
  const env = Object.create(null);
  for (const [k, v] of pairs) {
    if (!ENV_KEY.test(k)) return deployRefused(res, `"${k}" is not a usable variable name`);
    env[k] = v == null ? '' : String(v);
  }
  // Finish the stream with the deployment verdict.
  const s = ndjson(res);
  const r = await deployStack(name, yaml, env, body.start === true, (step) => s.send({ t: 'step', ...step }));
  return s.end(r);
}

// The deploy-editor linter does not change state.
const VALIDATE_BODY_CAP = 128 * 1024;

async function handleComposeValidate(req, res) {
  if (Number(req.headers['content-length']) > VALIDATE_BODY_CAP) {
    return json(res, 413, { error: 'that compose file is too large to lint' });
  }
  const body = await readBody(req, VALIDATE_BODY_CAP);
  const yaml = String(body.yaml || '');
  const stack = STACK_NAME.test(String(body.stack || '')) ? String(body.stack) : '';
  const env = Object.create(null);
  const pairs = Object.entries(body.env && typeof body.env === 'object' ? body.env : {});
  for (const [k, v] of pairs.slice(0, 40)) {
    if (ENV_KEY.test(k)) env[k] = v == null ? '' : String(v);
  }
  // Exclude the edited stack from live port and name conflicts.
  const containers = ((await listContainers()) || []).filter((c) => !stack || c.stack !== stack);
  const publishedHostPorts = [];
  for (const c of containers) {
    for (const p of c.ports || []) {
      const m = /^(\d{1,5}):/.exec(p);
      if (m) publishedHostPorts.push({ port: Number(m[1]), owner: c.name });
    }
  }
  return json(res, 200, { findings: lintCompose(yaml, env, { containers, publishedHostPorts }) });
}

// Stack actions and Compose editing.

// Stack adoption writes Companion state but does not call Docker.
async function handleStackAdopt(req, res) {
  const body = await readBody(req, 64 * 1024);
  const name = String(body.name || '');
  const yaml = String(body.yaml || '');
  if (!STACK_NAME.test(name)) return json(res, 400, { ok: false, error: 'stack names are letters, digits, dashes and underscores' });
  if (!yaml.trim()) return json(res, 400, { ok: false, error: 'the compose file is empty' });
  if (yaml.length > 20000) return json(res, 400, { ok: false, error: 'that compose file is over the 20000 character cap' });
  const saved = saveManagedStack(name, yaml);
  return json(res, saved ? 200 : 400, saved ? { ok: true } : { ok: false, error: 'that stack could not be stored' });
}

// Seed the editor from managed state, a mounted Compose file, or a skeleton.
function seedFromComposeFile(stack) {
  const declared = String(stack.configFiles || '').split(',')[0].trim();
  if (!declared || !declared.startsWith('/')) return null;
  const file = basename(declared);
  if (!/\.ya?ml$/i.test(file) || file.length > 128) return null;
  for (const entry of new Set([stack.name, basename(dirname(declared))])) {
    if (!entry || entry === '.' || entry === '/' || entry.length > 128) continue;
    const bytes = readMountedConfigFile(config.stackDir, entry, file, 64 * 1024);
    if (bytes && bytes.length <= 20000) return bytes.toString('utf8');
  }
  return null;
}

async function handleStackSeed(req, res, name) {
  const stacks = await listStacks();
  if (!stacks) return json(res, 503, { error: 'Docker is unavailable' });
  const stack = stacks.find((s) => s.name === name);
  if (!stack) return json(res, 404, { error: 'no such stack' });
  const stored = getManagedStacks().find((row) => row.name === name);
  if (stored) return json(res, 200, { yaml: stored.yaml, source: 'managed' });
  const fromFile = seedFromComposeFile(stack);
  if (fromFile) return json(res, 200, { yaml: fromFile, source: 'file' });
  return json(res, 200, { yaml: await composeSkeleton(stack, inspectContainer), source: 'skeleton' });
}

// Run stack lifecycle operations serially against a discovered stack.
async function handleStackVerb(req, res, name, verb) {
  if (!canManageDocker()) return json(res, 403, { error: 'Docker access is read only' });
  const stacks = await listStacks();
  if (!stacks) return json(res, 503, { error: 'Docker is unavailable' });
  const stack = stacks.find((s) => s.name === name);
  if (!stack) return json(res, 404, { error: 'no such stack' });
  const guard = await stackProtectionReason(stack, verb);
  if (guard) return json(res, 403, { error: guard });
  const s = ndjson(res);
  const services = [...stack.services].sort((a, b) => a.name.localeCompare(b.name));
  let bad = 0;
  if (verb === 'redeploy') {
    // Stop the batch when an update cannot restore its prior container.
    for (const svc of services) {
      s.send({ t: 'step', id: `${svc.name}/head`, state: 'active', label: `Redeploy ${svc.name}` });
      const feed = pullFeed((o) => s.send({ ...o, id: `${svc.name}/${o.id}` }));
      const r = await updateContainer(svc.id, (st) => {
        if (st.pull) return feed(st.pull);
        if (st.id === 'pull' && (st.state === 'ok' || st.state === 'fail')) feed.done(st.state === 'ok');
        return s.send({ t: 'step', ...st, id: `${svc.name}/${st.id}` });
      });
      s.send({ t: 'step', id: `${svc.name}/head`, state: r.ok ? 'ok' : 'fail', note: r.note });
      if (!r.ok) {
        bad += 1;
        // false means rollback was attempted and failed.
        if (r.rolledBack === false) {
          s.send({ t: 'step', id: 'halt', state: 'fail', label: 'Stopped here', note: `${svc.name} did not roll back cleanly - the rest of the stack was left alone` });
          return s.end({ ok: false, note: `stopped at ${svc.name}: the rollback failed`, halted: true });
        }
      }
    }
    return s.end({ ok: bad === 0, note: bad ? `${bad} of ${services.length} failed` : `redeployed ${services.length} container${services.length === 1 ? '' : 's'}` });
  }
  if (verb === 'remove') {
    for (const svc of services) {
      s.send({ t: 'step', id: svc.name, state: 'active', label: `Remove ${svc.name}` });
      if (svc.state === 'running' || svc.state === 'paused' || svc.state === 'restarting') {
        const stopped = await containerActionResult(svc.id, 'stop');
        if (!stopped.ok) {
          bad += 1;
          s.send({ t: 'step', id: svc.name, state: 'fail', note: stopped.note });
          continue;
        }
      }
      const gone = await removeContainer(svc.id);
      if (!gone.ok) bad += 1;
      s.send({ t: 'step', id: svc.name, state: gone.ok ? 'ok' : 'fail', note: gone.ok ? 'removed' : gone.note });
    }
    return s.end({ ok: bad === 0, note: bad ? `${bad} of ${services.length} refused` : 'the stack is down - volumes and networks stay' });
  }
  for (const svc of services) {
    s.send({ t: 'step', id: svc.name, state: 'active', label: `${verb[0].toUpperCase()}${verb.slice(1)} ${svc.name}` });
    const r = await containerActionResult(svc.id, verb);
    if (!r.ok) bad += 1;
    s.send({ t: 'step', id: svc.name, state: r.ok ? 'ok' : 'fail', note: r.note });
  }
  return s.end({ ok: bad === 0, note: bad ? `${bad} of ${services.length} refused` : 'done' });
}

// Live streams require a browser session; bearer tokens are read-only request credentials.
function handleStream(req, res, session, token, url) {
  if (!session) return json(res, 401, { error: 'the live stream needs a signed-in browser session' });
  const asked = String(url.searchParams.get('topics') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const topics = asked.length ? asked.filter((t) => HUB_TOPICS.includes(t)) : [...HUB_TOPICS];
  if (!topics.length) return json(res, 400, { error: 'no such topic' });
  // Limit streams by session digest without storing the token.
  const digest = createHash('sha256').update(token).digest('hex');
  if (hub.full(digest)) {
    return json(res, 503, { error: 'the live stream is full. The page keeps polling; retry in a minute.' }, { 'retry-after': '60' });
  }
  res.writeHead(200, {
    'x-content-type-options': 'nosniff',
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no', // prevent reverse-proxy buffering
  });
  res.write(': connected\n\n');
  const leave = hub.subscribe({
    topics,
    sessionDigest: digest,
    write: (chunk) => { if (!res.writableEnded) res.write(chunk); },
  });
  if (!leave) { res.end(); return; }
  res.on('close', leave);
}

// Return only the container fields needed by the jump overlay.
async function handleJump(req, res) {
  const containers = (await listContainers()) || [];
  const stacks = [...new Set(containers.map((c) => c.stack).filter(Boolean))].sort();
  return json(res, 200, {
    containers: containers.map((c) => ({ id: String(c.id).slice(0, 12), name: c.name, state: c.state })),
    stacks,
    pages: [
      { label: 'Dashboard', href: '/' },
      { label: 'Containers', href: '/containers' },
      { label: 'Stacks', href: '/stacks' },
      { label: 'Images', href: '/images' },
      { label: 'Volumes', href: '/volumes' },
      { label: 'Networks', href: '/networks' },
      { label: 'Console', href: '/console' },
      { label: 'Activity', href: '/activity' },
      { label: 'Marketplace', href: '/catalogue' },
      { label: 'Cron jobs', href: '/cron' },
      { label: 'Set up', href: '/pair' },
      { label: 'Devices', href: '/devices' },
      { label: 'Settings', href: '/settings' },
      { label: 'Profile', href: '/profile' },
    ],
  });
}

// Execute one command after Docker control and protection checks.
async function handleExec(req, res) {
  if (!canUseDockerShell()) return json(res, 403, { error: 'Docker shell access is off' });
  const body = await readBody(req);
  const id = String(body.id || '');
  const shielded = await protectedContainerReason(id);
  if (shielded) return json(res, 403, { ok: false, error: shielded });
  const result = await execInContainer(id, String(body.cmd || ''));
  return json(res, 200, { output: cleanLog(result.output || ''), code: result.code, ok: !!result.ok });
}

// Request routing and authorization.

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Return the configured HTTPS owner-panel target. */
function secureOwnerTarget() {
  try {
    return secureOwnerConfiguration();
  } catch {
    return { origin: null, reason: 'The secure owner surface configuration is invalid.', failure: null };
  }
}

/** Refuse plaintext owner access and link to HTTPS only when reachable. */
function refuseOnPlaintext(req, res, target, what) {
  const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
  // Report invalid configuration separately from a failed HTTPS listener.
  const failure = typeof target.failure === 'string' && target.failure ? target.failure : null;
  const remedy = 'Set QM_ADVERTISED_ORIGIN to an exact HTTPS URL and make its port match MOBILE_PORT in the .env beside docker-compose.mobile.yml. Recreate the stack with the same -f overlay list. To use the plaintext panel instead, set MOBILE_API_ENABLED=false and recreate Companion.';
  if (wantsHtml) {
    const destination = failure
      ? `<p>The secure panel did not start, so ${escapeHtml(target.origin || 'its address')} will not answer.</p>
<p><b>Reason:</b> ${escapeHtml(failure)}</p>
<p>${escapeHtml(remedy)}</p>`
      : target.origin
        ? `<p>The secure panel for this Companion is at <a href="${escapeHtml(target.origin)}/">${escapeHtml(target.origin)}</a>.</p>`
        : `<p>Secure owner access is on, but no valid address is configured for it, so there is nowhere to send you.</p>
<p>${escapeHtml(remedy)}</p>`;
    // Serve the refusal page stylesheet without a session.
    return html(res, 403, `<!doctype html><meta charset="utf-8"><title>Use the secure address</title>
<link rel="stylesheet" href="/assets/app.css">
<div class="scroll" style="padding:24px;max-width:70ch">
<p>${escapeHtml(what)}</p>
${destination}
<p>This plain address exposes only the health check and static assets. It never accepts a credential or returns panel data.</p>
</div>`);
  }
  return json(res, 403, {
    error: 'use the secure owner surface',
    // Do not advertise a failed listener as reachable.
    ...(failure ? { reason: failure, remedy } : target.origin ? { origin: target.origin } : {}),
  });
}

async function route(req, res, panel = {}) {
  const auth = panel.auth || browserAuth;
  const securePanel = panel.secure === true;
  const url = new URL(req.url, securePanel ? 'https://x' : 'http://x');
  const path = url.pathname;
  const method = req.method;

  // Public health endpoint.
  if (path === '/healthz') return send(res, 200, 'ok');
  if (path === '/assets/app.css') return send(res, 200, styles, { 'content-type': 'text/css; charset=utf-8' });
  if (path === '/assets/logo.png') {
    const logo = getLogo();
    if (logo) return send(res, 200, logo, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return send(res, 404, 'not found');
  }
  if (path.startsWith('/assets/icons/')) {
    // Asset names are map keys, not filesystem paths.
    const svg = getIcon(path.slice('/assets/icons/'.length).replace(/\.svg$/, ''));
    if (svg) return send(res, 200, svg, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' });
    return send(res, 404, 'not found');
  }
  if (path.startsWith('/assets/fonts/')) {
    // Font names are map keys.
    const font = getFont(path.slice('/assets/fonts/'.length));
    if (font) return send(res, 200, font, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=604800' });
    return send(res, 404, 'not found');
  }

  // Keep owner routes closed on plaintext whenever HTTPS mode is configured.
  const secure = securePanel ? null : secureOwnerTarget();
  if (secure) {
    return refuseOnPlaintext(
      req,
      res,
      secure,
      STATE_CHANGING.has(method) ? 'This plain address cannot accept changes.' : 'Open the panel and sign in on the secure address.',
    );
  }

  const owner = hasOwner();

  // Setup routes exist only before owner creation.
  if (!owner) {
    if (path === '/setup') return auth.authPlane.handleSetup(req, res, method);
    return redirect(res, '/setup');
  }
  // Hide setup routes after owner creation.
  if (path === '/setup') return send(res, 404, 'Not found');

  // Redeem the one-time transfer capability before sending its body.
  const redeem = /^\/pair\/redeem\/([A-Za-z0-9_-]{43})$/u.exec(path);
  if (redeem && method === 'GET') return handlePairRedeem(res, redeem[1]);

  // Public authentication routes.
  if (path === '/login') return auth.authPlane.handleLogin(req, res, method);
  if (path === '/login/mfa' && method === 'POST') return auth.authPlane.handleLoginMfa(req, res);

  // Bearer tokens may read JSON API routes only.
  const token = auth.authPlane.sessionToken(req);
  const session = auth.authPlane.sessionOf(token);
  if (!session) {
    const bearer = (req.headers.authorization || '').match(/^Bearer (qmc_[a-f0-9]{48})$/);
    const tokenOk = bearer && BEARER_READ_PATHS.has(path) && method === 'GET'
      && findApiToken(createHash('sha256').update(bearer[1]).digest('hex'));
    if (!tokenOk) {
      if (method === 'GET' && (req.headers.accept || '').includes('text/html')) return redirect(res, '/login');
      return json(res, 401, { error: 'auth required' });
    }
  }

  // JavaScript writes use the session CSRF header; form handlers validate body tokens.
  if (!session && !path.startsWith('/api/')) return json(res, 401, { error: 'auth required' });

  // Device routes are handled outside the shared owner-panel router.
  if (path.startsWith('/api/mobile/v1/')) {
    if (securePanel && panel.handleMobileOwnerApi) {
      if (STATE_CHANGING.has(method) && !checkCsrf(token, req.headers['x-csrf-token'], auth.plane)) {
        return json(res, 403, { error: 'bad csrf token' });
      }
      if (method === 'GET' && /^\/api\/mobile\/v1\/enrolments\/[A-Za-z0-9_-]{22}$/u.test(path)
        && !checkCsrf(token, req.headers['x-csrf-token'], auth.plane)) {
        return json(res, 403, { error: 'bad csrf token' });
      }
      if (await panel.handleMobileOwnerApi(req, res, path, method)) return undefined;
    }
    return json(res, session ? 404 : 401, { error: session ? 'not found' : 'auth required' });
  }
  if (path === '/devices' || path.startsWith('/devices/')) {
    if (securePanel && panel.handleDevicesPage
      && await panel.handleDevicesPage(req, res, path, method, token, session.csrf, auth.plane)) return undefined;
    if (path === '/devices' && method === 'GET' && session) return renderDevicesReadOnly(res, session.csrf);
    return json(res, session ? 404 : 401, { error: session ? 'not found' : 'auth required' });
  }
  const BODY_CSRF = new Set(['/settings/mfa/enable', '/settings/mfa/disable', '/settings/prefs',
    '/profile/name', '/profile/password', '/profile/token/new', '/profile/token/revoke',
    '/cron/toggle', '/cron/run', '/cron/schedule', '/cron/new', '/cron/edit', '/cron/delete', '/cron/clear-history',
    '/settings/templates/add', '/settings/templates/remove', '/settings/templates/refresh',
    '/pair', '/pair/reissue',
    '/devices/pair', '/devices/pair-qr', '/devices/approve', '/devices/reject', '/devices/revoke', '/devices/forget', '/devices/rename']).has(path);
  if (STATE_CHANGING.has(method)) {
    if (!BODY_CSRF && !checkCsrf(token, req.headers['x-csrf-token'], auth.plane)) return json(res, 403, { error: 'bad csrf token' });
  }

  if (path === '/api/stream' && method === 'GET') return handleStream(req, res, session, token, url);
  if (path === '/api/jump' && method === 'GET') return handleJump(req, res);
  if (path === '/' && method === 'GET') return handleDashboard(req, res, session.csrf);
  if (path === '/pair' && method === 'GET') return handlePairGet(res, session.csrf);
  if (path === '/pair' && method === 'POST') return handlePairPost(req, res, token, session.csrf, auth);
  if (path === '/pair/keys/read' && method === 'POST') return handlePairKeysRead(req, res);
  if (path === '/pair/keys/mint' && method === 'POST') return handlePairKeysMint(req, res, token);
  if (path === '/pair/keys/manual' && method === 'POST') return handlePairKeysManual(req, res);
  if (path === '/pair/keys/forget' && method === 'POST') return handlePairKeysForget(req, res);
  if (path === '/pair/reissue' && method === 'POST') return handlePairReissue(req, res, token, session.csrf, auth);
  const pairFile = /^\/pair\/file\/([A-Za-z0-9_-]{24})$/u.exec(path);
  if (pairFile && method === 'GET') return handlePairFile(res, token, pairFile[1]);
  if (path === '/containers' && method === 'GET') return handleContainers(req, res, session.csrf);
  if (path === '/console' && method === 'GET') return handleConsole(req, res, session.csrf, url.searchParams.get('id'));
  if ((path === '/logs' || path === '/shell') && method === 'GET') return redirectConsole(res, url);
  if (path === '/api/exec' && method === 'POST') return handleExec(req, res);
  if (path === '/catalogue' && method === 'GET') {
    const [services, containers] = await Promise.all([currentServices(), listContainers()]);
    return html(res, 200, cataloguePage(services, canManageDocker(), session.csrf, templateSourcesView(), url.searchParams.get('tab') === 'sources' ? 'sources' : 'catalogue', Array.isArray(containers)));
  }
  if (path === '/settings/templates/add' && method === 'POST') return handleTemplatePost(req, res, token, 'add', auth);
  if (path === '/settings/templates/remove' && method === 'POST') return handleTemplatePost(req, res, token, 'remove', auth);
  if (path === '/settings/templates/refresh' && method === 'POST') return handleTemplatePost(req, res, token, 'refresh', auth);
  if (path === '/settings' && method === 'GET') return html(res, 200, settingsPage(config, dockerAvailable(), session.csrf, getPrefs(), url.searchParams.get('tab')));
  if (path === '/settings/prefs' && method === 'POST') return handlePrefs(req, res, token, auth);
  if (path === '/settings/docker-mode' && method === 'POST') return handleDockerAccessMode(req, res);
  if (path === '/settings/mfa' && method === 'GET') return handleMfaSetup(req, res, token, session.csrf);
  if (path === '/settings/mfa/enable' && method === 'POST') return handleMfaEnable(req, res, token, session.csrf, auth);
  if (path === '/settings/mfa/disable' && method === 'POST') return handleMfaDisable(req, res, token, session.csrf, auth);
  if (path === '/profile' && method === 'GET') return renderProfile(res, session.csrf);
  if (path === '/profile/name' && method === 'POST') return handleProfileName(req, res, token, session.csrf, auth);
  if (path === '/profile/password' && method === 'POST') return handleProfilePassword(req, res, token, session.csrf, auth);
  if (path === '/profile/token/new' && method === 'POST') return handleTokenNew(req, res, token, session.csrf, auth);
  if (path === '/profile/token/revoke' && method === 'POST') return handleTokenRevoke(req, res, token, session.csrf, auth);
  if (path === '/cron' && method === 'GET') {
    // Revalidate protected containers when the job runs.
    const cronTargets = ((await listContainers()) || []).filter((c) => !isProtectedContainer(c.name, (c.labels && c.labels['com.docker.compose.service']) || '', c.labels));
    const access = dockerAccessState();
    return html(res, 200, cronPage(listJobs(), cronTargets, access.canManage, session.csrf, url.searchParams.get('err') === '1', access.canShell));
  }
  if (path === '/cron/toggle' && method === 'POST') return handleCronPost(req, res, token, 'toggle', auth);
  if (path === '/cron/run' && method === 'POST') return handleCronPost(req, res, token, 'run', auth);
  if (path === '/cron/schedule' && method === 'POST') return handleCronPost(req, res, token, 'schedule', auth);
  if (path === '/cron/new' && method === 'POST') return handleCronPost(req, res, token, 'new', auth);
  if (path === '/cron/edit' && method === 'POST') return handleCronPost(req, res, token, 'edit', auth);
  if (path === '/cron/delete' && method === 'POST') return handleCronPost(req, res, token, 'delete', auth);
  if (path === '/cron/clear-history' && method === 'POST') return handleCronPost(req, res, token, 'clear', auth);
  if (path === '/images' && method === 'GET') return handleImages(req, res, session.csrf);
  if (path === '/images/pull' && method === 'POST') return handleImagePull(req, res);
  if (path === '/images/prune' && method === 'POST') return handleDockerWrite(req, res, (b) => (String(b.mode) === 'build' ? prune('build') : pruneImages(String(b.mode) === 'all' ? 'all' : 'dangling')));
  if (path === '/images/remove' && method === 'POST') return handleDockerWrite(req, res, (b) => removeImage(String(b.id || '')));
  if (path === '/volumes' && method === 'GET') {
    // Derive volume users from container mounts.
    const [vols, containers] = await Promise.all([listVolumes(), listContainers()]);
    const usedBy = Object.create(null);
    for (const c of containers || []) {
      for (const m of c.mounts || []) (usedBy[m] || (usedBy[m] = [])).push(c.name);
    }
    return html(res, 200, volumesPage(vols, canManageDocker(), session.csrf, usedBy));
  }
  if (path === '/volumes/remove' && method === 'POST') return handleDockerWrite(req, res, (b) => removeVolume(String(b.name || '')));
  if (path === '/volumes/prune' && method === 'POST') return handleDockerWrite(req, res, () => prune('volumes'));
  if (path === '/networks' && method === 'GET') return html(res, 200, networksPage(await listNetworks(), canManageDocker(), session.csrf));
  if (path === '/networks/create' && method === 'POST') return handleDockerWrite(req, res, (b) => createNetwork(String(b.name || ''), String(b.driver || 'bridge'), String(b.subnet || '')));
  if (path === '/networks/remove' && method === 'POST') return handleDockerWrite(req, res, (b) => removeNetwork(String(b.id || '')));
  if (path === '/networks/prune' && method === 'POST') return handleDockerWrite(req, res, () => prune('networks'));
  if (path === '/activity' && method === 'GET') {
    const range = ['1', '6', '24', '72'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : getPrefs().activityRange;
    return html(res, 200, activityPage(await recentEvents(Number(range)), session.csrf, range, getAuditLog()));
  }
  if (path === '/stacks' && method === 'GET') {
    return html(res, 200, stacksPage(await listStacks(), canManageDocker(), session.csrf, getManagedStacks().map((row) => row.name)));
  }
  if (path === '/stacks/deploy' && method === 'POST') return handleStackDeploy(req, res);
  if (path === '/api/compose/validate' && method === 'POST') return handleComposeValidate(req, res);
  if (path === '/stacks/adopt' && method === 'POST') return handleStackAdopt(req, res);
  const stackSub = /^\/stacks\/([A-Za-z0-9][A-Za-z0-9_-]{0,40})\/(start|stop|restart|redeploy|remove|seed)$/.exec(path);
  if (stackSub && stackSub[2] === 'seed' && method === 'GET') return handleStackSeed(req, res, stackSub[1]);
  if (stackSub && stackSub[2] !== 'seed' && method === 'POST') return handleStackVerb(req, res, stackSub[1], stackSub[2]);
  if (path.startsWith('/containers/') && method === 'POST') {
    const parts = path.split('/');
    if (parts[2] === 'prune' && !parts[3]) return handleDockerWrite(req, res, () => pruneContainersGuarded());
    if (parts[3] === 'update') return handleContainerUpdate(req, res, parts[2]);
    if (parts[3] === 'remove') return handleContainerRemove(req, res, parts[2]);
    return handleContainerAction(req, res, parts[2], parts[3]);
  }
  if (path === '/logout' && method === 'POST') return auth.authPlane.handleLogout(req, res);
  if (path === '/api/services' && method === 'GET') return handleApiServices(req, res);
  // Only browser sessions may force registry refreshes.
  if (path === '/api/updates' && method === 'GET') {
    return handleApiUpdates(
      req,
      res,
      !!session && url.searchParams.get('refresh') === '1',
      !session || url.searchParams.get('cached') === '1',
    );
  }
  if (path === '/api/updates/check' && method === 'POST') return handleUpdateCheckOne(req, res);
  if (path === '/api/updates/dismiss' && method === 'POST') return handleUpdateDismiss(req, res);
  if (path === '/api/docker/df' && method === 'GET') {
    const df = await systemDf();
    if (df === 'blocked') return json(res, 503, { error: 'the socket proxy blocks /system/df (needs SYSTEM: 1)' });
    if (!df) return json(res, 503, { error: 'Docker disk usage is unavailable' });
    return json(res, 200, df);
  }
  if (path === '/api/docker/stats' && method === 'GET') {
    const stats = await dockerStats();
    return stats === null
      ? json(res, 503, { error: 'Docker metrics are unavailable' })
      : json(res, 200, stats);
  }
  if (path === '/api/containers/inspect' && method === 'GET') return handleContainerInspect(req, res, url.searchParams.get('id'));
  if (path === '/api/containers/stats' && method === 'GET') {
    const snapshot = await allContainerStats();
    return snapshot === null
      ? json(res, 503, { error: 'Container metrics are unavailable' })
      : json(res, 200, snapshot);
  }
  if (path === '/api/logs' && method === 'GET') {
    const tail = Math.min(2000, Math.max(50, Number(url.searchParams.get('tail')) || 200));
    const text = await containerLogs(url.searchParams.get('id') || '', tail, url.searchParams.get('ts') === '1');
    return json(res, 200, { text: cleanLog(text) });
  }

  return send(res, 404, 'Not found');
}

/** Shared panel router with plane-specific authentication and optional routes. */
export function createPanelSurface({ authPlane, secure = false, handleDevicesPage = null, handleMobileOwnerApi = null }) {
  const auth = authContext(authPlane);
  return (req, res) => route(req, res, { auth, secure, handleDevicesPage, handleMobileOwnerApi });
}

const browserSurface = createPanelSurface({ authPlane: browserPlane });

export function start() {
  // Validate the authenticated access sidecar before listening.
  const access = dockerAccessState();
  // Suspend jobs that exceed the persisted access mode before listening.
  suspendJobsAboveMode(access.mode);
  // Complete or reject clone reset before starting the mobile listener.
  prepareMobilePlane();
  const server = createServer((req, res) => {
    browserSurface(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'error');
    });
  });
  // Bound request setup without limiting long-running Docker response streams.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  server.listen(config.port, config.bind, () => {
    const where = config.bind === '127.0.0.1' ? 'localhost' : config.bind;
    process.stdout.write(`\n  qm companion on http://${where}:${config.port}\n`);
    if (!hasOwner()) {
      if (setupTokenWasGenerated) process.stdout.write(`  first-run setup token: ${bootstrapSetupToken()}\n`);
      else process.stdout.write('  first-run setup token: use the value configured in SETUP_TOKEN\n');
      process.stdout.write('  first run: open it to claim the admin account.\n\n');
    }
    else process.stdout.write('\n');
    startMobileListener().catch(() => {});
  });
}
