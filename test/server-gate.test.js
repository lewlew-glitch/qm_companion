import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(origin, child) {
  let last;
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.status === 200) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw last || new Error('server did not start');
}

async function waitForSetupToken(output, child) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const match = /first-run setup token: ([A-Za-z0-9_-]{43})/.exec(output());
    if (match) return match[1];
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('server did not print a setup token');
}

function responseCookie(response, name) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(values.join(', '));
  return match ? `${name}=${match[1]}` : '';
}

test('HTTP gates and pairing handoff fail closed end to end', async (t) => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-server-gate-'));
  const stackDir = join(dataDir, 'stack');
  mkdirSync(join(stackDir, 'radarr'), { recursive: true });
  writeFileSync(join(stackDir, 'radarr', 'config.xml'), '<Config><ApiKey>detected-api-key</ApiKey><Port>7878</Port><InstanceName>Radarr HD</InstanceName></Config>');
  const radarr = createHttpServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>Radarr</title></html>'); });
  await new Promise((resolve, reject) => { radarr.once('error', reject); radarr.listen(7878, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { start } from './src/server.js'; start();"], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '22'.repeat(32),
      DATA_DIR: dataDir,
      QM_HOST: '127.0.0.1',
      QM_STACK: stackDir,
      BIND_ADDRESS: '127.0.0.1',
      PORT: String(port),
      DOCKER_HOST: 'tcp://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => radarr.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(origin, child);
  const setupToken = await waitForSetupToken(() => stdout, child);
  const form = { 'content-type': 'application/x-www-form-urlencoded' };

  const setupPage = await fetch(`${origin}/setup`, { redirect: 'manual' });
  assert.equal(setupPage.headers.get('cache-control'), 'no-store');
  assert.equal(setupPage.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(setupPage.headers.get('x-frame-options'), 'DENY');
  assert.match(setupPage.headers.get('permissions-policy') || '', /camera=\(\)/);
  assert.match(setupPage.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

  const confused = await fetch(`${origin}/setup`, { method: 'PUT', headers: form, body: 'password=attacker-password', redirect: 'manual' });
  assert.equal(confused.status, 404, stderr);

  const crossSetup = await fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { ...form, 'sec-fetch-site': 'cross-site' },
    body: 'password=attacker-password',
    redirect: 'manual',
  });
  assert.equal(crossSetup.status, 403, stderr);
  const signalLessSetup = await fetch(`${origin}/setup`, {
    method: 'POST', headers: form, body: 'password=attacker-password', redirect: 'manual',
  });
  assert.equal(signalLessSetup.status, 403);
  const hostileToken = 'z'.repeat(43);
  const hostileClaim = await fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { ...form, 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken: hostileToken, password: 'attacker-password' }).toString(),
    redirect: 'manual',
  });
  assert.equal(hostileClaim.status, 403);
  assert.doesNotMatch(await hostileClaim.text(), new RegExp(hostileToken), 'a rejected bootstrap token must not be reflected');
  assert.equal((await fetch(`${origin}/setup`, { redirect: 'manual' })).status, 200, 'cross-site setup must not claim the owner');

  const attemptClaim = (password) => fetch(`${origin}/setup`, {
    method: 'POST',
    headers: { ...form, 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken, password }).toString(),
    redirect: 'manual',
  });
  const claims = await Promise.all([attemptClaim('correct-owner-password-a'), attemptClaim('correct-owner-password-b')]);
  assert.equal(claims.filter((response) => response.status === 303).length, 1);
  assert.equal(claims.filter((response) => [403, 404, 409].includes(response.status)).length, 1, 'the losing claim is denied');
  const ownerPassword = claims[0].status === 303 ? 'correct-owner-password-a' : 'correct-owner-password-b';
  const setup = claims.find((response) => response.status === 303);
  const sessionCookie = responseCookie(setup, 'qm_sess');
  assert.match(sessionCookie, /^qm_sess=/);

  const crossLogin = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { ...form, 'sec-fetch-site': 'cross-site' },
    body: 'password=wrong-password',
    redirect: 'manual',
  });
  assert.equal(crossLogin.status, 403, stderr);

  const loginForm = await fetch(`${origin}/login`);
  const loginFormToken = (await loginForm.text().then(
    (body) => body.match(/name="formToken" value="([A-Za-z0-9_-]{43})"/)?.[1],
  ));
  const loginFormCookie = responseCookie(loginForm, 'qm_login_form');
  assert.ok(loginFormToken);
  assert.match(loginFormCookie, /^qm_login_form=[A-Za-z0-9_-]{43}$/);
  const browserLikeLogin = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { ...form, cookie: loginFormCookie, 'sec-fetch-site': 'same-site' },
    body: new URLSearchParams({ formToken: loginFormToken, password: 'wrong-password' }).toString(),
    redirect: 'manual',
  });
  assert.equal(browserLikeLogin.status, 401);
  const replayedLogin = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { ...form, cookie: loginFormCookie },
    body: new URLSearchParams({ formToken: loginFormToken, password: ownerPassword }).toString(),
    redirect: 'manual',
  });
  assert.equal(replayedLogin.status, 403);

  const missingRedeem = await fetch(`${origin}/pair/redeem/${'a'.repeat(43)}`, { redirect: 'manual' });
  assert.equal(missingRedeem.status, 404);
  assert.equal(await missingRedeem.text(), 'Pairing transfer unavailable.');

  const wrongVerbRedeem = await fetch(`${origin}/pair/redeem/${'a'.repeat(43)}`, { method: 'POST', redirect: 'manual' });
  assert.equal(wrongVerbRedeem.status, 401, 'only the exact GET redemption route is public');

  const pairConfig = await fetch(`${origin}/pair`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
  assert.equal(pairConfig.status, 200, stderr);
  const configHtml = await pairConfig.text();
  const csrf = (configHtml.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
  const instanceId = (configHtml.match(/name="service_0" value="([^"]+)"/) || [])[1];
  assert.ok(csrf && instanceId);
  assert.match(configHtml, /<form method="post" action="\/pair"/);
  assert.match(configHtml, /data-pair-section="unverified">[\s\S]*data-avail="unverified" data-docker-state=""/);
  assert.match(configHtml, /<input type="checkbox" name="include_0"\s*>/);
  assert.match(configHtml, /<span class="badge line">Not checked<\/span>/);
  assert.doesNotMatch(configHtml, /name="svc"|method="get" action="\/pair"/);

  const tokenResponse = await fetch(`${origin}/profile/token/new`, {
    method: 'POST',
    headers: { cookie: sessionCookie, ...form, 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ csrf, name: 'gate test' }).toString(),
  });
  assert.equal(tokenResponse.status, 200);
  const apiToken = (await tokenResponse.text().then((body) => body.match(/qmc_[a-f0-9]{48}/)?.[0]));
  assert.ok(apiToken, 'a read-only API token is shown once');
  const bearerHeaders = { authorization: `Bearer ${apiToken}` };
  const bearerServices = await fetch(`${origin}/api/services`, { headers: bearerHeaders });
  assert.equal(bearerServices.status, 200);
  assert.match(bearerServices.headers.get('cache-control') || '', /no-store/);
  const servicesBody = await bearerServices.json();
  assert.equal(servicesBody.services[0].availability, 'unverified');
  assert.equal(servicesBody.services[0].dockerState, null);
  assert.equal(servicesBody.services[0].up, true);
  assert.doesNotMatch(JSON.stringify(servicesBody), /detected-api-key/);
  const bearerUpdates = await fetch(`${origin}/api/updates?refresh=1`, { headers: bearerHeaders });
  assert.equal(bearerUpdates.status, 200);
  assert.equal((await bearerUpdates.json()).cached, true);
  const sessionDeploy = await fetch(`${origin}/stacks/deploy`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ name: 'gate-test', yaml: 'services:\n  app:\n    image: example/app:latest\n', start: true }),
  });
  assert.equal(sessionDeploy.status, 403);
  const bearerDeploy = await fetch(`${origin}/stacks/deploy`, {
    method: 'POST',
    headers: { ...bearerHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'gate-test', yaml: 'services:\n  app:\n    image: example/app:latest\n', start: true }),
  });
  assert.equal(bearerDeploy.status, 401, 'read-only API tokens cannot deploy stacks');
  assert.equal(
    (await fetch(`${origin}/api/logs?id=${'a'.repeat(12)}`, { headers: bearerHeaders })).status,
    401,
  );

  const consoleGet = await fetch(`${origin}/console?id=${'a'.repeat(12)}`, { headers: { cookie: sessionCookie, accept: 'text/html' } });
  assert.equal(consoleGet.status, 200, 'the console page needs only a session');
  const logsRedirect = await fetch(`${origin}/logs?id=${'a'.repeat(12)}`, { headers: { cookie: sessionCookie }, redirect: 'manual' });
  assert.equal(logsRedirect.status, 302, 'the old logs url redirects');
  assert.equal(logsRedirect.headers.get('location'), `/console?id=${'a'.repeat(12)}`);
  const shellRedirect = await fetch(`${origin}/shell?id=${'b'.repeat(12)}`, { headers: { cookie: sessionCookie }, redirect: 'manual' });
  assert.equal(shellRedirect.status, 302, 'the old shell url redirects');
  assert.equal(shellRedirect.headers.get('location'), `/console?id=${'b'.repeat(12)}`);
  const execNoCsrf = await fetch(`${origin}/api/exec`, {
    method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'a'.repeat(12), cmd: 'id' }),
  });
  assert.equal(execNoCsrf.status, 403, 'exec without a csrf token is refused');
  const execWithCsrf = await fetch(`${origin}/api/exec`, {
    method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ id: 'a'.repeat(12), cmd: 'id' }),
  });
  assert.equal(execWithCsrf.status, 403, 'exec stays off while container control is off');
  const execBearer = await fetch(`${origin}/api/exec`, {
    method: 'POST', headers: { ...bearerHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'a'.repeat(12), cmd: 'id' }),
  });
  assert.equal(execBearer.status, 401);

  const streamAnon = await fetch(`${origin}/api/stream`);
  assert.equal(streamAnon.status, 401, 'the live stream needs a session');
  const streamBearer = await fetch(`${origin}/api/stream`, { headers: bearerHeaders });
  assert.equal(streamBearer.status, 401, 'the live stream refuses bearer tokens outright');
  const streamAbort = new AbortController();
  const stream = await fetch(`${origin}/api/stream?topics=counts`, {
    headers: { cookie: sessionCookie },
    signal: streamAbort.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') || '', /^text\/event-stream/);
  assert.equal(stream.headers.get('cache-control'), 'no-store');
  assert.equal(stream.headers.get('x-accel-buffering'), 'no');
  const streamReader = stream.body.getReader();
  const firstChunk = await streamReader.read();
  assert.match(new TextDecoder().decode(firstChunk.value), /^: connected/);
  streamAbort.abort();
  await streamReader.closed.catch(() => {});

  assert.equal((await fetch(`${origin}/api/jump`)).status, 401, 'the jump list needs a session');
  assert.equal((await fetch(`${origin}/api/jump`, { headers: bearerHeaders })).status, 401, 'the jump list is not for script tokens');
  const jump = await fetch(`${origin}/api/jump`, { headers: { cookie: sessionCookie } });
  assert.equal(jump.status, 200);
  const jumpBody = await jump.json();
  assert.ok(Array.isArray(jumpBody.pages) && jumpBody.pages.length, 'the jump payload lists the static pages');
  assert.doesNotMatch(JSON.stringify(jumpBody), /detected-api-key/, 'the jump payload stays secret-free');

  const jsonPost = (path, body, headers) => fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });
  const sessionJson = { cookie: sessionCookie, 'x-csrf-token': csrf };
  assert.equal((await jsonPost('/api/updates/check', { ref: 'nginx' })).status, 401, 'anonymous single-ref check is refused');
  assert.equal((await jsonPost('/api/updates/check', { ref: 'nginx' }, bearerHeaders)).status, 401, 'bearer tokens cannot post a recheck');
  assert.equal((await jsonPost('/api/updates/check', { ref: 'nginx' }, { cookie: sessionCookie })).status, 403, 'a recheck without the CSRF header is refused');
  assert.equal((await jsonPost('/api/updates/check', { ref: '///nope' }, sessionJson)).status, 400, 'a junk ref is refused before any lookup');
  assert.equal((await jsonPost('/api/updates/check', { ref: 'nginx' }, sessionJson)).status, 503);
  assert.equal((await jsonPost('/api/updates/dismiss', { refs: [] }, bearerHeaders)).status, 401, 'bearer tokens cannot dismiss updates');
  const dismissed = await jsonPost('/api/updates/dismiss', { refs: ['nginx'] }, sessionJson);
  assert.equal(dismissed.status, 200);
  assert.equal((await dismissed.json()).updateCount, 0);

  assert.equal((await jsonPost('/api/compose/validate', { yaml: 'services:' })).status, 401, 'anonymous validate is refused');
  assert.equal((await jsonPost('/api/compose/validate', { yaml: 'services:' }, bearerHeaders)).status, 401, 'bearer tokens cannot lint');
  assert.equal((await jsonPost('/api/compose/validate', { yaml: 'services:' }, { cookie: sessionCookie })).status, 403, 'validate without the CSRF header is refused');
  const lintYaml = 'services:\n  app:\n    image: example/app\n    environment:\n      API_KEY: DO-NOT-ECHO-0123456789abcdef0123456789abcdef\n';
  const validated = await jsonPost('/api/compose/validate', { yaml: lintYaml, env: {} }, sessionJson);
  assert.equal(validated.status, 200, 'linting needs a session, not the control switch');
  const validatedText = await validated.text();
  assert.doesNotMatch(validatedText, /DO-NOT-ECHO/);
  const lintFindings = JSON.parse(validatedText).findings;
  assert.ok(lintFindings.some((f) => f.id === 'QM001') && lintFindings.some((f) => f.id === 'QM007'), 'findings carry stable ids');
  const oversizeLint = await jsonPost('/api/compose/validate', { yaml: 'a'.repeat(130 * 1024) }, sessionJson);
  assert.equal(oversizeLint.status, 413, 'the linter refuses oversize bodies outright');

  for (const verb of ['start', 'stop', 'restart', 'redeploy', 'remove']) {
    assert.equal((await jsonPost(`/stacks/gate-stack/${verb}`, {}, bearerHeaders)).status, 401, `${verb} refuses bearer tokens`);
    assert.equal((await jsonPost(`/stacks/gate-stack/${verb}`, {}, sessionJson)).status, 403, `${verb} stays off without container control`);
  }
  assert.equal((await jsonPost('/stacks/adopt', { name: 'gate-stack', yaml: 'services:\n  app:\n    image: example/app:latest\n' }, bearerHeaders)).status, 401);
  assert.equal((await jsonPost('/stacks/adopt', { name: 'gate stack!', yaml: 'services:\n' }, sessionJson)).status, 400, 'a junk stack name is refused');
  const adopted = await jsonPost('/stacks/adopt', { name: 'gate-stack', yaml: 'services:\n  app:\n    image: example/app:latest\n' }, sessionJson);
  assert.equal(adopted.status, 200, 'adopting needs a session, not the control switch');
  assert.equal((await adopted.json()).ok, true);
  assert.equal((await fetch(`${origin}/stacks/gate-stack/seed`)).status, 401);
  assert.equal((await fetch(`${origin}/stacks/gate-stack/seed`, { headers: bearerHeaders })).status, 401);
  assert.equal((await fetch(`${origin}/stacks/gate-stack/seed`, { headers: { cookie: sessionCookie } })).status, 503);

  assert.equal((await fetch(`${origin}/api/containers/inspect?id=${'a'.repeat(12)}`)).status, 401, 'anonymous inspect is refused');
  assert.equal((await fetch(`${origin}/api/containers/inspect?id=${'a'.repeat(12)}`, { headers: bearerHeaders })).status, 401);
  assert.equal((await fetch(`${origin}/api/containers/inspect?id=${'a'.repeat(12)}`, { headers: { cookie: sessionCookie } })).status, 503, 'Docker unavailability returns 503');

  assert.equal((await jsonPost('/settings/templates/add', { name: 'x', url: 'https://t.example.com/v2.json' })).status, 401, 'anonymous add is refused');
  assert.equal((await jsonPost('/settings/templates/add', { name: 'x', url: 'https://t.example.com/v2.json' }, bearerHeaders)).status, 401, 'bearer tokens cannot add sources');
  assert.equal((await jsonPost('/settings/templates/add', { csrf: 'wrong', name: 'x', url: 'https://t.example.com/v2.json' }, { cookie: sessionCookie })).status, 403, 'a wrong body csrf is refused');
  assert.equal((await jsonPost('/settings/templates/add', { csrf, name: 'x', url: 'http://t.example.com/v2.json' }, { cookie: sessionCookie })).status, 400, 'plain http sources are refused');
  assert.equal((await jsonPost('/settings/templates/add', { csrf, name: 'x', url: 'https://user:pw@t.example.com/v2.json' }, { cookie: sessionCookie })).status, 400, 'credentialed URLs are refused');
  const addedSource = await jsonPost('/settings/templates/add', { csrf, name: 'community', url: 'https://t.example.com/v2.json' }, { cookie: sessionCookie });
  assert.equal(addedSource.status, 200, 'adding needs a session, not the control switch');
  const sourceId = (await addedSource.json()).source.id;
  assert.match(sourceId, /^[0-9a-f]{16}$/);
  assert.equal((await jsonPost('/settings/templates/refresh', { id: sourceId }, bearerHeaders)).status, 401, 'bearer tokens cannot refresh sources');
  assert.equal((await jsonPost('/settings/templates/remove', { id: sourceId }, bearerHeaders)).status, 401, 'bearer tokens cannot remove sources');
  assert.equal((await jsonPost('/settings/templates/remove', { csrf, id: sourceId }, { cookie: sessionCookie })).status, 200);
  assert.equal((await jsonPost('/settings/templates/refresh', { csrf, id: sourceId }, { cookie: sessionCookie })).status, 404, 'a removed source cannot be refreshed');

  for (const volPath of ['/volumes/remove', '/volumes/prune']) {
    assert.equal((await jsonPost(volPath, { name: 'x' }, bearerHeaders)).status, 401, `${volPath} refuses bearer tokens`);
    assert.equal((await jsonPost(volPath, { name: 'x' }, sessionJson)).status, 403, `${volPath} stays off without container control`);
  }
  assert.equal((await fetch(`${origin}/api/docker/df`)).status, 401, 'anonymous df is refused');
  const dfBearer = await fetch(`${origin}/api/docker/df`, { headers: bearerHeaders });
  assert.equal(dfBearer.status, 503);
  assert.match((await dfBearer.json()).error, /unavailable/);

  const pairBody = (baseUrl, secret = '') => new URLSearchParams({
    csrf,
    service_0: instanceId,
    include_0: 'on',
    base_0: baseUrl,
    remote_0: 'https://radarr.example.com/media',
    edge_domain: 'example.com',
    edge_client_id: 'client-id.access',
    edge_client_secret: secret,
  }).toString();
  const pairHeaders = { cookie: sessionCookie, ...form, 'sec-fetch-site': 'same-origin' };
  const invalidPair = await fetch(`${origin}/pair`, { method: 'POST', headers: pairHeaders, body: pairBody('not-a-url', 'DO-NOT-ECHO'), redirect: 'manual' });
  assert.equal(invalidPair.status, 400);
  const invalidHtml = await invalidPair.text();
  assert.doesNotMatch(invalidHtml, /DO-NOT-ECHO/);
  assert.match(invalidHtml, /value="" autocomplete="new-password"/);

  const insecureEdge = await fetch(`${origin}/pair`, { method: 'POST', headers: pairHeaders, body: pairBody('http://192.168.1.20:7878', 'DO-NOT-ECHO'), redirect: 'manual' });
  assert.equal(insecureEdge.status, 400);
  const insecureEdgeHtml = await insecureEdge.text();
  assert.match(insecureEdgeHtml, /Cloudflare Access credentials can only be transferred from Companion over HTTPS/);
  assert.doesNotMatch(insecureEdgeHtml, /DO-NOT-ECHO/);

  const readyBody = new URLSearchParams(pairBody('http://192.168.1.20:7878'));
  readyBody.set('edge_domain', '');
  readyBody.set('edge_client_id', '');
  const ready = await fetch(`${origin}/pair`, { method: 'POST', headers: pairHeaders, body: readyBody.toString(), redirect: 'manual' });
  assert.equal(ready.status, 200, stderr);
  assert.equal(ready.headers.get('cache-control'), 'no-store, max-age=0');
  const readyHtml = await ready.text();
  assert.doesNotMatch(readyHtml, /detected-api-key/);
  assert.match(readyHtml, /One-time transfer ready/);
  assert.match(readyHtml, /download="quartermaster\.qmcompanion"/);
  assert.match(readyHtml, /Download one-use \.qmcompanion file instead/);
  assert.match(readyHtml, /[0-7][0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}/);
  const filePath = (readyHtml.match(/href="(\/pair\/file\/[A-Za-z0-9_-]{24})"/) || [])[1];
  assert.ok(filePath);

  const file = await fetch(origin + filePath, { headers: { cookie: sessionCookie }, redirect: 'manual' });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/vnd.quartermaster.backup+json');
  assert.match(file.headers.get('content-disposition') || '', /quartermaster\.qmcompanion/);
  const envelope = await file.text();
  assert.match(envelope, /"magic":"qmbackup"/);
  assert.doesNotMatch(envelope, /real-client-secret|detected-api-key/);
  assert.equal((await fetch(origin + filePath, { headers: { cookie: sessionCookie }, redirect: 'manual' })).status, 404, 'file fallback is one-use');

  for (const keyPath of ['/pair/keys/read', '/pair/keys/mint', '/pair/keys/forget']) {
    assert.equal((await jsonPost(keyPath, { instanceId })).status, 401, `${keyPath} refuses anonymous`);
    assert.equal((await jsonPost(keyPath, { instanceId }, bearerHeaders)).status, 401, `${keyPath} refuses bearer tokens`);
    assert.equal((await jsonPost(keyPath, { instanceId }, { cookie: sessionCookie })).status, 403, `${keyPath} needs the CSRF header`);
  }
  assert.equal((await jsonPost('/pair/keys/read', { instanceId }, sessionJson)).status, 403, 'reading a key is off without container control');
  assert.equal((await jsonPost('/pair/keys/forget', { instanceId }, sessionJson)).status, 200);

  const mintBody = { instanceId, credentials: { username: 'admin', password: 'DO-NOT-ECHO-mint-secret' } };
  assert.equal((await jsonPost('/pair/keys/mint', mintBody)).status, 401, 'anonymous mint is refused');
  assert.equal((await jsonPost('/pair/keys/mint', mintBody, bearerHeaders)).status, 401, 'bearer tokens cannot mint');
  assert.equal((await jsonPost('/pair/keys/mint', mintBody, { cookie: sessionCookie })).status, 403, 'mint needs the CSRF header');
  const firstMint = await jsonPost('/pair/keys/mint', mintBody, sessionJson);
  assert.equal(firstMint.status, 200, 'a signed-in browser reaches the mint route');
  assert.doesNotMatch(await firstMint.text(), /DO-NOT-ECHO/);
  const basedMint = await jsonPost('/pair/keys/mint', { ...mintBody, baseUrl: 'http://192.168.1.20:9000' }, sessionJson);
  assert.doesNotMatch(await basedMint.text(), /DO-NOT-ECHO/);
  let throttled = 0;
  for (let i = 0; i < 5; i += 1) {
    const r = await jsonPost('/pair/keys/mint', mintBody, sessionJson);
    assert.doesNotMatch(await r.text(), /DO-NOT-ECHO/, 'no mint response ever echoes the password');
    if (r.status === 429) throttled += 1;
  }
  assert.ok(throttled >= 1, 'the mint throttle bites within a minute');

  assert.equal((await jsonPost('/pair/reissue', {})).status, 401, 'anonymous re-issue is refused');
  assert.equal((await jsonPost('/pair/reissue', {}, bearerHeaders)).status, 401, 'bearer tokens cannot re-issue');
  assert.equal((await jsonPost('/pair/reissue', { csrf: 'wrong' }, { cookie: sessionCookie })).status, 403, 'a wrong body csrf is refused');
  const reissued = await fetch(`${origin}/pair/reissue`, { method: 'POST', headers: pairHeaders, body: new URLSearchParams({ csrf }).toString(), redirect: 'manual' });
  assert.equal(reissued.status, 200, stderr);
  const reissuedHtml = await reissued.text();
  assert.match(reissuedHtml, /One-time transfer ready/, 're-issue renders a fresh ready page');
  assert.doesNotMatch(reissuedHtml, /detected-api-key/);

  const freshLoginPage = await fetch(`${origin}/login`);
  const freshLoginToken = (await freshLoginPage.text().then(
    (body) => body.match(/name="formToken" value="([A-Za-z0-9_-]{43})"/)?.[1],
  ));
  const freshLoginCookie = responseCookie(freshLoginPage, 'qm_login_form');
  assert.ok(freshLoginToken);
  const secondLogin = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { ...form, cookie: freshLoginCookie },
    body: new URLSearchParams({ formToken: freshLoginToken, password: ownerPassword }).toString(),
    redirect: 'manual',
  });
  assert.equal(secondLogin.status, 303);
  const secondCookie = responseCookie(secondLogin, 'qm_sess');
  const passwordChange = await fetch(`${origin}/profile/password`, {
    method: 'POST',
    headers: { cookie: sessionCookie, ...form, 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ csrf, current: ownerPassword, next: 'replacement-owner-password' }).toString(),
    redirect: 'manual',
  });
  assert.equal(passwordChange.status, 200);
  assert.match(await passwordChange.text(), /Other signed-in browsers were signed out/);
  const freshCookie = String(passwordChange.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(freshCookie, /^qm_sess=/);
  assert.notEqual(freshCookie, sessionCookie);
  for (const staleCookie of [sessionCookie, secondCookie]) {
    const stale = await fetch(`${origin}/profile`, { headers: { cookie: staleCookie, accept: 'text/html' }, redirect: 'manual' });
    assert.equal(stale.status, 303);
    assert.equal(stale.headers.get('location'), '/login');
  }
  assert.equal((await fetch(`${origin}/profile`, { headers: { cookie: freshCookie } })).status, 200);
});

test('setup tokens meet the bootstrap-token boundary', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-setup-token-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/server.js');"], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        SECRET_KEY: '44'.repeat(32),
        DATA_DIR: dataDir,
        QM_HOST: '127.0.0.1',
        SETUP_TOKEN: 'guessable',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /label boot-setup-token-invalid/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
