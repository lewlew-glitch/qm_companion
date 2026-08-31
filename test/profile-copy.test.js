import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-companion-profile-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = 'nas.local';
process.env.DATA_DIR = dataDir;
process.env.DOCKER_ACCESS_MAX = 'read';

const { profilePage, TOKEN_READ_PATHS, flashNote } = await import('../src/ui/pages/profile.js');
const { loginPage, setupPage, lockWait } = await import('../src/ui/pages/auth.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

const owner = { name: 'Owner', createdAt: 1_700_000_000_000, lastLoginAt: 1_700_000_100_000 };
const oneToken = [{ id: 'a1', name: 'grafana', prefix: 'qmc_1234ab', createdAt: 1_700_000_000_000, lastUsedAt: null }];

function serverAllowlist() {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const block = /const BEARER_READ_PATHS = new Set\(\[([^\]]*)\]\)/u.exec(source);
  assert.ok(block);
  return [...block[1].matchAll(/'([^']+)'/gu)].map((m) => m[1]);
}

test('renders refused actions as errors', () => {
  const refused = profilePage(owner, false, [], 'csrf', 'Current password was wrong.', null);
  assert.match(refused, /<div class="err"[^>]*>Current password was wrong\.<\/div>/u);
  assert.ok(!refused.includes('color:var(--ok)">Current password'));

  const saved = profilePage(owner, false, [], 'csrf', 'Name saved.', null);
  assert.match(saved, /color:var\(--ok\)">Name saved\./u);

  assert.deepEqual(flashNote('New password needs at least 10 characters.').ok, false);
  assert.deepEqual(flashNote('Token revoked.').ok, true);
  assert.deepEqual(flashNote({ text: 'Nothing changed.', ok: false }).ok, false);
  assert.equal(flashNote(null), null);
});

test('renders unused-token status', () => {
  const html = profilePage(owner, false, oneToken, 'csrf', null, null);
  assert.ok(html.includes('never used'));
  assert.ok(!html.includes('last used Not available'), 'no missing-record wording');

  const used = profilePage(owner, false, [{ ...oneToken[0], lastUsedAt: 1_700_000_500_000 }], 'csrf', null, null);
  assert.ok(used.includes('last used'));
  assert.ok(!used.includes('never used'));
});

test('renders the bearer allowlist and curl example', () => {
  const paths = serverAllowlist();
  assert.deepEqual(TOKEN_READ_PATHS, paths);

  const html = profilePage(owner, false, oneToken, 'csrf', null, 'qmc_' + 'ab'.repeat(24));
  for (const path of paths) assert.ok(html.includes(`<code class="mono">${path}</code>`), `${path} is listed`);
  assert.match(html, /curl -H &quot;Authorization: Bearer qmc_[a-f0-9]+&quot; http:\/\/nas\.local:8787\/api\/services/u);
  assert.ok(html.includes('every other path on the panel is refused'));

  assert.ok(html.includes(paths.join(', ')), 'the generate form names the paths');
  assert.ok(!html.includes('Read-only access to the JSON API for scripts and dashboards'), 'old blanket promise gone');

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gu)].map((m) => m[1]);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));

  const quiet = profilePage(owner, false, oneToken, 'csrf', null, null);
  assert.ok(!quiet.includes('tok-curl'), 'no copy panel when there is no fresh token');
});

test('renders a caller-supplied bearer allowlist', () => {
  const html = profilePage(owner, false, [], 'csrf', null, 'qmc_x', new Set(['/api/only']));
  assert.ok(html.includes('<code class="mono">/api/only</code>'));
  assert.ok(!html.includes('<code class="mono">/api/updates</code>'));
  assert.ok(html.includes('http://nas.local:8787/api/only'), 'the curl uses the first live path');
});

test('renders setup-token location guidance', () => {
  const generated = setupPage(null, true);
  assert.ok(generated.includes('docker logs qm-companion'), 'names the command that reads it back');

  const configured = setupPage(null, false);
  assert.ok(configured.includes('SETUP_TOKEN you set in your compose file or .env'), 'points at where it was set');
  assert.ok(!configured.includes('Shown in the Companion server log'), 'does not point at the log');
  assert.ok(configured.includes('never printed to the log'));
});

test('renders lockout duration and disables sign-in', () => {
  const locked = loginPage(null, 'form-token', 14 * 60 * 1000 + 5_000);
  assert.ok(locked.includes('15 minutes'), 'real remaining time');
  assert.ok(!locked.includes('Wait a few minutes'), 'no vague wait');
  assert.ok(locked.includes('docker restart qm-companion'), 'gives a way out');
  assert.match(locked, /name="password"[^>]*disabled/u, 'the form is not usable while locked');

  const open = loginPage(null, 'form-token');
  assert.ok(!open.includes('disabled'), 'an unlocked form stays usable');
  assert.ok(!open.includes('reopens on its own'));

  assert.equal(lockWait(0), 'under a minute');
  assert.equal(lockWait(45_000), 'under a minute');
  assert.equal(lockWait(61_000), '2 minutes');
  assert.equal(lockWait(60_000), '1 minute');
  assert.equal(lockWait(15 * 60 * 1000), '15 minutes');
});
