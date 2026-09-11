import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-release-http-'));
process.env.SECRET_KEY = '88'.repeat(32);
process.env.QM_HOST = 'nas.local';
process.env.DATA_DIR = dataDir;
process.env.DOCKER_HOST = 'tcp://127.0.0.1:9';
const { companionRelease, createReleaseChecker } = await import('../src/companion-release.js');
const { createPanelSurface } = await import('../src/server.js');
const { createAuthPlane } = await import('../src/auth-plane.js');
const { claimPassword } = await import('../src/auth.js');

test('only an owner session can read Companion release status and browsers share one cache', async (t) => {
  let requests = 0;
  const checker = createReleaseChecker({ currentVersion: '0.1.2', fetchImpl: async () => {
    requests += 1;
    return Response.json({ tag_name: 'v0.1.3', draft: false, prerelease: false });
  } });
  const originalCheck = companionRelease.check;
  companionRelease.check = checker.check;
  claimPassword('release-test-owner-password');
  const plane = createAuthPlane({ sessionCookie: 'qm_test_sess', formCookie: 'qm_test_form', secure: () => false, sessionTtlMs: 3600000 });
  const surface = createPanelSurface({ authPlane: plane });
  const server = createServer((req, res) => surface(req, res).catch(() => { res.writeHead(500); res.end(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    companionRelease.check = originalCheck;
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/companion-release`;
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: { authorization: 'Bearer qmc_' + 'a'.repeat(48) } })).status, 401);
  assert.equal(requests, 0);
  for (let i = 0; i < 2; i += 1) {
    const { token } = plane.newSession();
    const response = await fetch(endpoint, { headers: { cookie: `qm_test_sess=${token}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal((await response.json()).status, 'available');
  }
  assert.equal(requests, 1);
});
