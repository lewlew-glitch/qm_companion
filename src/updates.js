// Shared image-update state built from registry digests and owner dismissals.

import { listContainers, listImages } from './docker.js';
import { cachedUpdates, checkUpdates, checkOneUpdate, clearUpdateCache } from './registry.js';
import { getDismissedUpdates, addDismissedUpdates } from './store.js';

// Null until the first check; otherwise the non-dismissed update count.
let lastCount = null;
export function knownUpdateCount() {
  return lastCount;
}

function liveUpdateCount(rows) {
  return rows.filter((row) => row.status === 'update' && !row.dismissed).length;
}

// Dismissals apply only to the matching remote digest.
function applyDismissals(results) {
  const dismissed = new Map(getDismissedUpdates().map((row) => [row.ref, row.digest]));
  return (results || []).map((row) => ({
    ...row,
    dismissed: row.status === 'update' && !!row.remoteDigest
      && dismissed.get(row.image) === String(row.remoteDigest).toLowerCase(),
  }));
}

// Decorate a complete result set and update the shared count.
export function decorateUpdates(results) {
  const rows = applyDismissals(results);
  lastCount = liveUpdateCount(rows);
  return rows;
}

// Return current cache state without network access.
export function updatesState(containers, images) {
  const cached = cachedUpdates(containers || [], Array.isArray(images) ? images : []);
  const results = decorateUpdates(cached.results);
  return { checkedAt: cached.at || null, results, updateCount: liveUpdateCount(results) };
}

// Refresh one reference without replacing fleet state.
export async function checkRef(ref, images) {
  const row = await checkOneUpdate(ref, Array.isArray(images) ? images : []);
  return applyDismissals([row])[0];
}

// Bind dismissals to cached remote digests.
export function dismissRefs(refs, containers, images) {
  const state = updatesState(containers, images);
  const wanted = new Set((Array.isArray(refs) ? refs : []).map(String));
  const rows = state.results
    .filter((row) => row.status === 'update' && row.remoteDigest && wanted.has(row.image))
    .map((row) => ({ ref: row.image, digest: row.remoteDigest }));
  if (rows.length) addDismissedUpdates(rows);
  return updatesState(containers, images);
}

// Cron digest checks require no Docker write access.
export async function runUpdateCheck() {
  const [containers, images] = await Promise.all([listContainers(), listImages()]);
  if (!containers) return { ok: false, note: 'Docker is unavailable' };
  clearUpdateCache();
  const results = decorateUpdates(await checkUpdates(containers, Array.isArray(images) ? images : []));
  const updates = liveUpdateCount(results);
  return { ok: true, note: `${results.length} checked, ${updates} update${updates === 1 ? '' : 's'}` };
}
