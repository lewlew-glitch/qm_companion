import { readFileSync } from 'node:fs';

const RELEASE_API = 'https://api.github.com/repos/lewlew-glitch/qm_companion/releases/latest';
export const RELEASES_URL = 'https://github.com/lewlew-glitch/qm_companion/releases';
export const UPDATE_GUIDE_URL = 'https://github.com/lewlew-glitch/qm_companion/blob/main/docs/updating.md';
const CHECK_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

function versionParts(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || (match[4] || '').split('.').some((part) => /^0\d+$/.test(part))) return null;
  return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4] || '' };
}

export function releaseIsNewer(current, candidate) {
  const a = versionParts(current), b = versionParts(candidate);
  if (!a || !b || b.prerelease) return false;
  for (let index = 0; index < 3; index += 1) {
    if (b.numbers[index] !== a.numbers[index]) return b.numbers[index] > a.numbers[index];
  }
  return !!a.prerelease;
}

export function installedVersion(env = process.env) {
  if (env.COMPANION_VERSION) return versionParts(env.COMPANION_VERSION) ? env.COMPANION_VERSION.replace(/^v/, '') : null;
  try {
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    return versionParts(version) ? version.replace(/^v/, '') : null;
  } catch { return null; }
}

async function readRelease(response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Release unavailable');
  if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error('Release too large');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Release too large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const parsed = versionParts(release?.tag_name);
  if (!parsed || parsed.prerelease || release.draft !== false || release.prerelease !== false) throw new Error('No stable release');
  return { version: release.tag_name.replace(/^v/, ''), url: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}` };
}

// A shared cache keeps navigation independent of GitHub availability and rate limits.
export function createReleaseChecker({ currentVersion = installedVersion(), enabled = true, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 4000 } = {}) {
  let nextCheck = 0, lastSuccess = null, pending = null;
  function state() {
    if (!enabled) return { status: 'disabled', currentVersion };
    if (!lastSuccess || now() - lastSuccess.checkedAt > STALE_MS) return { status: 'unknown', currentVersion };
    return {
      status: releaseIsNewer(currentVersion, lastSuccess.version) ? 'available' : currentVersion ? 'current' : 'unknown',
      currentVersion, latestVersion: lastSuccess.version, releaseUrl: lastSuccess.url,
      checkedAt: new Date(lastSuccess.checkedAt).toISOString(),
    };
  }
  async function check() {
    if (!enabled || now() < nextCheck) return state();
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(RELEASE_API, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'Quartermaster-Companion', 'x-github-api-version': '2026-03-10' },
        });
        const release = await readRelease(response);
        lastSuccess = { ...release, checkedAt: now() };
        nextCheck = now() + CHECK_MS;
      } catch { nextCheck = now() + RETRY_MS; }
      finally { clearTimeout(timeout); }
      return state();
    })();
    try { return await pending; }
    finally { pending = null; }
  }
  return { check, state };
}

export const companionRelease = createReleaseChecker({ enabled: process.env.COMPANION_UPDATE_CHECK !== 'false' });
