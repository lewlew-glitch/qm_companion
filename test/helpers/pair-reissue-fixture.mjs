import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { scryptSync, createDecipheriv, createHash } from 'node:crypto';

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function fields(html) {
  const start = html.indexOf('<form method="post" action="/pair"');
  assert.notEqual(start, -1);
  const form = html.slice(start, html.indexOf('</form>', start));
  const body = new URLSearchParams();
  for (const input of form.match(/<input\b[^>]*>/g) || []) {
    const name = /\bname="([^"]+)"/.exec(input)?.[1];
    if (!name || /\bdisabled\b/.test(input)) continue;
    if (/\btype="checkbox"/.test(input)) {
      if (/\bchecked\b/.test(input)) body.append(name, 'on');
    } else body.append(name, unescape(/\bvalue="([^"]*)"/.exec(input)?.[1] || ''));
  }
  return body;
}
function decode(raw, passphrase) {
  const e = JSON.parse(raw);
  const keys = scryptSync(passphrase.normalize('NFKC'), Buffer.from(e.kdf.saltHex, 'hex'), 48,
    { N: e.kdf.N, r: e.kdf.r, p: e.kdf.p, maxmem: 256 * 1024 * 1024 });
  const ciphertext = Buffer.from(e.ciphertextHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', keys.subarray(0, 32), Buffer.from(e.cipher.nonceHex, 'hex'));
  decipher.setAuthTag(ciphertext.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString());
}
async function until(check) {
  for (let i = 0; i < 1200; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Fixture did not become ready');
}

export async function pairFixture(t, { failQrAt = 0, holdQrAt = 0, extraService = false, withKeys = false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-reissue-selection-'));
  mkdirSync(join(dataDir, 'stack'));
  const fixtures = [];
  let child;
  t.after(async () => {
    writeFileSync(join(dataDir, 'release'), '1');
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    for (const server of fixtures) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fixtures.push(server);
    return server.address().port;
  }
  const containers = [];
  const detected = [['bazarr', 6767, 'a'], ['radarr', 7878, 'b'], ['sonarr', 8989, 'c']];
  if (extraService) detected.push(['prowlarr', 9696, 'd']);
  for (const [kind, privatePort, id] of detected) {
    const publicPort = await listen(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><title>${kind}</title></html>`);
    }));
    containers.push({ Id: id.repeat(64), Names: [`/${kind}`], Image: `lscr.io/linuxserver/${kind}:latest`,
      State: 'running', Ports: [{ Type: 'tcp', PrivatePort: privatePort, PublicPort: publicPort, IP: '0.0.0.0' }],
      Labels: withKeys ? { 'homepage.widget.type': kind, 'homepage.widget.key': `fixture-${kind}-key` } : {} });
  }
  const daemonPort = await listen(createServer((req, res) => {
    if (req.url === '/containers/json?all=1') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(containers));
    } else res.writeHead(404).end();
  }));
  const reserve = createServer();
  const port = await listen(reserve);
  await new Promise((resolve) => reserve.close(resolve)); fixtures.pop();
  const origin = `http://127.0.0.1:${port}`;
  const script = `import QRCode from 'qrcode'; import {existsSync,writeFileSync} from 'node:fs';
    let calls=0; QRCode.toDataURL=async text=>{const call=++calls;
      if(call===${holdQrAt}){writeFileSync(process.env.DATA_DIR+'/held','1');while(!existsSync(process.env.DATA_DIR+'/release'))await new Promise(r=>setTimeout(r,10));}
      if(call===${failQrAt})throw new Error('Fixture QR renderer unavailable');
      return 'data:text/plain;base64,'+Buffer.from(text).toString('base64');};
    const {start}=await import('./src/server.js'); start();`;
  child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(import.meta.dirname, '../..'),
    env: { PATH: process.env.PATH, SECRET_KEY: '34'.repeat(32), DATA_DIR: dataDir, QM_HOST: '127.0.0.1',
      QM_STACK: join(dataDir, 'stack'), BIND_ADDRESS: '127.0.0.1', PORT: String(port),
      DOCKER_HOST: `tcp://127.0.0.1:${daemonPort}`, MOBILE_API_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.resume();
  await until(async () => {
    assert.equal(child.exitCode, null);
    try { return (await fetch(origin + '/healthz')).status === 200; } catch { return false; }
  });
  const setupToken = /first-run setup token: ([A-Za-z0-9_-]{43})/.exec(stdout)?.[1]; assert.ok(setupToken);
  const claim = await fetch(origin + '/setup', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ setupToken, password: 'fixture-password-123' }), redirect: 'manual' });
  assert.equal(claim.status, 303);
  const cookie = /qm_sess=([^;]+)/.exec(claim.headers.getSetCookie().join(';'))?.[0]; assert.ok(cookie);
  const headers = { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' };
  const page = await (await fetch(origin + '/pair', { headers: { cookie } })).text();
  const initial = fields(page);
  const rows = [...page.matchAll(/data-instance="([^"]+)" data-kind="([^"]+)"[^>]*data-order="(\d+)"/g)]
    .map(([, id, kind, index]) => ({ id, kind, index }));
  const fixtureId = (kind) => `${kind}-${createHash('sha256').update(`${kind}\0docker:${kind}`).digest('hex').slice(0, 16)}`;
  for (const [kind] of detected) assert.ok(rows.some((row) => row.id === fixtureId(kind)));
  async function post(path, body) {
    const response = await fetch(origin + path, { method: 'POST', headers, body, redirect: 'manual' });
    const html = await response.text();
    return { status: response.status, html,
      bundleId: /name="bundleId" value="([^"]+)"/.exec(html)?.[1],
      setupCode: /id="setup-code">([^<]+)</.exec(html)?.[1],
      file: /href="(\/pair\/file\/[A-Za-z0-9_-]+)"/.exec(html)?.[1] };
  }
  function createMany(kinds) {
    const body = new URLSearchParams(initial);
    for (const row of rows) body.delete(`include_${row.index}`);
    for (const kind of kinds) body.set(`include_${rows.find((row) => row.id === fixtureId(kind)).index}`, 'on');
    return post('/pair', body);
  }
  return {
    post,
    create: (kind) => createMany([kind]),
    createMany,
    reissue: (ready) => post('/pair/reissue', new URLSearchParams({ csrf: initial.get('csrf'), bundleId: ready.bundleId || '' })),
    selected: (html) => { const body = fields(html); return rows.filter((row) => body.get(`include_${row.index}`) === 'on').map((row) => row.kind); },
    retry: (html) => post('/pair', fields(html)),
    payload: async (ready, transport = 'file') => {
      assert.equal(ready.status, 200); assert.ok(ready.file); assert.ok(ready.setupCode);
      let url = origin + ready.file;
      if (transport === 'qr') {
        const encoded = /id="pair-qr" src="data:text\/plain;base64,([A-Za-z0-9+/=]+)"/.exec(ready.html)?.[1];
        assert.ok(encoded);
        const text = Buffer.from(encoded, 'base64').toString();
        assert.ok(text.startsWith('QMC1:' + origin + '/pair/redeem/'));
        url = text.slice(5);
      }
      const response = await fetch(url, { headers: transport === 'qr' ? {} : { cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/vnd.quartermaster.backup+json');
      return decode(await response.text(), unescape(ready.setupCode));
    },
    otherSessionReissue: async (ready) => {
      const page = await fetch(origin + '/login');
      const loginCookie = /qm_login_form=([^;]+)/.exec(page.headers.getSetCookie().join(';'))?.[0];
      const formToken = /name="formToken" value="([A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
      assert.ok(loginCookie && formToken);
      const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: loginCookie },
        body: new URLSearchParams({ formToken, password: 'fixture-password-123' }) });
      assert.equal(login.status, 303);
      const otherCookie = /qm_sess=([^;]+)/.exec(login.headers.getSetCookie().join(';'))?.[0];
      assert.ok(otherCookie);
      const otherPage = await (await fetch(origin + '/pair', { headers: { cookie: otherCookie } })).text();
      const response = await fetch(origin + '/pair/reissue', { method: 'POST', redirect: 'manual',
        headers: { ...headers, cookie: otherCookie },
        body: new URLSearchParams({ csrf: fields(otherPage).get('csrf'), bundleId: ready.bundleId }) });
      return { status: response.status, html: await response.text() };
    },
    waitHeld: () => until(() => existsSync(join(dataDir, 'held'))),
    release: () => writeFileSync(join(dataDir, 'release'), '1'),
  };
}
