import { createHash, randomBytes } from 'node:crypto';

import {
  CREDENTIAL_OPTIONAL,
  PORTS,
  schemeFor,
  NEEDS_LOGIN,
  labelFor,
  pairingCredentialState,
} from './kinds.js';
import { availabilityFor, dockerStateWord } from './availability.js';
import { schemeForKindPorts } from './probe.js';
import { sealEnvelope, PAYLOAD_SCHEMA } from './qmbackup.js';

export { dockerStateWord };

const MAX_URL_BYTES = 2048;
const MAX_EDGE_DOMAIN = 253;
const MAX_EDGE_ID = 512;
const MAX_EDGE_SECRET = 1024;
const MAX_LABEL_CHARS = 256;
const MAX_API_KEY_CHARS = 16_384;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;
const ENCODED_CONTROL = /%(?:[01][0-9a-f]|7f|[89][0-9a-f])/iu;

export class PairingValidationError extends Error {
  constructor(issues) {
    super(issues[0] || 'Check the pairing details and try again.');
    this.name = 'PairingValidationError';
    this.issues = issues;
  }
}

function fail(message) {
  throw new PairingValidationError([message]);
}

/** Normalize service URLs while rejecting credentials, query strings, and fragments. */
export function canonicalizeServiceUrl(value, label = 'Address') {
  const raw = String(value ?? '').trim();
  if (!raw) fail(`${label} is required.`);
  if (Buffer.byteLength(raw, 'utf8') > MAX_URL_BYTES) fail(`${label} is too long.`);
  if (UNSAFE_TEXT.test(raw) || ENCODED_CONTROL.test(raw) || /%(?![0-9a-f]{2})/iu.test(raw) || raw.includes('\\')) {
    fail(`${label} contains characters that cannot be used in an address.`);
  }
  if (raw.includes('?') || raw.includes('#')) fail(`${label} cannot contain a query or fragment.`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} must be a complete http:// or https:// address.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`${label} must start with http:// or https://.`);
  }
  if (!parsed.hostname) fail(`${label} needs a host name or IP address.`);
  if (parsed.username || parsed.password) fail(`${label} cannot contain a username or password.`);
  if (parsed.search || parsed.hash) fail(`${label} cannot contain a query or fragment.`);

  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.origin}${path}`;
}

export function canonicalizeOptionalServiceUrl(value, label = 'Away address') {
  return String(value ?? '').trim() ? canonicalizeServiceUrl(value, label) : undefined;
}

export function canonicalizeEdgeDomain(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.length > MAX_EDGE_DOMAIN || UNSAFE_TEXT.test(raw) || /[\s/@?#\\]/u.test(raw)) {
    fail('Cloudflare Access domain must be a host name such as example.com.');
  }
  let parsed;
  try {
    parsed = new URL(`https://${raw}`);
  } catch {
    fail('Cloudflare Access domain must be a valid host name.');
  }
  if (!parsed.hostname || parsed.port || parsed.hostname !== raw || parsed.pathname !== '/') {
    fail('Cloudflare Access domain must be a host name without a scheme, port or path.');
  }
  const labels = raw.split('.');
  if (labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/u.test(label) || label.startsWith('-') || label.endsWith('-'))) {
    fail('Cloudflare Access domain must be a valid DNS host name.');
  }
  return parsed.hostname;
}

function validateCredential(value, name, max) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > max || UNSAFE_TEXT.test(text)) fail(`${name} is not valid.`);
  return text;
}

export function validateEdgeAccess(edge = {}) {
  const supplied = [edge.domain, edge.clientId, edge.clientSecret].some((v) => String(v ?? '').trim());
  if (!supplied) return null;
  const domain = canonicalizeEdgeDomain(edge.domain);
  const clientId = validateCredential(edge.clientId, 'Cloudflare Access client ID', MAX_EDGE_ID);
  const clientSecret = validateCredential(edge.clientSecret, 'Cloudflare Access client secret', MAX_EDGE_SECRET);
  if (!domain || !clientId || !clientSecret) {
    fail('For Cloudflare Access, enter the domain, client ID and client secret together.');
  }
  return { domain, clientId, clientSecret };
}

function digest(namespace, installationId, value) {
  return createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(installationId)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, 24);
}

function idsFor(installationId, instanceId, kind) {
  return {
    profileId: `prf_${digest('profile', installationId, 'owner')}`,
    serviceId: `svc_${kind}_${digest('service', installationId, instanceId)}`,
  };
}

function setupCode() {
  let n = BigInt(`0x${randomBytes(16).toString('hex')}`);
  let encoded = '';
  for (let i = 0; i < 26; i += 1) {
    encoded = CROCKFORD[Number(n & 31n)] + encoded;
    n >>= 5n;
  }
  return `${encoded.slice(0, 5)}-${encoded.slice(5, 10)}-${encoded.slice(10, 15)}-${encoded.slice(15, 20)}-${encoded.slice(20)}`;
}

function safeHost(raw) {
  const text = String(raw ?? '').trim();
  if (!text || UNSAFE_TEXT.test(text) || /[/@?#\\\s]/u.test(text)) return '';
  try {
    const parsed = new URL(`http://${text}`);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
    return hostname.includes(':') ? `[${hostname}]` : hostname;
  } catch {
    return '';
  }
}

// Resolve mint targets from server-side instance data.
export function suggestedBaseUrl(detected, cfg) {
  // Use probe URLs only after a confirmed response.
  if (detected.url && detected.up === true) {
    try {
      return canonicalizeServiceUrl(detected.url);
    } catch {
      // Missing discovery URLs are completed during configuration.
    }
  }
  const host = safeHost(cfg.qmHost);
  const port = Number(detected.port || PORTS[detected.kind]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return '';
  // Dial the public port using the protocol identified by the container port.
  return `${schemeForKindPorts(detected.kind, detected.containerPort, port)}://${host}:${port}`;
}

// Derive availability when discovery did not provide it.
export function availabilityOf(d) {
  if (typeof d?.availability === 'string' && d.availability) return d.availability;
  return availabilityFor(d || {});
}

// Preselect only running, reachable rows without credential conflicts.
export function includedByDefault(d) {
  return d.credentialConflict !== true && availabilityOf(d) === 'reachable';
}


export function defaultPairDraft(detected, cfg) {
  return {
    services: detected
      .filter((d) => PORTS[d.kind] !== undefined && d.instanceId)
      .map((d) => ({
        instanceId: d.instanceId,
        included: includedByDefault(d),
        baseUrl: suggestedBaseUrl(d, cfg),
        remoteBaseUrl: '',
      })),
    edgeAccess: { domain: '', clientId: '', clientSecret: '' },
  };
}

function hostMatchesDomain(host, domain) {
  const value = host.toLowerCase();
  return value === domain || value.endsWith(`.${domain}`);
}

// Add sign-in mode only for services that still require phone-side credentials.
function credentialModeFor(kind, disabled) {
  if (kind === 'plex') return 'plex';
  if (kind === 'komodo') return 'key-and-secret';
  if (NEEDS_LOGIN.has(kind)) return 'password';
  if (disabled) return 'api-key';
  return undefined;
}

function validateMetadata(metadata) {
  const bundleId = String(metadata?.bundleId ?? '');
  const issuedAt = String(metadata?.issuedAt ?? '');
  const expiresAt = String(metadata?.expiresAt ?? '');
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(bundleId) || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
    throw new Error('Invalid Companion bundle metadata.');
  }
  return { version: 1, bundleId, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString() };
}

/** Build the encrypted app backup from the selected per-instance routes. */
export function buildBundle(detected, cfg, draft, installationId, metadata) {
  const installation = String(installationId ?? '').trim();
  if (!installation || installation.length > 256 || UNSAFE_TEXT.test(installation)) {
    throw new Error('Companion installation ID is unavailable.');
  }

  const usable = detected.filter((d) => PORTS[d.kind] !== undefined && d.instanceId);
  const byInstance = new Map();
  for (const d of usable) {
    if (byInstance.has(d.instanceId)) throw new Error('Discovery returned a duplicate instance ID.');
    byInstance.set(d.instanceId, d);
  }

  const rows = Array.isArray(draft?.services) ? draft.services : [];
  const selected = rows.filter((r) => r && r.included === true);
  if (!selected.length) fail('Pick at least one service to hand over.');
  if (selected.length > 64) fail('There are too many services in one transfer.');

  const seen = new Set();
  const edge = validateEdgeAccess(draft.edgeAccess);
  const accessHeaders = edge ? {
    'CF-Access-Client-Id': edge.clientId,
    'CF-Access-Client-Secret': edge.clientSecret,
  } : undefined;
  const services = selected.map((row) => {
    const instanceId = String(row.instanceId ?? '');
    const found = byInstance.get(instanceId);
    if (!found) fail('One selected service is no longer available. Refresh and try again.');
    if (seen.has(instanceId)) fail('The same service was selected more than once.');
    seen.add(instanceId);

    const rawLabel = found.name == null || found.name === '' ? labelFor(found.kind) : found.name;
    if (typeof rawLabel !== 'string' || rawLabel.length > MAX_LABEL_CHARS || UNSAFE_TEXT.test(rawLabel)) {
      fail('A detected service has an invalid name. Rename it on the server, refresh, and try again.');
    }
    if (found.credentialConflict === true) {
      fail(`${rawLabel} has conflicting API keys. Fix its Homepage labels or container configuration, then refresh.`);
    }
    // Require an override only for unreachable running containers.
    const availability = availabilityOf(found);
    if (availability === 'not-running') {
      fail(`${rawLabel} is ${dockerStateWord(found.dockerState).toLowerCase()} in Docker. Start it, then create the transfer again.`);
    }
    if (availability === 'unreachable' && row.forced !== true) {
      fail(`${rawLabel} is running but Companion cannot reach it. Check its address, or choose Include anyway if your phone can reach it.`);
    }
    if (found.apiKey !== undefined && (typeof found.apiKey !== 'string' || found.apiKey.length > MAX_API_KEY_CHARS || UNSAFE_TEXT.test(found.apiKey))) {
      fail(`${rawLabel} has an invalid API key in its detected configuration.`);
    }
    const detectedApiKey = typeof found.apiKey === 'string' ? found.apiKey.trim() : '';
    if (detectedApiKey && detectedApiKey !== found.apiKey) {
      fail(`${rawLabel} has an invalid API key in its detected configuration.`);
    }
    // Do not transfer API-key hints for services that require interactive credentials.
    const transferableApiKey = NEEDS_LOGIN.has(found.kind) ? '' : detectedApiKey;
    const baseUrl = canonicalizeServiceUrl(row.baseUrl, `${rawLabel} local address`);
    const remoteBaseUrl = canonicalizeOptionalServiceUrl(row.remoteBaseUrl, `${rawLabel} away address`);
    const { serviceId } = idsFor(installation, instanceId, found.kind);
    const remoteHost = remoteBaseUrl ? new URL(remoteBaseUrl).hostname.toLowerCase() : undefined;
    const usesEdge = !!(edge && remoteHost && hostMatchesDomain(remoteHost, edge.domain));
    if (usesEdge && !remoteBaseUrl.startsWith('https://')) {
      fail(`${rawLabel} must use HTTPS before a Cloudflare Access token can be attached.`);
    }
    const disabled = !transferableApiKey && !CREDENTIAL_OPTIONAL.has(found.kind);
    const credentialMode = credentialModeFor(found.kind, disabled);
    const service = {
      id: serviceId,
      kind: found.kind,
      label: rawLabel,
      ...(credentialMode ? { credentialMode } : {}),
      ...(disabled ? { disabled: true } : {}),
      baseUrl,
      ...(remoteBaseUrl ? { remoteBaseUrl } : {}),
      ...(usesEdge ? { edgeDomain: remoteHost } : {}),
      secrets: {
        ...(transferableApiKey ? { apiKey: transferableApiKey } : {}),
        ...(usesEdge ? { headers: accessHeaders } : {}),
      },
    };
    return service;
  });

  if (edge && !services.some((s) => s.edgeDomain)) {
    fail(`No selected away address is on ${edge.domain}, so the Cloudflare Access token would never be used.`);
  }

  const profileId = idsFor(installation, selected[0].instanceId, byInstance.get(selected[0].instanceId).kind).profileId;
  const profileName = String(cfg.qmTitle || 'Home').trim() || 'Home';
  if (profileName.length > MAX_LABEL_CHARS || UNSAFE_TEXT.test(profileName)) throw new Error('Companion profile name is not valid.');
  const profile = {
    id: profileId,
    name: profileName,
    serviceIds: services.map((s) => s.id),
  };
  const companion = validateMetadata(metadata);
  const payload = {
    schema: PAYLOAD_SCHEMA,
    exportedAt: companion.issuedAt,
    profiles: [profile],
    activeProfileId: profileId,
    services,
    identity: { displayName: '', iconKey: null },
    companion,
  };

  const secret = setupCode();
  const envelopeJson = JSON.stringify(sealEnvelope(payload, secret));
  const summary = selected.map((row, index) => {
    const d = byInstance.get(row.instanceId);
    return {
      instanceId: d.instanceId,
      kind: d.kind,
      label: services[index].label,
      baseUrl: services[index].baseUrl,
      remoteBaseUrl: services[index].remoteBaseUrl,
      hasKey: Boolean(services[index].secrets.apiKey),
      needsLogin: NEEDS_LOGIN.has(d.kind),
      credentialState: pairingCredentialState(d.kind, services[index].secrets.apiKey, d.credentialConflict),
    };
  });

  return { setupCode: secret, passphrase: secret, envelopeJson, payload, summary, companion };
}
