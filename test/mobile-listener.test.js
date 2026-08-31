import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { createServer as createTcpServer } from 'node:net';


process.env.SECRET_KEY = 'ef'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-listener-'));
process.env.QM_HOST = 'nas.local';

const { parseAdvertisedOrigin, mobileListenerPlan } = await import('../src/mobile/config.js');
const { startMobileListener, leafFingerprint, mobileListenerStatus, resetMobileListenerStatus } = await import('../src/mobile/listener.js');
const { buildSelfSignedCertificate, tlsPaths } = await import('../src/mobile/cert.js').then(async (cert) => ({ ...cert, ...(await import('../src/mobile/x509.js')) }));

const paths = tlsPaths(process.env.DATA_DIR);

async function freePort() {
  const probe = createTcpServer();
  return new Promise((resolve) => probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }));
}

async function arm(port) {
  process.env.MOBILE_API_ENABLED = 'true';
  process.env.MOBILE_ENROLMENT_ENABLED = 'true';
  process.env.MOBILE_PORT = String(port);
  process.env.QM_ADVERTISED_ORIGIN = `https://127.0.0.1:${port}`;
  process.env.MOBILE_BIND_ADDRESS = '127.0.0.1';
  resetMobileListenerStatus();
}

async function stop(started) {
  started.server.closeAllConnections();
  await new Promise((resolve) => started.server.close(resolve));
}

function resetTls() {
  rmSync(paths.dir, { recursive: true, force: true });
}

test('parses an exact HTTPS advertised origin', () => {
  assert.equal(parseAdvertisedOrigin('https://nas.local:8788').ok, true);
  assert.equal(parseAdvertisedOrigin('https://192.168.1.10:8788').ok, true);
  assert.deepEqual(parseAdvertisedOrigin('https://nas.local:443'), { ok: true, origin: 'https://nas.local:443', host: 'nas.local', port: 443 });
  assert.equal(parseAdvertisedOrigin('https://[::1]:443').ok, true);
  for (const bad of [undefined, '', 'http://nas.local:8788', 'https://nas.local', 'https://NAS.local:8788', 'https://nas.local:8788/', 'https://u@nas.local:8788', 'https://0.0.0.0:99999', 'nas.local:8788']) {
    assert.equal(parseAdvertisedOrigin(bad).ok, false, String(bad));
  }
});

test('requires the parent flag, a valid origin, and a matching port', async () => {
  assert.match(mobileListenerPlan({}).reason, /MOBILE_API_ENABLED/);
  process.env.MOBILE_API_ENABLED = 'true';
  assert.match(mobileListenerPlan({ MOBILE_API_ENABLED: 'true' }).reason, /QM_ADVERTISED_ORIGIN is not set/);
  assert.match(mobileListenerPlan({ QM_ADVERTISED_ORIGIN: 'https://nas.local:8788', MOBILE_PORT: '9000' }).reason, /does not match/);
  assert.equal(mobileListenerPlan({ QM_ADVERTISED_ORIGIN: 'https://nas.local:8788' }).ok, true);
  const lines = [];
  delete process.env.MOBILE_API_ENABLED;
  assert.equal(await startMobileListener({ log: (l) => lines.push(l) }), null);
  assert.match(lines.join(''), /mobile api: off \(MOBILE_API_ENABLED/);
  assert.equal(mobileListenerStatus().ok, false);
});

test('first start generates TLS material and restart preserves it', async () => {
  resetTls();
  const port = await freePort();
  await arm(port);
  const lines = [];
  const started = await startMobileListener({ log: (l) => lines.push(l) });
  assert.ok(started, lines.join(''));
  try {
    assert.match(lines.join(''), /generated a self-signed certificate for 127\.0\.0\.1/);
    assert.doesNotMatch(lines.join(''), /PRIVATE KEY/);
    const certPem = readFileSync(paths.certPath);
    assert.equal(new X509Certificate(certPem).subjectAltName, 'IP Address:127.0.0.1');
    assert.equal(started.tlsLeafFingerprint, createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex'));
    assert.equal(leafFingerprint(certPem), started.tlsLeafFingerprint);
    assert.equal(started.tls.source, 'generated');
    const status = mobileListenerStatus();
    assert.equal(status.ok, true);
    assert.equal(status.tls.fingerprint, started.tlsLeafFingerprint);
    assert.equal(status.tls.certificateHost, '127.0.0.1');
    const result = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/mobile/v1/identity?challenge=bad', method: 'GET', rejectUnauthorized: false, minVersion: 'TLSv1.2', agent: false }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data, leaf: res.socket.getPeerCertificate().fingerprint256, protocol: res.socket.getProtocol() }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.body).error.code, 'invalid_challenge');
    assert.equal(result.leaf.replace(/:/g, '').toLowerCase(), started.tlsLeafFingerprint);
    assert.ok(['TLSv1.2', 'TLSv1.3'].includes(result.protocol));
    assert.match(lines.join(''), /pairing on/);
    assert.match(lines.join(''), /tls generated leaf/);
  } finally {
    await stop(started);
  }
  const again = [];
  resetMobileListenerStatus();
  const restarted = await startMobileListener({ log: (l) => again.push(l) });
  assert.ok(restarted, again.join(''));
  try {
    assert.equal(restarted.tlsLeafFingerprint, started.tlsLeafFingerprint);
    assert.doesNotMatch(again.join(''), /generated a self-signed/);
  } finally {
    await stop(restarted);
  }
});

test('rejects a changed advertised host with rotation guidance', async () => {
  const port = await freePort();
  await arm(port);
  process.env.QM_ADVERTISED_ORIGIN = `https://localhost:${port}`;
  const lines = [];
  assert.equal(await startMobileListener({ log: (l) => lines.push(l) }), null);
  assert.match(lines.join(''), /mobile api: off \(the advertised origin changed/);
  const status = mobileListenerStatus();
  assert.equal(status.ok, false);
  assert.equal(status.tlsCode, 'host_changed');
  assert.match(status.reason, /rotate-cert\.js --confirm/);
});

test('owner-supplied material is used as found', async () => {
  resetTls();
  mkdirSync(paths.dir, { recursive: true });
  const own = buildSelfSignedCertificate({ host: '127.0.0.1' });
  writeFileSync(paths.certPath, own.certPem);
  writeFileSync(paths.keyPath, own.keyPem);
  const port = await freePort();
  await arm(port);
  const lines = [];
  const started = await startMobileListener({ log: (l) => lines.push(l) });
  assert.ok(started, lines.join(''));
  try {
    assert.equal(started.tls.source, 'owner');
    assert.equal(started.tlsLeafFingerprint, leafFingerprint(own.certPem));
    assert.match(lines.join(''), /tls owner leaf/);
  } finally {
    await stop(started);
  }
});

async function expectOff(pattern, tlsCode) {
  const lines = [];
  const started = await startMobileListener({ log: (l) => lines.push(l) });
  assert.equal(started, null, lines.join(''));
  const joined = lines.join('');
  assert.match(joined, /^  mobile api: off \(/m);
  assert.match(joined, pattern);
  assert.doesNotMatch(joined, /PRIVATE KEY|BEGIN/);
  const status = mobileListenerStatus();
  assert.equal(status.ok, false);
  assert.match(status.reason, pattern);
  if (tlsCode) assert.equal(status.tlsCode, tlsCode);
}

test('contains a malformed certificate error', async () => {
  resetTls();
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.certPath, '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----\n');
  writeFileSync(paths.keyPath, buildSelfSignedCertificate({ host: '127.0.0.1' }).keyPem);
  await arm(await freePort());
  await expectOff(/mobile\.crt is not a readable X\.509 certificate/, 'invalid');
});

test('contains a mismatched key error', async () => {
  resetTls();
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.certPath, buildSelfSignedCertificate({ host: '127.0.0.1' }).certPem);
  writeFileSync(paths.keyPath, buildSelfSignedCertificate({ host: '127.0.0.1' }).keyPem);
  await arm(await freePort());
  await expectOff(/mobile\.key does not match mobile\.crt/, 'invalid');
});

test('contains an unreadable key error', { skip: process.getuid && process.getuid() === 0 && 'root reads everything' }, async () => {
  resetTls();
  mkdirSync(paths.dir, { recursive: true });
  const own = buildSelfSignedCertificate({ host: '127.0.0.1' });
  writeFileSync(paths.certPath, own.certPem);
  writeFileSync(paths.keyPath, own.keyPem, { mode: 0o000 });
  await arm(await freePort());
  try {
    await expectOff(/TLS material unreadable .*EACCES/, 'unreadable');
  } finally {
    chmodSync(paths.keyPath, 0o600);
  }
});

test('contains certificate generation failure in a read-only directory', { skip: process.getuid && process.getuid() === 0 && 'root writes everywhere' }, async () => {
  resetTls();
  chmodSync(process.env.DATA_DIR, 0o500);
  await arm(await freePort());
  try {
    await expectOff(/could not generate a certificate .*(EACCES|EPERM|EROFS)/, 'generate');
  } finally {
    chmodSync(process.env.DATA_DIR, 0o700);
  }
});

test('listener bind failures resolve null without stopping the caller', async () => {
  resetTls();
  const blocker = createTcpServer();
  const port = await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));
  await arm(port);
  try {
    await expectOff(new RegExp(`the listener on 127\\.0\\.0\\.1:${port} failed \\(EADDRINUSE\\)`));
  } finally {
    blocker.close();
  }
  if (process.getuid && process.getuid() !== 0) {
    await arm(1);
    await expectOff(/the listener on 127\.0\.0\.1:1 failed \(EACCES\)/);
  }
});

test('contains and reports an asynchronous listener error', async () => {
  resetTls();
  const port = await freePort();
  await arm(port);
  const lines = [];
  const started = await startMobileListener({ log: (l) => lines.push(l) });
  assert.ok(started, lines.join(''));
  assert.equal(mobileListenerStatus().ok, true);
  const fault = new Error('boom');
  fault.code = 'EFAULT';
  started.server.emit('error', fault);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(lines.join(''), /mobile api: off \(the listener on 127\.0\.0\.1:\d+ failed \(EFAULT\)\)/);
  assert.equal(mobileListenerStatus().ok, false);
  assert.equal(started.server.listening, false);
});
