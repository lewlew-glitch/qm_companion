// Credentialed live status checks; missing, unreachable, or slow services degrade to null values.

import { isIP } from 'node:net';

import { fetchTextBounded } from './net.js';

// Send recovered keys only over HTTPS or private/loopback HTTP; otherwise omit live status.
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const fam = isIP(h);
  if (fam === 4) {
    const p = h.split('.').map(Number);
    if (p[0] === 127 || p[0] === 10) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    return false;
  }
  if (fam === 6) {
    if (h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
    return false;
  }
  return false;
}

export function isSafeLiveOrigin(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return isPrivateHost(u.hostname);
}

export async function getJson(url, headers, timeoutMs = 4000, fetchImpl = globalThis.fetch) {
  try {
    const { response, text } = await fetchTextBounded(
      url,
      { headers },
      { timeoutMs, maxBytes: 1024 * 1024, fetchImpl },
    );
    if (!response.ok) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const ARR_KINDS = new Set(['radarr', 'sonarr', 'lidarr', 'prowlarr', 'bazarr']);
const DL_KINDS = new Set(['sabnzbd', 'nzbget', 'qbittorrent', 'deluge', 'transmission']);
const NOWPLAY_KINDS = new Set(['jellyfin', 'emby', 'plex', 'tautulli']);

async function arrLive(kind, url, key) {
  const v = kind === 'prowlarr' ? 'v1' : 'v3';
  const h = { 'X-Api-Key': key };
  const [queue, health] = await Promise.all([
    getJson(`${url}/api/${v}/queue?page=1&pageSize=1`, h),
    getJson(`${url}/api/${v}/health`, h),
  ]);
  return {
    queue: queue && typeof queue.totalRecords === 'number' ? queue.totalRecords : null,
    warnings: Array.isArray(health) ? health.filter((w) => w.type === 'warning' || w.type === 'error').length : null,
  };
}

async function sabLive(url, key) {
  const d = await getJson(`${url}/api?mode=queue&output=json&apikey=${encodeURIComponent(key)}`, {});
  const q = d && d.queue;
  return { queue: q ? Number(q.noofslots_total || q.noofslots || 0) : null, speed: q ? q.speed : null };
}

async function jellyfinNow(url, key) {
  const s = await getJson(`${url}/Sessions`, { 'X-Emby-Token': key });
  if (!Array.isArray(s)) return [];
  return s.filter((x) => x.NowPlayingItem).map((x) => ({
    service: 'jellyfin',
    user: x.UserName || '',
    title: x.NowPlayingItem.SeriesName ? `${x.NowPlayingItem.SeriesName} · ${x.NowPlayingItem.Name}` : x.NowPlayingItem.Name,
    paused: !!(x.PlayState && x.PlayState.IsPaused),
  }));
}

async function tautulliNow(url, key) {
  const d = await getJson(`${url}/api/v2?apikey=${encodeURIComponent(key)}&cmd=get_activity`, {});
  const sessions = d && d.response && d.response.data && d.response.data.sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.map((s) => ({
    service: 'plex',
    user: s.friendly_name || s.user || '',
    title: s.grandparent_title ? `${s.grandparent_title} · ${s.title}` : s.full_title || s.title,
    paused: s.state === 'paused',
  }));
}

// Run eligible checks concurrently and leave unsafe origins keyless.
export async function gatherLive(services) {
  const withKey = services.filter((s) => s.apiKey && s.url && isSafeLiveOrigin(s.url));
  const arr = [];
  const now = [];
  await Promise.all(
    withKey.map(async (s) => {
      if (ARR_KINDS.has(s.kind)) arr.push({ kind: s.kind, ...(await arrLive(s.kind, s.url, s.apiKey)) });
      else if (s.kind === 'sabnzbd') arr.push({ kind: 'sabnzbd', ...(await sabLive(s.url, s.apiKey)) });
      else if (s.kind === 'jellyfin' || s.kind === 'emby') now.push(...(await jellyfinNow(s.url, s.apiKey)));
      else if (s.kind === 'tautulli') now.push(...(await tautulliNow(s.url, s.apiKey)));
    }),
  );
  return { arr, now };
}

export { ARR_KINDS, DL_KINDS, NOWPLAY_KINDS };
