// Anonymous Registry v2 digest checks without pulling images.

import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const REQUEST_TIMEOUT_MS = 6000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_CHARS = 8192;
const MAX_TOKEN_CHARS = 16 * 1024;

// Restrict registry checks to publicly routable endpoints.
const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedIpv4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96],
  ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:2::', 48],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
]) blockedIpv6.addSubnet(network, prefix, 'ipv6');

const ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

// Apply Docker Hub shorthand and implicit library namespace rules.
export function parseImageRef(ref) {
  let rest = String(ref || '').trim();
  let host = 'registry-1.docker.io';
  const slash = rest.indexOf('/');
  if (slash > 0) {
    const first = rest.slice(0, slash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      host = first === 'docker.io' ? 'registry-1.docker.io' : first;
      rest = rest.slice(slash + 1);
    }
  }
  let tag = 'latest';
  const at = rest.indexOf('@');
  if (at !== -1) {
    tag = rest.slice(at + 1); // a digest works where a tag does on /manifests/
    rest = rest.slice(0, at);
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon > rest.lastIndexOf('/')) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  }
  if (host === 'registry-1.docker.io' && !rest.includes('/')) rest = `library/${rest}`;
  return { host, repo: rest, tag };
}

// Apply SSRF restrictions to registries and token realms.
function bareHostname(host) {
  const value = String(host || '').toLowerCase();
  const unbracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed;
}

export function blockedRegistryAddress(address) {
  const value = bareHostname(address);
  if (!value || value.includes('%')) return true;
  const family = isIP(value);
  if (family === 4) return blockedIpv4.check(value, 'ipv4');
  if (family === 6) return blockedIpv6.check(value, 'ipv6');
  return true;
}

function blockedRegistryName(hostname) {
  const value = bareHostname(hostname);
  return !value || value === 'localhost' || value === 'metadata.google.internal'
    || value.endsWith('.localhost') || value.endsWith('.local') || value.endsWith('.home.arpa');
}

async function publicEndpoint(hostname, lookupFn) {
  const name = bareHostname(hostname);
  const literalFamily = isIP(name);
  if (literalFamily) {
    return blockedRegistryAddress(name) ? null : { name, address: name, family: literalFamily };
  }
  if (blockedRegistryName(name)) return null;
  let answers;
  try {
    answers = await lookupFn(name, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (!Array.isArray(answers)) answers = answers ? [answers] : [];
  const clean = answers.filter((row) => row && typeof row.address === 'string' && (row.family === 4 || row.family === 6));
  // Reject the target if any DNS answer is non-public.
  if (clean.length === 0 || clean.some((row) => blockedRegistryAddress(row.address))) return null;
  return { name, address: clean[0].address, family: clean[0].family };
}

// Validate all DNS answers, pin the connection, and reject redirects.
export function registryRequest(method, urlStr, headers = {}, options = {}) {
  return new Promise((resolve) => {
    const verb = String(method || '').toUpperCase();
    const timeoutMs = Math.min(30_000, Math.max(50, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS));
    const maxBodyBytes = Math.min(1024 * 1024, Math.max(1, Number(options.maxBodyBytes) || MAX_RESPONSE_BYTES));
    const lookupFn = options.lookup || dnsLookup;
    const requestFn = options.request || https.request;
    let u;
    try { u = new URL(urlStr); } catch { resolve(null); return; }
    if (!['GET', 'HEAD'].includes(verb) || String(urlStr).length > MAX_URL_CHARS || u.protocol !== 'https:'
      || u.username || u.password || u.hash) {
      resolve(null);
      return;
    }

    let req = null;
    let response = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve(value);
    };
    const abort = () => {
      if (response && !response.destroyed) response.destroy();
      if (req && !req.destroyed) req.destroy();
      finish(null);
    };
    const deadline = setTimeout(abort, timeoutMs);

    publicEndpoint(u.hostname, lookupFn).then((endpoint) => {
      if (done) return;
      if (!endpoint) {
        finish(null);
        return;
      }
      const safeHeaders = {};
      for (const [key, value] of Object.entries(headers || {})) {
        if (key.toLowerCase() !== 'host') safeHeaders[key] = value;
      }
      safeHeaders.host = u.host;

      try {
        req = requestFn({
          hostname: endpoint.address,
          family: endpoint.family,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: verb,
          headers: safeHeaders,
          servername: isIP(endpoint.name) ? undefined : endpoint.name,
          agent: false,
          maxHeaderSize: 16 * 1024,
        }, (res) => {
          response = res;
          if (done) {
            res.destroy();
            return;
          }
          const status = Number(res.statusCode) || 0;
          if (status >= 300 && status < 400) {
            abort();
            return;
          }
          const responseHeaders = res.headers || {};
          const contentLength = Number(responseHeaders['content-length']);
          if (verb !== 'HEAD' && Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
            abort();
            return;
          }
          let size = 0;
          const chunks = [];
          res.on('data', (chunk) => {
            if (done) return;
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += value.length;
            if (size > maxBodyBytes) {
              abort();
              return;
            }
            chunks.push(value);
          });
          res.on('end', () => finish({ status, headers: responseHeaders, body: Buffer.concat(chunks, size).toString('utf8') }));
          res.on('error', abort);
          res.on('aborted', abort);
        });
      } catch {
        finish(null);
        return;
      }
      req.on('error', () => finish(null));
      req.end();
    }).catch(() => finish(null));
  });
}

// www-authenticate: Bearer realm="https://...",service="...",scope="..."
function parseAuth(h) {
  if (!h || !/^bearer /i.test(h)) return null;
  const out = {};
  for (const m of h.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out.realm ? out : null;
}

async function fetchToken(auth) {
  let realm;
  try { realm = new URL(auth.realm); } catch { return null; }
  if (realm.protocol !== 'https:' || realm.username || realm.password || realm.hash) return null;
  if (auth.service) realm.searchParams.set('service', auth.service);
  if (auth.scope) realm.searchParams.set('scope', auth.scope);
  const res = await registryRequest('GET', realm.toString(), { accept: 'application/json' });
  if (!res || res.status !== 200) return null;
  try {
    const j = JSON.parse(res.body);
    const token = j && (j.token || j.access_token);
    return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_CHARS
      && !/[\u0000-\u001f\u007f]/u.test(token) ? token : null;
  } catch {
    return null;
  }
}

function manifestUrl(host, repo, tag) {
  let url;
  try { url = new URL(`https://${host}`); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== '/') return null;
  const parts = String(repo).split('/');
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..'
    || part.length > 255 || !/^[a-z0-9._-]+$/i.test(part))) return null;
  const reference = String(tag);
  if (!reference || reference.length > 255 || /[\u0000-\u0020\u007f/?#\\]/u.test(reference)) return null;
  url.pathname = `/v2/${parts.map(encodeURIComponent).join('/')}/manifests/${encodeURIComponent(reference)}`;
  return url.toString();
}

// Fetch a bearer token once after an anonymous 401; return null on failure.
export async function resolveRemoteDigest(ref) {
  const { host, repo, tag } = parseImageRef(ref);
  if (!host || !repo || !tag) return null;
  const url = manifestUrl(host, repo, tag);
  if (!url) return null;
  let res = await registryRequest('HEAD', url, { accept: ACCEPT });
  if (res && res.status === 401) {
    const auth = parseAuth(res.headers['www-authenticate']);
    const token = auth ? await fetchToken(auth) : null;
    if (!token) return null;
    res = await registryRequest('HEAD', url, { accept: ACCEPT, authorization: `Bearer ${token}` });
  }
  if (!res || res.status !== 200) return null;
  return res.headers['docker-content-digest'] || null;
}

// Shared digest-cache interval.
export const UPDATE_CACHE_MS = 45 * 60 * 1000;
const CACHE_MS = UPDATE_CACHE_MS;
const cache = new Map(); // ref -> { digest, at }

export function clearUpdateCache() {
  cache.clear();
}

async function remoteDigest(ref) {
  const hit = cache.get(ref);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.digest;
  const digest = await resolveRemoteDigest(ref);
  if (digest) cache.set(ref, { digest, at: Date.now() });
  return digest;
}

function findLocal(ref, images) {
  const tagged = ref.lastIndexOf(':') > ref.lastIndexOf('/') ? ref : `${ref}:latest`;
  return (images || []).find((i) => (i.tags || []).includes(tagged) && (i.repoDigests || []).length);
}

// Keep local and remote digests for dismissal binding and display.
function compare(ref, remote, images) {
  const local = findLocal(ref, images);
  if (!local) return null;
  const digests = (local.repoDigests || []).map((d) => d.split('@')[1]).filter(Boolean);
  return {
    image: ref,
    status: digests.includes(remote) ? 'current' : 'update',
    localDigest: digests[0] || '',
    remoteDigest: remote,
  };
}

// Return cached update results without starting registry requests. `at` is the oldest included entry.
export function cachedUpdates(containers, images) {
  const out = [];
  let at = 0;
  const seen = new Set();
  for (const c of containers || []) {
    const ref = c.image || '';
    if (!ref || ref.startsWith('sha256:') || seen.has(ref)) continue;
    seen.add(ref);
    const hit = cache.get(ref);
    if (!hit || Date.now() - hit.at >= CACHE_MS) continue;
    const row = compare(ref, hit.digest, images);
    if (row) { out.push(row); if (!at || hit.at < at) at = hit.at; }
  }
  return { at, results: out };
}

// Refresh one image reference without invalidating unrelated cache entries.
export async function checkOneUpdate(ref, images) {
  const remote = await resolveRemoteDigest(ref);
  if (!remote) return { image: ref, status: 'unknown', localDigest: '', remoteDigest: '' };
  cache.set(ref, { digest: remote, at: Date.now() });
  return compare(ref, remote, images) || { image: ref, status: 'unknown', localDigest: '', remoteDigest: remote };
}

// Check only references with comparable local RepoDigests.
export async function checkUpdates(containers, images) {
  const refs = [];
  for (const c of containers || []) {
    const ref = c.image || '';
    if (!ref || ref.startsWith('sha256:') || refs.includes(ref)) continue;
    if (findLocal(ref, images)) refs.push(ref);
  }
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(4, refs.length) }, async () => {
    while (i < refs.length) {
      const ref = refs[i++];
      const remote = await remoteDigest(ref);
      if (!remote) { out.push({ image: ref, status: 'unknown', localDigest: '', remoteDigest: '' }); continue; }
      const row = compare(ref, remote, images);
      if (row) out.push(row);
    }
  }));
  return out;
}
