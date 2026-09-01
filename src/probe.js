// Credential-free service discovery and reachability probes for known ports.

import { schemeFor } from './kinds.js';
import { fetchTextBounded } from './net.js';
import { httpsTextBounded } from './probe-tls.js';

const FINGERPRINTS = [
  { kind: 'radarr', port: 7878, path: '/', sig: /radarr/i },
  { kind: 'sonarr', port: 8989, path: '/', sig: /sonarr/i },
  { kind: 'prowlarr', port: 9696, path: '/', sig: /prowlarr/i },
  { kind: 'lidarr', port: 8686, path: '/', sig: /lidarr/i },
  { kind: 'bazarr', port: 6767, path: '/', sig: /bazarr/i },
  { kind: 'jellyfin', port: 8096, path: '/System/Info/Public', sig: /jellyfin/i },
  { kind: 'jellyseerr', port: 5055, path: '/api/v1/status', sig: /version|commitTag|restartRequired/i },
  { kind: 'sabnzbd', port: 8080, path: '/', sig: /sabnzbd/i },
  { kind: 'qbittorrent', port: 8080, path: '/', sig: /qbittorrent/i },
  { kind: 'tautulli', port: 8181, path: '/', sig: /tautulli/i },
  { kind: 'homeassistant', port: 8123, path: '/', sig: /home ?assistant/i },
  { kind: 'deluge', port: 8112, path: '/', sig: /deluge/i },
  { kind: 'transmission', port: 9091, path: '/transmission/web/', sig: /transmission/i },
  { kind: 'nzbget', port: 6789, path: '/', sig: /nzbget/i },
  { kind: 'plex', port: 32400, path: '/identity', sig: /MediaContainer|machineIdentifier/i },
  { kind: 'glances', port: 61208, path: '/', sig: /glances/i },
  // Portainer publishes plain http on 9000 and TLS on 9443; each entry names its scheme explicitly.
  { kind: 'portainer', port: 9000, path: '/api/system/status', sig: /Version|Portainer/i, scheme: 'http' },
  { kind: 'portainer', port: 9443, path: '/api/system/status', sig: /Version|Portainer/i, scheme: 'https' },
  { kind: 'pihole', port: 80, path: '/admin/', sig: /pi-hole/i },
  { kind: 'adguard', port: 3000, path: '/', sig: /adguard/i },
  { kind: 'crowdsec', port: 8080, path: '/health', sig: /"status"\s*:\s*"up"/i },
  { kind: 'komodo', port: 9120, path: '/', sig: /komodo/i },
  { kind: 'beszel', port: 8090, path: '/', sig: /beszel/i },
  { kind: 'dockhand', port: 3000, path: '/', sig: /dockhand/i },
  { kind: 'streamystats', port: 3000, path: '/', sig: /streamystats/i },
  { kind: 'lidarr', port: 8686, path: '/', sig: /lidarr/i },
  { kind: 'komga', port: 25600, path: '/', sig: /komga/i },
  { kind: 'audiobookshelf', port: 13378, path: '/', sig: /audiobookshelf|abs/i },
];

// An explicit fingerprint scheme overrides the kind default.
export function probeScheme(fp) {
  return fp.scheme === 'http' || fp.scheme === 'https' ? fp.scheme : schemeFor(fp.kind);
}

// Follow at most one same-origin redirect.
const PROBE_MAX_BYTES = 256 * 1024;

async function probeHttpText(url, timeoutMs) {
  const first = await fetchTextBounded(url, {}, { timeoutMs, maxBytes: PROBE_MAX_BYTES, redirect: 'manual' });
  const status = first.response.status;
  if (status < 300 || status >= 400) return first;
  const location = first.response.headers.get('location');
  if (!location) return first;
  let next;
  try {
    next = new URL(location, url);
  } catch {
    return first; // an unparseable Location is still proof something answered
  }
  if (next.origin !== new URL(url).origin) return first;
  return fetchTextBounded(next.href, {}, { timeoutMs, maxBytes: PROBE_MAX_BYTES, redirect: 'manual' });
}

export async function probeOne(host, fp, timeoutMs) {
  const scheme = probeScheme(fp);
  const url = `${scheme}://${host}:${fp.port}`;
  try {
    let text;
    let server;
    if (scheme === 'https') {
      const answer = await httpsTextBounded(url + fp.path, { timeoutMs, maxBytes: 256 * 1024 });
      text = answer.text;
      server = answer.server;
    } else {
      const answer = await probeHttpText(url + fp.path, timeoutMs);
      text = answer.text;
      server = answer.response.headers.get('server') || '';
    }
    const confirmed = fp.sig.test(text) || fp.sig.test(server || '');
    return { kind: fp.kind, port: fp.port, url, up: true, confirmed };
  } catch {
    return { kind: fp.kind, port: fp.port, url, up: false, confirmed: false };
  }
}

/** Resolve a scheme from kind/port metadata, then the kind default. */
export function schemeForKindPort(kind, port) {
  const exact = FINGERPRINTS.find((fp) => fp.kind === kind && fp.port === Number(port));
  return exact ? probeScheme(exact) : schemeFor(kind);
}

/** Resolve protocol from the container port, falling back to public-port and kind defaults. */
export function schemeForKindPorts(kind, containerPort, publicPort) {
  const inside = FINGERPRINTS.find((fp) => fp.kind === kind && fp.port === Number(containerPort));
  return inside ? probeScheme(inside) : schemeForKindPort(kind, publicPort);
}

export function fingerprintsFor(kind, port) {
  return FINGERPRINTS.filter((fp) => fp.kind === kind && (port === undefined || fp.port === port)).map((fp) => ({ ...fp }));
}

// Preserve failed probes so matching local rows can be marked offline.
export async function probeHostAll(host, timeoutMs = 3000) {
  return Promise.all(FINGERPRINTS.map((fp) => probeOne(host, fp, timeoutMs)));
}

// Probe-only discovery still requires signature checks.
const INSTANCE_PROBE_PATHS = { dockhand: '/api/health' };

function probePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/** Resolve an unambiguous instance target: dial the public port using the container-port protocol. */
export function instanceProbeTarget(row) {
  const publishedPort = probePort(row?.publishedPort);
  const containerPort = probePort(row?.containerPort);
  if (!publishedPort || !containerPort || !row?.kind) return undefined;
  const scheme = schemeForKindPorts(row.kind, containerPort, publishedPort);
  const inside = FINGERPRINTS.find((fp) => fp.kind === row.kind && fp.port === containerPort);
  const fallback = FINGERPRINTS.find((fp) => fp.kind === row.kind);
  const path = INSTANCE_PROBE_PATHS[row.kind] ?? (inside ? inside.path : fallback ? fallback.path : '/');
  const sig = inside ? inside.sig : fallback ? fallback.sig : undefined;
  return { scheme, path, sig, publishedPort };
}

// Successful pages and authentication refusals prove a Docker-identified route is reachable.
function provesPublishedRoute(status) {
  return (status >= 200 && status < 300) || status === 401 || status === 403;
}

// Dial one published port and follow at most one same-origin redirect.
async function dialInstance(scheme, host, port, path, timeoutMs) {
  const url = `${scheme}://${host}:${port}`;
  if (scheme !== 'https') {
    const answer = await probeHttpText(url + path, timeoutMs);
    return { url, status: answer.response.status, server: answer.response.headers.get('server') || '', text: answer.text };
  }
  const first = await httpsTextBounded(url + path, { timeoutMs, maxBytes: PROBE_MAX_BYTES });
  if (first.status < 300 || first.status >= 400 || !first.location) {
    return { url, status: first.status, server: first.server, text: first.text };
  }
  let next;
  try {
    next = new URL(first.location, url + path);
  } catch {
    return { url, status: first.status, server: first.server, text: first.text };
  }
  if (next.origin !== new URL(url).origin) return { url, status: first.status, server: first.server, text: first.text };
  const second = await httpsTextBounded(next.href, { timeoutMs, maxBytes: PROBE_MAX_BYTES });
  return { url, status: second.status, server: second.server, text: second.text };
}

export async function probeInstance(host, row, timeoutMs = 3000) {
  const target = instanceProbeTarget(row);
  if (!target) return undefined;
  const url = `${target.scheme}://${host}:${target.publishedPort}`;
  const verdict = (answer) => provesPublishedRoute(answer.status)
    || (target.sig ? target.sig.test(answer.text) || target.sig.test(answer.server || '') : false);
  try {
    const answer = await dialInstance(target.scheme, host, target.publishedPort, target.path, timeoutMs);
    return { instanceId: row.instanceId, kind: row.kind, port: target.publishedPort, url, up: true, confirmed: verdict(answer) };
  } catch {
    // An alternate response leaves the primary route unverified.
    const alternates = [...new Set((row.publishedPortAlternates || []).map((value) => probePort(value)).filter(Boolean))]
      .filter((port) => port !== target.publishedPort).slice(0, 8);
    for (const port of alternates) {
      try {
        await dialInstance(target.scheme, host, port, target.path, timeoutMs);
        return { instanceId: row.instanceId, kind: row.kind, port: target.publishedPort, url, up: true, confirmed: false };
      } catch {
        // Continue with the next alternate.
      }
    }
    return { instanceId: row.instanceId, kind: row.kind, port: target.publishedPort, url, up: false, confirmed: false };
  }
}

/** Probe each running Docker row that has an unambiguous published mapping. */
export async function probeInstances(host, rows, timeoutMs = 3000) {
  const targets = (rows || []).filter((row) => (row.sources || []).includes('docker')
    && row.dockerState === 'running' && row.instanceId && instanceProbeTarget(row));
  const results = await Promise.all(targets.map((row) => probeInstance(host, row, timeoutMs)));
  return results.filter(Boolean);
}

// Return only fingerprint-confirmed services.
export async function probeHost(host, timeoutMs = 3000) {
  return (await probeHostAll(host, timeoutMs)).filter((r) => r.up && r.confirmed);
}
