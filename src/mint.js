// Create service API keys using request-scoped admin credentials and detected service addresses.
// Plain HTTP and self-signed TLS are restricted to private or local targets.

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const STEP_TIMEOUT_MS = 10_000;
const MAX_STEPS = 3;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_URL_CHARS = 2048;
const KEY_NAME = 'Quartermaster';

// Enable key creation only for reviewed service flows.
export const MINT_ENABLED_KINDS = new Set(['jellyfin', 'emby', 'portainer']);

export function isMintEnabled(kind) {
  return MINT_ENABLED_KINDS.has(kind);
}

// Used to refuse the route before reading credentials when all kinds are disabled.
export const MINT_ENABLED = MINT_ENABLED_KINDS.size > 0;

/** Allow HTTPS targets and private-network HTTP targets. Injectable lookup is used by tests. */
export async function mintTransportOk(base, { lookup } = {}) {
  let u;
  try { u = new URL(String(base || '')); } catch { return { ok: false, reason: 'Companion does not know a valid address for this service.' }; }
  if (u.protocol === 'https:') return { ok: true };
  if (u.protocol !== 'http:') return { ok: false, reason: 'Companion can only sign in over http or https.' };
  const target = await resolveTarget(u.hostname, lookup || dnsLookup);
  if (target && target.private) return { ok: true };
  return {
    ok: false,
    reason: `Companion will not send an admin password to ${u.host} over plain HTTP: it is not a private address. Serve that service over HTTPS, or create the key in the service and paste it here instead.`,
  };
}

// Keep this list aligned with LADDER_MINT_KINDS; Jellyseerr uses a shared key.
export const MINT_KINDS = [
  'jellyfin', 'emby', 'portainer', 'technitium', 'truenas',
  'proxmox', 'immich', 'komga', 'qui', 'arcane',
];

// Allow relaxed local TLS only for loopback, private, link-local, and ULA addresses.
function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const p = address.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    if (p[0] === 127 || p[0] === 10) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local
    return false;
  }
  if (family === 6) {
    const v = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (v === '::1') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local
    return false;
  }
  return false;
}

// Validate all DNS answers, then pin the connection while preserving HTTP and TLS identity.
async function resolveTarget(hostname, lookupFn) {
  const literal = isIP(hostname);
  if (literal) return { address: hostname, family: literal, name: hostname, private: isPrivateAddress(hostname) };
  const loopbackName = hostname === 'localhost' || hostname.endsWith('.localhost');
  let answers;
  try {
    answers = await lookupFn(hostname, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (!Array.isArray(answers)) answers = answers ? [answers] : [];
  const clean = answers.filter((r) => r && typeof r.address === 'string' && (r.family === 4 || r.family === 6));
  if (clean.length === 0) return null;
  const priv = loopbackName || clean.every((r) => isPrivateAddress(r.address));
  return { address: clean[0].address, family: clean[0].family, name: hostname, private: priv };
}

/** Make one bounded GET or POST without redirects. */
export function mintRequest(method, urlStr, { headers = {}, body = null, timeoutMs = STEP_TIMEOUT_MS, maxBodyBytes = MAX_BODY_BYTES, lookup, request } = {}) {
  return new Promise((resolve) => {
    const verb = String(method || '').toUpperCase();
    const lookupFn = lookup || dnsLookup;
    let u;
    try { u = new URL(urlStr); } catch { resolve(null); return; }
    if (!['GET', 'POST'].includes(verb) || String(urlStr).length > MAX_URL_CHARS
      || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) {
      resolve(null);
      return;
    }
    const cap = Math.min(MAX_BODY_BYTES, Math.max(1, Number(maxBodyBytes) || MAX_BODY_BYTES));
    const deadlineMs = Math.min(30_000, Math.max(50, Number(timeoutMs) || STEP_TIMEOUT_MS));

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
    const deadline = setTimeout(abort, deadlineMs);

    resolveTarget(u.hostname, lookupFn).then((target) => {
      if (done) return;
      if (!target) { finish(null); return; }
      const isHttps = u.protocol === 'https:';
      // Recheck plaintext targets immediately before connecting.
      if (!isHttps && !target.private) { finish(null); return; }
      // Relax certificate verification only for a validated private target.
      const rejectUnauthorized = !(isHttps && target.private);

      const safeHeaders = {};
      for (const [k, val] of Object.entries(headers || {})) {
        if (k.toLowerCase() !== 'host') safeHeaders[k] = val;
      }
      safeHeaders.host = u.host;
      let payload = null;
      if (body != null && verb === 'POST') {
        payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
        safeHeaders['content-length'] = String(payload.length);
      }

      const requestFn = request || (isHttps ? https.request : http.request);
      const opts = {
        hostname: target.address,
        family: target.family,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: verb,
        headers: safeHeaders,
        agent: false,
        maxHeaderSize: 16 * 1024,
      };
      if (isHttps) {
        opts.servername = isIP(target.name) ? undefined : target.name;
        opts.rejectUnauthorized = rejectUnauthorized;
      }

      try {
        req = requestFn(opts, (res) => {
          response = res;
          if (done) { res.destroy(); return; }
          const status = Number(res.statusCode) || 0;
          if (status >= 300 && status < 400) { abort(); return; } // redirects are rejected
          const len = Number((res.headers || {})['content-length']);
          if (Number.isFinite(len) && len > cap) { abort(); return; }
          let size = 0;
          const chunks = [];
          res.on('data', (chunk) => {
            if (done) return;
            const v = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += v.length;
            if (size > cap) { abort(); return; }
            chunks.push(v);
          });
          res.on('end', () => finish({ status, headers: res.headers || {}, body: Buffer.concat(chunks, size).toString('utf8') }));
          res.on('error', abort);
          res.on('aborted', abort);
        });
      } catch {
        finish(null);
        return;
      }
      req.on('error', () => finish(null));
      if (payload) req.write(payload);
      req.end();
    }).catch(() => finish(null));
  });
}

function jsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Flows return a key or a credential-free refusal.
const FLOWS = {
  async jellyfin(base, creds, opt) { return embyFamily(base, creds, opt, ''); },
  async emby(base, creds, opt) { return embyFamily(base, creds, opt, '/emby'); },

  async portainer(base, creds, opt) {
    const auth = await mintRequest('POST', `${base}/api/auth`, { ...opt, headers: json(), body: JSON.stringify({ username: creds.username, password: creds.password }) });
    const jwt = ok(auth) && jsonParse(auth.body)?.jwt;
    if (!jwt) return refused('Portainer', auth);
    const me = await mintRequest('GET', `${base}/api/users/me`, { ...opt, headers: bearer(jwt) });
    const id = ok(me) && jsonParse(me.body)?.Id;
    if (!id) return refused('Portainer', me);
    const tok = await mintRequest('POST', `${base}/api/users/${id}/tokens`, { ...opt, headers: bearer(jwt, true), body: JSON.stringify({ description: KEY_NAME, password: creds.password }) });
    const key = ok(tok) && (jsonParse(tok.body)?.rawAPIKey || jsonParse(tok.body)?.apiKey);
    return key ? done(key) : refused('Portainer', tok);
  },

  async technitium(base, creds, opt) {
    const q = new URLSearchParams({ user: creds.username, pass: creds.password, tokenName: KEY_NAME }).toString();
    const res = await mintRequest('POST', `${base}/api/user/createToken?${q}`, { ...opt, headers: {} });
    const parsed = ok(res) && jsonParse(res.body);
    if (parsed?.status === 'ok' && parsed.token) return done(parsed.token);
    return refused('Technitium', res);
  },

  async truenas(base, creds, opt) {
    const res = await mintRequest('POST', `${base}/api/v2.0/api_key`, { ...opt, headers: { ...json(), ...basic(creds) }, body: JSON.stringify({ name: KEY_NAME }) });
    const key = ok(res) && jsonParse(res.body)?.key;
    return key ? done(key) : refused('TrueNAS', res);
  },

  async proxmox(base, creds, opt) {
    const q = new URLSearchParams({ username: creds.username, password: creds.password }).toString();
    const ticketRes = await mintRequest('POST', `${base}/api2/json/access/ticket`, { ...opt, headers: form(), body: q });
    const data = ok(ticketRes) && jsonParse(ticketRes.body)?.data;
    if (!data?.ticket || !data?.CSRFPreventionToken) return refused('Proxmox', ticketRes);
    const userid = encodeURIComponent(creds.username);
    const tokRes = await mintRequest('POST', `${base}/api2/json/access/users/${userid}/token/${KEY_NAME.toLowerCase()}`, {
      ...opt,
      headers: { ...form(), cookie: `PVEAuthCookie=${data.ticket}`, csrfpreventiontoken: data.CSRFPreventionToken },
      body: 'privsep=0',
    });
    const value = ok(tokRes) && jsonParse(tokRes.body)?.data?.value;
    // Proxmox keys are used as PVEAPIToken=user!tokenid=value; hand back the full triple.
    return value ? done(`${creds.username}!${KEY_NAME.toLowerCase()}=${value}`) : refused('Proxmox', tokRes);
  },

  async immich(base, creds, opt) {
    const login = await mintRequest('POST', `${base}/api/auth/login`, { ...opt, headers: json(), body: JSON.stringify({ email: creds.username, password: creds.password }) });
    const token = ok(login) && jsonParse(login.body)?.accessToken;
    if (!token) return refused('Immich', login);
    const res = await mintRequest('POST', `${base}/api/api-keys`, { ...opt, headers: bearer(token, true), body: JSON.stringify({ name: KEY_NAME, permissions: ['all'] }) });
    const key = ok(res) && jsonParse(res.body)?.secret;
    return key ? done(key) : refused('Immich', res);
  },

  async komga(base, creds, opt) {
    const res = await mintRequest('POST', `${base}/api/v1/users/me/api-keys`, { ...opt, headers: { ...json(), ...basic(creds) }, body: JSON.stringify({ comment: KEY_NAME }) });
    const key = ok(res) && jsonParse(res.body)?.key;
    return key ? done(key) : refused('Komga', res);
  },

  async qui(base, creds, opt) {
    const login = await mintRequest('POST', `${base}/api/auth/login`, { ...opt, headers: json(), body: JSON.stringify({ username: creds.username, password: creds.password }) });
    if (!ok(login)) return refused('qui', login);
    const jar = cookieFrom(login);
    const res = await mintRequest('POST', `${base}/api/api-keys`, { ...opt, headers: { ...json(), cookie: jar }, body: JSON.stringify({ name: KEY_NAME }) });
    const key = ok(res) && (jsonParse(res.body)?.key || jsonParse(res.body)?.apiKey);
    return key ? done(key) : refused('qui', res);
  },

  async arcane(base, creds, opt) {
    const login = await mintRequest('POST', `${base}/api/auth/login`, { ...opt, headers: json(), body: JSON.stringify({ username: creds.username, password: creds.password }) });
    const token = ok(login) && (jsonParse(login.body)?.token || jsonParse(login.body)?.accessToken);
    if (!token) return refused('Arcane', login);
    const res = await mintRequest('POST', `${base}/api/auth/me/api-keys`, { ...opt, headers: bearer(token, true), body: JSON.stringify({ name: KEY_NAME }) });
    const key = ok(res) && (jsonParse(res.body)?.key || jsonParse(res.body)?.apiKey || jsonParse(res.body)?.token);
    return key ? done(key) : refused('Arcane', res);
  },
};

async function embyFamily(base, creds, opt, prefix) {
  const label = prefix ? 'Emby' : 'Jellyfin';
  const authHeader = { 'x-emby-authorization': `MediaBrowser Client="Quartermaster", Device="Companion", DeviceId="quartermaster-companion", Version="1.0.0"` };
  const login = await mintRequest('POST', `${base}${prefix}/Users/AuthenticateByName`, {
    ...opt,
    headers: { ...json(), ...authHeader },
    body: JSON.stringify({ Username: creds.username, Pw: creds.password }),
  });
  const token = ok(login) && jsonParse(login.body)?.AccessToken;
  if (!token) return refused(label, login);
  const create = await mintRequest('POST', `${base}${prefix}/Auth/Keys?App=${KEY_NAME}`, { ...opt, headers: { 'x-emby-token': token } });
  if (!ok(create)) return refused(label, create);
  // The create call returns no body, so select the newest named key afterward.
  const list = await mintRequest('GET', `${base}${prefix}/Auth/Keys`, { ...opt, headers: { 'x-emby-token': token } });
  const items = ok(list) && (jsonParse(list.body)?.Items || []);
  const mine = Array.isArray(items) ? items.filter((i) => i && i.AppName === KEY_NAME && i.AccessToken) : [];
  const newest = mine.sort((a, b) => (b.DateCreated || '').localeCompare(a.DateCreated || ''))[0];
  return newest?.AccessToken ? done(newest.AccessToken) : refused(label, list);
}

// Credential-free response helpers.
const json = () => ({ 'content-type': 'application/json', accept: 'application/json' });
const form = () => ({ 'content-type': 'application/x-www-form-urlencoded' });
const bearer = (t, withJson = false) => (withJson ? { ...json(), authorization: `Bearer ${t}` } : { authorization: `Bearer ${t}` });
const basic = (c) => ({ authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` });
const ok = (r) => !!r && r.status >= 200 && r.status < 300;
const done = (apiKey) => ({ ok: true, apiKey });

function cookieFrom(res) {
  const set = res?.headers?.['set-cookie'];
  const list = Array.isArray(set) ? set : (set ? [set] : []);
  return list.map((c) => String(c).split(';', 1)[0]).filter(Boolean).join('; ');
}

// Map authentication failures separately without echoing response bodies.
function refused(service, res) {
  if (!res) return { ok: false, reason: `${service} did not answer. Check the address and that the service is up.` };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: `${service} refused the sign-in. Check the username and password.` };
  return { ok: false, reason: `${service} did not return a key (status ${res.status}).` };
}

/** Create a key using a server-resolved target and request-scoped credentials. */
export async function mintKey(kind, base, credentials, options = {}) {
  const flow = FLOWS[kind];
  if (!flow) return { ok: false, reason: 'This service cannot have a key created from Companion.' };
  const username = String(credentials?.username ?? '').trim();
  const password = String(credentials?.password ?? '');
  if (!username || !password) return { ok: false, reason: 'Enter both the username and the password.' };
  if (typeof base !== 'string' || !/^https?:\/\//.test(base)) return { ok: false, reason: 'Companion does not know a local address for this service. Check QM_HOST.' };
  const opt = { lookup: options.lookup, request: options.request, timeoutMs: options.timeoutMs };
  try {
    const result = await flow(base.replace(/\/+$/, ''), { username, password }, opt);
    if (result?.ok && typeof result.apiKey === 'string' && result.apiKey.length > 0) return { ok: true, apiKey: result.apiKey };
    return result?.ok ? { ok: false, reason: 'The service returned an empty key.' } : (result || { ok: false, reason: 'The key could not be created.' });
  } catch {
    // Do not expose flow exceptions that may contain credential fragments.
    return { ok: false, reason: 'The key could not be created.' };
  }
}

export { MAX_STEPS };
