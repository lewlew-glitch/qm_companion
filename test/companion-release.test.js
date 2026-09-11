import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseChecker, installedVersion, releaseIsNewer, RELEASES_URL } from '../src/companion-release.js';

const response = (overrides = {}) => Response.json({ tag_name: 'v0.1.3', draft: false, prerelease: false, ...overrides });

test('release ordering handles numeric versions, prereleases and build metadata', () => {
  for (const [current, latest, expected] of [
    ['0.1.2', 'v0.1.3', true], ['0.1.9', '0.1.10', true], ['0.9.9', '1.0.0', true],
    ['1.0.0', '0.99.99', false], ['0.1.3', 'v0.1.3', false], ['0.1.4', '0.1.3', false],
    ['1.0.0-beta.2', '1.0.0', true], ['1.0.0+build.2', '1.0.0+build.3', false],
    ['0.1.2', '0.1.3-beta.1', false], ['0.1.2', 'v01.2.3', false],
    ['0.1.2', '1.2.3-01', false], ['unknown', '0.1.3', false], [null, '0.1.3', false],
    ['0.1.2', '<script>', false],
  ]) assert.equal(releaseIsNewer(current, latest), expected, `${current} -> ${latest}`);
});

test('published image version wins over the checkout manifest', () => {
  assert.equal(installedVersion({ COMPANION_VERSION: 'v0.2.10' }), '0.2.10');
  assert.equal(installedVersion({ COMPANION_VERSION: 'development' }), null);
  assert.match(installedVersion({}), /^\d+\.\d+\.\d+/);
});

test('checks coalesce and cache without sending installation data or credentials', async () => {
  let calls = 0, release;
  let now = 1000;
  const checker = createReleaseChecker({ currentVersion: '0.1.2', now: () => now, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.github.com/repos/lewlew-glitch/qm_companion/releases/latest');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
    assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'user-agent', 'x-github-api-version']);
    assert.equal(options.body, undefined);
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
    return response({ html_url: 'https://attacker.invalid/' });
  } });
  const pending = [checker.check(), checker.check(), checker.check()];
  release();
  const result = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.deepEqual(result[0], result[2]);
  assert.equal(result[0].status, 'available');
  assert.equal(result[0].releaseUrl, `${RELEASES_URL}/tag/v0.1.3`);
  await checker.check();
  assert.equal(calls, 1);
  now += 6 * 60 * 60 * 1000;
  await checker.check();
  assert.equal(calls, 2);
});

test('failed checks back off and expire old availability instead of claiming current', async () => {
  let now = 1000, fail = false, calls = 0;
  const checker = createReleaseChecker({ currentVersion: '0.1.2', now: () => now, fetchImpl: async () => {
    calls += 1;
    if (fail) throw new Error('Offline');
    return response();
  } });
  await checker.check();
  fail = true; now += 6 * 60 * 60 * 1000;
  assert.equal((await checker.check()).status, 'available');
  await checker.check();
  assert.equal(calls, 2);
  now += 25 * 60 * 60 * 1000;
  assert.equal((await checker.check()).status, 'unknown');
  assert.equal(checker.state().latestVersion, undefined);
  await checker.check();
  assert.equal(calls, 3);
});

test('disabled checks and unknown local versions never invent an update', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response(); };
  const disabled = createReleaseChecker({ enabled: false, fetchImpl });
  assert.equal((await disabled.check()).status, 'disabled');
  assert.equal(calls, 0);
  const unknown = createReleaseChecker({ currentVersion: null, fetchImpl });
  assert.equal((await unknown.check()).status, 'unknown');
  const current = createReleaseChecker({ currentVersion: '0.1.3', fetchImpl });
  assert.equal((await current.check()).status, 'current');
});

test('drafts, prereleases, malformed and oversized responses remain unknown', async () => {
  for (const make of [
    () => response({ draft: true }), () => response({ prerelease: true }),
    () => response({ tag_name: 'v0.2.0-beta.1' }), () => response({ tag_name: 'v0.2.0/evil' }),
    () => Response.json({}), () => Response.json(null),
    () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => Response.json({ message: 'rate limited' }, { status: 403 }),
    () => new Response('', { status: 302, headers: { location: 'https://attacker.invalid' } }),
    () => response({ body: 'x'.repeat(65536) }),
  ]) {
    const checker = createReleaseChecker({ currentVersion: '0.1.2', fetchImpl: async () => make() });
    assert.equal((await checker.check()).status, 'unknown');
  }
});

test('a stalled request is aborted and later calls use the failure backoff', async () => {
  let calls = 0;
  const checker = createReleaseChecker({ timeoutMs: 15, fetchImpl: async (_url, { signal }) => {
    calls += 1;
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } });
  assert.equal((await checker.check()).status, 'unknown');
  assert.equal((await checker.check()).status, 'unknown');
  assert.equal(calls, 1);
});
