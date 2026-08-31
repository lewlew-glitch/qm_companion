import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mintKey, mintRequest, mintTransportOk, MINT_KINDS, MINT_ENABLED_KINDS, isMintEnabled } from '../src/mint.js';
import { LADDER_MINT_KINDS } from '../src/keyladder.js';

const SENTINEL = 'do-not-echo-super-secret-password';

async function withStub(handler, run) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base, () => received);
  } finally {
    server.close();
  }
  var received;
}

function jsonRes(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

test('mint registry excludes Jellyseerr', () => {
  assert.deepEqual(MINT_KINDS.slice().sort(), LADDER_MINT_KINDS.slice().sort());
  assert.ok(!MINT_KINDS.includes('jellyseerr'));
});

test('unknown kinds cannot mint', async () => {
  const r = await mintKey('radarr', 'http://127.0.0.1:1', { username: 'a', password: 'b' });
  assert.equal(r.ok, false);
});

test('Jellyseerr minting is disabled', async () => {
  const r = await mintKey('jellyseerr', 'http://127.0.0.1:1', { username: 'a', password: 'b' });
  assert.equal(r.ok, false);
});

test('only supported mint flows are enabled', () => {
  assert.deepEqual([...MINT_ENABLED_KINDS].sort(), ['emby', 'jellyfin', 'portainer']);
  for (const k of ['jellyfin', 'emby', 'portainer']) assert.equal(isMintEnabled(k), true, k);
  for (const k of ['technitium', 'truenas', 'proxmox', 'immich', 'komga', 'qui', 'arcane', 'jellyseerr', 'dockhand']) {
    assert.equal(isMintEnabled(k), false, k);
  }
});

test('transport guard sends passwords only over approved routes', async () => {
  const asPrivate = () => [{ address: '192.168.1.20', family: 4 }];
  const asPublic = () => [{ address: '93.184.216.34', family: 4 }];
  assert.equal((await mintTransportOk('http://nas.example.test:8096', { lookup: asPrivate })).ok, true, 'private http ok');
  assert.equal((await mintTransportOk('http://192.168.1.20:8096')).ok, true, 'literal private ip http ok');
  assert.equal((await mintTransportOk('http://127.0.0.1:8096')).ok, true, 'loopback http ok');
  assert.equal((await mintTransportOk('https://public.example.test:8096', { lookup: asPublic })).ok, true, 'public https ok');
  const refusedPublic = await mintTransportOk('http://public.example.test:8096', { lookup: asPublic });
  assert.equal(refusedPublic.ok, false, 'public http refused');
  assert.match(refusedPublic.reason, /plain HTTP/);
  assert.equal((await mintTransportOk('ftp://x/y')).ok, false, 'non-http(s) refused');
  assert.equal((await mintTransportOk('not a url')).ok, false, 'garbage refused');
});

test('a missing base or missing credential refuses before any request', async () => {
  assert.equal((await mintKey('jellyfin', '', { username: 'a', password: 'b' })).ok, false);
  assert.equal((await mintKey('jellyfin', 'http://h', { username: '', password: 'b' })).ok, false);
  assert.equal((await mintKey('jellyfin', 'http://h', { username: 'a', password: '' })).ok, false);
});

test('Jellyfin returns the key without returning the password', async () => {
  const seen = [];
  await withStub((req, res, body) => {
    seen.push(body);
    if (req.url.includes('AuthenticateByName')) return jsonRes(res, 200, { AccessToken: 'admin-session-token' });
    if (req.method === 'POST' && req.url.includes('/Auth/Keys')) { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && req.url.includes('/Auth/Keys')) {
      return jsonRes(res, 200, { Items: [
        { AppName: 'Quartermaster', AccessToken: 'MINTED-KEY-XYZ', DateCreated: '2026-01-01' },
        { AppName: 'Other', AccessToken: 'not-ours', DateCreated: '2026-02-01' },
      ] });
    }
    res.writeHead(404); res.end();
  }, async (base) => {
    const r = await mintKey('jellyfin', base, { username: 'admin', password: SENTINEL });
    assert.equal(r.ok, true);
    assert.equal(r.apiKey, 'MINTED-KEY-XYZ');
    assert.ok(!JSON.stringify(r).includes(SENTINEL));
  });
});

test('portainer chains auth then token', async () => {
  await withStub((req, res) => {
    if (req.url === '/api/auth') return jsonRes(res, 200, { jwt: 'jwt-abc' });
    if (req.url === '/api/users/me') return jsonRes(res, 200, { Id: 3 });
    if (req.url === '/api/users/3/tokens') return jsonRes(res, 200, { rawAPIKey: 'ptr_minted' });
    res.writeHead(404); res.end();
  }, async (base) => {
    const r = await mintKey('portainer', base, { username: 'admin', password: SENTINEL });
    assert.equal(r.apiKey, 'ptr_minted');
  });
});

test('proxmox assembles the full token triple', async () => {
  await withStub((req, res) => {
    if (req.url.includes('/access/ticket')) return jsonRes(res, 200, { data: { ticket: 'T', CSRFPreventionToken: 'C' } });
    if (req.url.includes('/token/quartermaster')) return jsonRes(res, 200, { data: { value: 'uuid-secret' } });
    res.writeHead(404); res.end();
  }, async (base) => {
    const r = await mintKey('proxmox', base, { username: 'root@pam', password: SENTINEL });
    assert.equal(r.apiKey, 'root@pam!quartermaster=uuid-secret');
  });
});

test('401 responses do not include the password', async () => {
  for (const kind of ['jellyfin', 'portainer', 'immich', 'truenas', 'komga', 'qui', 'arcane', 'technitium', 'proxmox', 'emby']) {
    const r = await withStub((req, res) => { res.writeHead(401); res.end('unauthorized'); }, async (base) =>
      mintKey(kind, base, { username: 'admin', password: SENTINEL }));
    assert.equal(r.ok, false, `${kind} should fail on 401`);
    assert.match(r.reason, /refused the sign-in|did not return a key|did not answer/i);
    assert.ok(!JSON.stringify(r).includes(SENTINEL), `${kind} must not echo the password on failure`);
  }
});

test('redirects are rejected', async () => {
  let secondHit = false;
  const r = await withStub((req, res) => {
    if (req.url.includes('AuthenticateByName')) { res.writeHead(302, { location: 'http://127.0.0.1:1/evil' }); return res.end(); }
    secondHit = true; res.writeHead(200); res.end('{}');
  }, async (base) => mintKey('jellyfin', base, { username: 'a', password: 'b' }));
  assert.equal(r.ok, false);
  assert.equal(secondHit, false);
});

test('an oversized response body is capped', async () => {
  const res = await mintRequest('GET', 'http://127.0.0.1:1/x', {
    maxBodyBytes: 10,
    request: (opts, cb) => {
      const fake = { statusCode: 200, headers: {}, destroyed: false, destroy() { this.destroyed = true; }, on(ev, fn) { this['_' + ev] = fn; return this; } };
      queueMicrotask(() => { cb(fake); fake._data(Buffer.alloc(11)); });
      return { on() { return this; }, end() {}, write() {}, destroy() {}, destroyed: false };
    },
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  assert.equal(res, null);
});

test('public HTTPS uses certificate verification', async () => {
  let capturedRejectUnauthorized;
  await mintRequest('GET', 'https://example.com/x', {
    request: (opts, cb) => {
      capturedRejectUnauthorized = opts.rejectUnauthorized;
      return { on() { return this; }, end() {}, write() {}, destroy() {}, destroyed: false };
    },
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 60,
  });
  assert.equal(capturedRejectUnauthorized, true, 'public host must verify TLS');
});

test('a private https host relaxes verification for the self-signed LAN case', async () => {
  let capturedRejectUnauthorized;
  await mintRequest('GET', 'https://nas.local/x', {
    request: (opts, cb) => {
      capturedRejectUnauthorized = opts.rejectUnauthorized;
      return { on() { return this; }, end() {}, write() {}, destroy() {}, destroyed: false };
    },
    lookup: async () => [{ address: '192.168.1.10', family: 4 }],
    timeoutMs: 60,
  });
  assert.equal(capturedRejectUnauthorized, false);
});

test('method and scheme are constrained', async () => {
  assert.equal(await mintRequest('DELETE', 'http://127.0.0.1/x', {}), null);
  assert.equal(await mintRequest('GET', 'ftp://127.0.0.1/x', {}), null);
  assert.equal(await mintRequest('GET', 'http://user:pass@127.0.0.1/x', {}), null);
});
