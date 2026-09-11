import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-pair-loading-'));
mkdirSync(join(dataDir, 'stack'));
let gate = null, discoveryRequests = 0;
const containers = ['bazarr', 'radarr', 'sonarr'].map((kind, index) => ({
  Id: String(index + 1).repeat(64), Names: [`/fixture-${kind}`],
  Image: `lscr.io/linuxserver/${kind}:latest`, State: 'running', Ports: [],
  Labels: { 'homepage.widget.type': kind, 'homepage.widget.key': `fixture-private-${kind}-key` },
}));
const daemon = createServer(async (req, res) => {
  if (req.url !== '/containers/json?all=1') return res.writeHead(404).end();
  discoveryRequests += 1;
  const held = gate;
  if (held) { held.enter(); await held.pending; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(containers));
});
await new Promise((resolve) => daemon.listen(0, '127.0.0.1', resolve));
process.env.SECRET_KEY = '86'.repeat(32);
process.env.QM_HOST = 'fixture.invalid';
process.env.DATA_DIR = dataDir;
process.env.QM_STACK = join(dataDir, 'stack');
process.env.DOCKER_HOST = `tcp://127.0.0.1:${daemon.address().port}`;
process.env.COMPANION_UPDATE_CHECK = 'false';
const { createPanelSurface } = await import('../src/server.js');
const { createAuthPlane } = await import('../src/auth-plane.js');
const { claimPassword } = await import('../src/auth.js');
const { addApiToken } = await import('../src/store.js');
claimPassword('fixture-loading-owner-password');
const plane = createAuthPlane({ sessionCookie: 'qm_test_sess', formCookie: 'qm_test_form', secure: () => false, sessionTtlMs: 3600000 });
const surface = createPanelSurface({ authPlane: plane });
const server = createServer((req, res) => surface(req, res).catch(() => { res.writeHead(500); res.end(); }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const ownerHeaders = { cookie: `qm_test_sess=${plane.newSession().token}` };
const bearer = 'qmc_' + 'b'.repeat(48);
addApiToken({ id: 'fixture-read-token', name: 'Read only', prefix: bearer.slice(0, 10),
  hashHex: createHash('sha256').update(bearer).digest('hex'), createdAt: Date.now(), lastUsedAt: null });

after(async () => {
  gate?.release();
  for (const fixture of [server, daemon]) {
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
  }
  rmSync(dataDir, { recursive: true, force: true });
});
function holdDiscovery(t) {
  let release, enter;
  const pending = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = { pending, enter, entered, release() { release(); if (gate === held) gate = null; } };
  gate = held; t.after(() => held.release());
  return held;
}
async function within(promise, milliseconds = 500) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function assertForm(html) {
  assert.match(html, /<form method="post" action="\/pair"/);
  assert.match(html, /name="csrf" value="[^"]+"/);
  const rows = [...html.matchAll(/data-instance="[^"]+" data-kind="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows.sort(), ['bazarr', 'radarr', 'sonarr']);
  for (let index = 0; index < 3; index += 1) {
    assert.match(html, new RegExp(`name="service_${index}"`));
    assert.match(html, new RegExp(`name="include_${index}"`));
  }
  for (const row of containers) {
    assert.ok(html.includes(row.Names[0].slice(1)));
    assert.ok(!html.includes(row.Labels['homepage.widget.key']));
  }
}

test('the setup shell responds while Docker discovery remains blocked', async (t) => {
  const held = holdDiscovery(t), before = discoveryRequests;
  const pending = fetch(origin + '/pair', { headers: ownerHeaders }).then(async (response) => ({ response, html: await response.text() }));
  const result = await within(pending);
  held.release();
  await pending;
  assert.ok(result, 'the shell must respond before the discovery gate is released');
  assert.equal(discoveryRequests, before, 'opening the shell must not start Docker discovery');
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('cache-control'), /no-store/);
  assert.match(result.html, /\/pair\/form/);
  assert.match(result.html, /\/pair\?full=1/);
  assert.doesNotMatch(result.html, /name="service_\d+"/);
});

for (const path of ['/pair/form', '/pair?full=1']) {
  test(`${path} waits for fresh discovery and returns only safe form controls`, async (t) => {
    const held = holdDiscovery(t), before = discoveryRequests;
    let finished = false;
    const pending = fetch(origin + path, { headers: ownerHeaders }).then(async (response) => {
      const html = await response.text(); finished = true; return { response, html };
    });
    assert.ok(await within(held.entered.then(() => true), 1000), 'fresh discovery should begin');
    assert.equal(finished, false);
    if (path === '/pair/form') containers[2].Names = ['/fixture-sonarr-latest'];
    held.release();
    const { response, html } = await pending;
    assert.equal(discoveryRequests, before + 1);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assertForm(html);
    if (path === '/pair/form') assert.doesNotMatch(html, /<!doctype|<html\b/i);
    else assert.match(html, /<!doctype html/i);
  });
}

test('the loading shell and form require an owner session, not an API bearer', async () => {
  const before = discoveryRequests;
  for (const path of ['/pair', '/pair/form', '/pair?full=1']) {
    for (const headers of [{}, { authorization: `Bearer ${bearer}` }]) {
      const response = await fetch(origin + path, { headers, redirect: 'manual' });
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /name="service_\d+"|fixture-private-/);
    }
  }
  assert.equal(discoveryRequests, before);
});
