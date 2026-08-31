import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const ROOT = join(import.meta.dirname, '..');
const SECRET_KEY = 'd4'.repeat(32);
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-origin-bind-'));
  roots.push(root);
  return root;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}


function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, body) {
  const content = Buffer.isBuffer(body) ? body : Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}
const seq = (...parts) => tlv(0x30, parts);
const setOf = (...parts) => tlv(0x31, parts);
const octet = (body) => tlv(0x04, body);
const explicit = (n, body) => tlv(0xa0 | n, body);
function integer(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0 && (bytes[i + 1] & 0x80) === 0) i += 1;
  const trimmed = bytes.subarray(i);
  return tlv(0x02, trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}
function oid(text) {
  const arcs = text.split('.').map(Number);
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [];
    let v = arc;
    do { chunk.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let j = 0; j < chunk.length - 1; j += 1) chunk[j] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const bitString = (body, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), body]));
function utcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}
const commonName = (text) => seq(setOf(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(text, 'utf8')))));
const extension = (id, critical, body) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octet(body));

const { generalName } = await import('../src/mobile/x509.js');

function buildMultiSanCertificate(hosts) {
  const names = hosts.map((host) => generalName(host));
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + 200 * 24 * 60 * 60 * 1000);
  const algorithm = seq(oid('1.2.840.10045.4.3.2'));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    commonName(names[0].host),
    seq(utcTime(notBefore), utcTime(notAfter)),
    commonName(names[0].host),
    spki,
    explicit(3, seq(
      extension('2.5.29.19', true, seq()),
      extension('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)),
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', false, seq(...names.map((n) => n.der))),
      extension('2.5.29.14', false, octet(keyId)),
    )),
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, algorithm, bitString(signature));
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}


const DRIVER = `
const mode = process.env.DRIVER_MODE;
const grantFile = process.env.GRANT_FILE;
const { writeFileSync, readFileSync } = await import('node:fs');
const { request } = await import('node:https');
const { randomBytes, generateKeyPairSync } = await import('node:crypto');
const { startMobileListener } = await import('./src/mobile/listener.js');
const lines = [];
const started = await startMobileListener({ log: (l) => lines.push(l) });
if (!started) {
  console.log(JSON.stringify({ started: false, log: lines.join('') }));
  process.exit(0);
}
const port = Number(process.env.MOBILE_PORT);
function call(path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const options = {
      host: '127.0.0.1', port, path, method, rejectUnauthorized: false, agent: false, minVersion: 'TLSv1.2',
      headers: Object.assign({}, payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}, headers || {}),
    };
    const req = request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const out = { started: true, leaf: started.tlsLeafFingerprint, origin: started.origin, source: started.tls.source, log: lines.join('') };
try {
  if (mode === 'pair') {
    const owner = await import('./src/mobile/enrolment-owner.js');
    const pairing = await import('./src/mobile/enrolment.js');
    const protocol = await import('./src/mobile/protocol.js');
    const created = owner.createEnrolment();
    const pair = generateKeyPairSync('x25519');
    const pub = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
    const priv = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    const claimed = await call('/api/mobile/v1/enrolments/claim', 'POST', {
      v: 1,
      pairingKey: created.pairingKey,
      claimEncryptionPublicKey: pub,
      clientNonce: randomBytes(16).toString('base64url'),
      deviceName: process.env.DEVICE_NAME,
      requestedScopes: ['summary.read'],
      candidateOrigin: started.origin,
    }, null);
    out.claim = claimed.status;
    const approved = await pairing.approveEnrolment(created.enrolmentId);
    out.approved = approved.ok === true;
    const grant = await call('/api/mobile/v1/enrolments/grant', 'POST', { v: 1, enrolmentId: created.enrolmentId }, null);
    out.grant = grant.status;
    const tBytes = Buffer.from(claimed.body.transcript, 'base64url');
    out.transcriptOrigin = JSON.parse(tBytes.toString('utf8')).origin;
    out.transcriptLeaf = JSON.parse(tBytes.toString('utf8')).tlsLeafFingerprint;
    const plain = await protocol.openGrant(priv, grant.body.envelope, protocol.transcriptHash(tBytes));
    const wrapper = JSON.parse(plain.toString('utf8'));
    const ack = await call('/api/mobile/v1/enrolments/acknowledge', 'POST', { v: 1, enrolmentId: created.enrolmentId, ackSecret: wrapper.grant.ackSecret }, null);
    out.ack = ack.status;
    writeFileSync(grantFile, JSON.stringify({ accessToken: wrapper.grant.accessToken, refreshGrant: wrapper.grant.refreshGrant }), { mode: 0o600 });
  }
  const held = JSON.parse(readFileSync(grantFile, 'utf8'));
  const meta = await call('/api/mobile/v1/meta', 'GET', null, { authorization: 'Bearer ' + held.accessToken });
  out.meta = { status: meta.status, code: meta.body && meta.body.error ? meta.body.error.code : null, message: meta.body && meta.body.error ? meta.body.error.message : null, origin: meta.body ? meta.body.origin : null };
  const refresh = await call('/api/mobile/v1/token/refresh', 'POST', { v: 1, refreshGrant: held.refreshGrant, rotationRequestId: randomBytes(16).toString('base64url') }, null);
  out.refresh = { status: refresh.status, code: refresh.body && refresh.body.error ? refresh.body.error.code : null };
  if (refresh.status === 200) {
    writeFileSync(grantFile, JSON.stringify({ accessToken: refresh.body.accessToken, refreshGrant: refresh.body.refreshGrant }), { mode: 0o600 });
  }
} catch (error) {
  out.error = String(error && error.message);
}
started.server.closeAllConnections();
await new Promise((resolve) => started.server.close(resolve));
console.log(JSON.stringify(out));
`;

function childEnv(dataDir, extra) {
  const env = {
    ...process.env,
    SECRET_KEY,
    DATA_DIR: dataDir,
    QM_HOST: '127.0.0.1',
    MOBILE_API_ENABLED: 'true',
    MOBILE_ENROLMENT_ENABLED: 'true',
    MOBILE_BIND_ADDRESS: '127.0.0.1',
    DEVICE_NAME: 'Test iPhone',
    ...extra,
  };
  delete env.QM_CLONE_AS_NEW;
  return env;
}

function drive(dataDir, { mode, origin, port, grantFile, deviceName }) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', DRIVER], {
    cwd: ROOT,
    env: childEnv(dataDir, { DRIVER_MODE: mode, QM_ADVERTISED_ORIGIN: origin, MOBILE_PORT: String(port), GRANT_FILE: grantFile, ...(deviceName ? { DEVICE_NAME: deviceName } : {}) }),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return JSON.parse(run.stdout.trim().split('\n').pop());
}

function rotate(dataDir, origin, args = ['--confirm']) {
  return spawnSync(process.execPath, ['src/mobile/rotate-cert.js', ...args], {
    cwd: ROOT,
    env: childEnv(dataDir, { QM_ADVERTISED_ORIGIN: origin, MOBILE_PORT: '8788' }),
    encoding: 'utf8',
  });
}

const sidecarOf = (dataDir) => join(dataDir, 'qm-mobile-v1.json');
const epochOf = (dataDir) => join(dataDir, 'qm-mobile-epoch-v1.json');
const bindingOf = (dataDir) => join(dataDir, 'mobile-origin.json');

function noSecrets(text, label) {
  assert.doesNotMatch(text, /qmd_|qmr_|qmp_|PRIVATE KEY/, label);
}

test('rejects an old grant after an origin port change', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  const portOne = await freePort();
  const originOne = `https://127.0.0.1:${portOne}`;

  const paired = drive(dataDir, { mode: 'pair', origin: originOne, port: portOne, grantFile });
  assert.equal(paired.started, true, paired.log);
  assert.equal(paired.source, 'generated');
  assert.equal(paired.claim, 200);
  assert.equal(paired.ack, 200);
  assert.equal(paired.transcriptOrigin, originOne, 'the phone signed the exact origin, port included');
  assert.equal(paired.meta.status, 200, 'baseline: the grant works where it was minted');
  assert.equal(paired.refresh.status, 200, 'baseline: and it can rotate there');

  const portTwo = await freePort();
  const originTwo = `https://127.0.0.1:${portTwo}`;
  const certBefore = readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8');
  const refused = drive(dataDir, { mode: 'use', origin: originTwo, port: portTwo, grantFile });
  assert.equal(refused.started, false);
  assert.match(refused.log, /mobile api: off \(the advertised origin changed/);
  assert.ok(refused.log.includes(originOne) && refused.log.includes(originTwo), refused.log);
  assert.match(refused.log, /1 paired device family is bound/);
  assert.match(refused.log, /rotate-cert\.js --confirm/);
  assert.match(refused.log, /revokes every paired device/, 'and what approving it costs');
  noSecrets(refused.log, 'the refusal');
  assert.equal(readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8'), certBefore, 'no silent rotation');
  assert.equal(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).origin, originOne);

  const dry = rotate(dataDir, originTwo, []);
  assert.equal(dry.status, 2);
  assert.equal(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).origin, originOne);
  assert.equal(drive(dataDir, { mode: 'use', origin: originTwo, port: portTwo, grantFile }).started, false);

  const beforeApproval = readFileSync(sidecarOf(dataDir));
  const run = rotate(dataDir, originTwo);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Rotated the mobile certificate for 127\.0\.0\.1\./);
  assert.ok(run.stdout.includes(`Bound the advertised origin to ${originTwo}.`), run.stdout);
  assert.ok(run.stdout.includes(`It was ${originOne}`), run.stdout);
  assert.match(run.stdout, /Revoked 1 of 1 paired device families/);
  assert.match(run.stdout, /re-pair every phone/);
  noSecrets(run.stdout, 'the approval');

  const after = drive(dataDir, { mode: 'use', origin: originTwo, port: portTwo, grantFile });
  assert.equal(after.started, true, after.log);
  assert.equal(after.meta.status, 401);
  assert.ok(['revoked', 'repair_required'].includes(after.meta.code), after.meta.code);
  assert.equal(after.refresh.status, 401, 'and it cannot refresh its way back in');
  assert.ok(['revoked', 'repair_required'].includes(after.refresh.code), after.refresh.code);

  writeFileSync(sidecarOf(dataDir), beforeApproval);
  const rolledBack = drive(dataDir, { mode: 'use', origin: originTwo, port: portTwo, grantFile });
  assert.equal(rolledBack.started, false, rolledBack.log);
  assert.match(rolledBack.log, /older than this installation's authority record/);
  assert.match(rolledBack.log, /recorded as revoked but the sidecar presents it as live/);
  noSecrets(rolledBack.log, 'the rollback refusal');

  rmSync(epochOf(dataDir), { force: true });
  const netted = drive(dataDir, { mode: 'use', origin: originTwo, port: portTwo, grantFile });
  assert.equal(netted.started, true, netted.log);
  assert.equal(netted.meta.status, 401);
  assert.equal(netted.meta.code, 'repair_required');
  assert.equal(netted.refresh.status, 401);
  assert.equal(netted.refresh.code, 'repair_required');
  noSecrets(JSON.stringify(netted), 'the refusal body');
});

test('multi-SAN owner certificate does not approve an origin change', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  const port = await freePort();
  const originOne = `https://127.0.0.1:${port}`;
  const originTwo = `https://localhost:${port}`;

  const own = buildMultiSanCertificate(['127.0.0.1', 'localhost']);
  mkdirSync(join(dataDir, 'tls'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'tls', 'mobile.crt'), own.certPem);
  writeFileSync(join(dataDir, 'tls', 'mobile.key'), own.keyPem, { mode: 0o600 });

  const paired = drive(dataDir, { mode: 'pair', origin: originOne, port, grantFile });
  assert.equal(paired.started, true, paired.log);
  assert.equal(paired.source, 'owner');
  assert.equal(paired.transcriptOrigin, originOne);
  assert.equal(paired.meta.status, 200);
  assert.equal(paired.refresh.status, 200);
  const pairedLeaf = paired.leaf;

  const moved = drive(dataDir, { mode: 'use', origin: originTwo, port, grantFile });
  assert.equal(moved.started, false, 'covering the new host in a SAN is not approval');
  assert.match(moved.log, /mobile api: off \(the advertised origin changed/);
  assert.ok(moved.log.includes(originOne) && moved.log.includes(originTwo), moved.log);
  assert.match(moved.log, /owner-supplied material is left exactly as found/, 'the message states what remains untouched');
  noSecrets(moved.log, 'the refusal');
  assert.equal(readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8'), own.certPem);

  const beforeApproval = readFileSync(sidecarOf(dataDir));
  const run = rotate(dataDir, originTwo);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(run.stdout.includes(`The advertised origin changed from ${originOne} to ${originTwo}.`), run.stdout);
  assert.match(run.stdout, /owner-supplied, so it is left exactly as found/);
  assert.match(run.stdout, /never regenerates owner material/);
  assert.doesNotMatch(run.stdout, /Rotated the mobile certificate|New fingerprint/);
  assert.ok(run.stdout.includes(`Bound the advertised origin to ${originTwo}.`), run.stdout);
  assert.match(run.stdout, /Revoked 1 of 1 paired device families/);
  noSecrets(run.stdout, 'the approval');
  assert.equal(readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8'), own.certPem);
  assert.equal(readFileSync(join(dataDir, 'tls', 'mobile.key'), 'utf8'), own.keyPem);
  assert.equal(existsSync(join(dataDir, 'tls', 'mobile.json')), false);

  const after = drive(dataDir, { mode: 'use', origin: originTwo, port, grantFile });
  assert.equal(after.started, true, after.log);
  assert.equal(after.leaf, pairedLeaf);
  assert.equal(after.meta.status, 401);
  assert.equal(after.refresh.status, 401);

  writeFileSync(sidecarOf(dataDir), beforeApproval);
  const rolledBack = drive(dataDir, { mode: 'use', origin: originTwo, port, grantFile });
  assert.equal(rolledBack.started, false, rolledBack.log);
  assert.match(rolledBack.log, /older than this installation's authority record/);
  noSecrets(rolledBack.log, 'the rollback refusal');

  rmSync(epochOf(dataDir), { force: true });
  const netted = drive(dataDir, { mode: 'use', origin: originTwo, port, grantFile });
  assert.equal(netted.started, true, netted.log);
  assert.equal(netted.leaf, pairedLeaf);
  assert.equal(netted.meta.status, 401, 'access');
  assert.equal(netted.meta.code, 'repair_required');
  assert.match(netted.meta.message, /paired to a different address for this server/);
  assert.match(netted.meta.message, /Pair the device again from the Devices page/);
  assert.doesNotMatch(netted.meta.message, /localhost|127\.0\.0\.1/);
  assert.equal(netted.refresh.status, 401, 'refresh');
  assert.equal(netted.refresh.code, 'repair_required');
  noSecrets(JSON.stringify(netted), 'the refusal body');

  const rePaired = drive(dataDir, { mode: 'pair', origin: originTwo, port, grantFile: join(tempDir(), 'held.json'), deviceName: 'Test iPhone again' });
  assert.equal(rePaired.started, true, rePaired.log);
  assert.equal(rePaired.transcriptOrigin, originTwo);
  assert.equal(rePaired.meta.status, 200);
  assert.equal(rePaired.meta.origin, originTwo);
  assert.equal(rePaired.refresh.status, 200);
});

test('origin change with no paired devices is adopted', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  writeFileSync(grantFile, JSON.stringify({ accessToken: 'qmd_' + 'A'.repeat(43), refreshGrant: 'qmr_' + 'A'.repeat(43) }));
  const portOne = await freePort();
  const first = drive(dataDir, { mode: 'use', origin: `https://127.0.0.1:${portOne}`, port: portOne, grantFile });
  assert.equal(first.started, true, first.log);
  assert.equal(first.meta.status, 401);
  assert.equal(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).origin, `https://127.0.0.1:${portOne}`);

  const portTwo = await freePort();
  const second = drive(dataDir, { mode: 'use', origin: `https://127.0.0.1:${portTwo}`, port: portTwo, grantFile });
  assert.equal(second.started, true, second.log);
  assert.equal(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).origin, `https://127.0.0.1:${portTwo}`, 'the new origin is simply adopted');
  assert.equal(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).boundAt, 0);
});

test('revocation write failure leaves TLS material unchanged', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  const port = await freePort();
  const own = buildMultiSanCertificate(['127.0.0.1', 'localhost']);
  mkdirSync(join(dataDir, 'tls'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'tls', 'mobile.crt'), own.certPem);
  writeFileSync(join(dataDir, 'tls', 'mobile.key'), own.keyPem, { mode: 0o600 });
  assert.equal(drive(dataDir, { mode: 'pair', origin: `https://127.0.0.1:${port}`, port, grantFile }).ack, 200);

  const envelope = JSON.parse(readFileSync(sidecarOf(dataDir), 'utf8'));
  const flipped = envelope.mac[0] === '0' ? '1' : '0';
  writeFileSync(sidecarOf(dataDir), JSON.stringify({ ...envelope, mac: `${flipped}${envelope.mac.slice(1)}` }));

  const run = rotate(dataDir, `https://localhost:${port}`);
  assert.equal(run.status, 1, 'a half done approval is not a success');
  assert.match(run.stdout, /The advertised origin was updated, but paired-device revocation failed/);
  assert.doesNotMatch(run.stdout, /The certificate was replaced/);
  assert.match(run.stdout, /approved origin changed/);
  assert.match(run.stdout, /Devices page/);
  noSecrets(run.stdout, 'the half done approval');
  assert.doesNotMatch(run.stdout, new RegExp(envelope.mac), 'no state content reaches the output');
  assert.equal(readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8'), own.certPem);
  assert.equal(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).origin, `https://localhost:${port}`);
  assert.ok(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).boundAt > 0);
});

test('certificate changes do not bypass origin approval for existing families', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  const port = await freePort();
  const originOne = `https://127.0.0.1:${port}`;
  const originTwo = `https://localhost:${port}`;
  const tls = join(dataDir, 'tls');
  const first = buildMultiSanCertificate(['127.0.0.1', 'localhost']);
  const second = buildMultiSanCertificate(['127.0.0.1', 'localhost']);
  const install = (own) => {
    mkdirSync(tls, { recursive: true, mode: 0o700 });
    writeFileSync(join(tls, 'mobile.crt'), own.certPem);
    writeFileSync(join(tls, 'mobile.key'), own.keyPem, { mode: 0o600 });
  };

  install(first);
  const paired = drive(dataDir, { mode: 'pair', origin: originOne, port, grantFile });
  assert.equal(paired.started, true, paired.log);
  assert.equal(paired.source, 'owner');
  assert.equal(paired.ack, 200);
  assert.equal(paired.meta.status, 200, 'baseline: the grant works where it was minted');
  assert.equal(paired.refresh.status, 200);

  install(second);
  const moved = drive(dataDir, { mode: 'use', origin: originTwo, port, grantFile });
  assert.equal(moved.started, true, moved.log);
  assert.notEqual(moved.leaf, paired.leaf);
  assert.equal(moved.meta.status, 401);
  assert.equal(moved.refresh.status, 401);
  const binding = JSON.parse(readFileSync(bindingOf(dataDir), 'utf8'));
  assert.equal(binding.origin, originTwo, 'the new origin is adopted');
  assert.equal(binding.approved, false);
  assert.ok(binding.boundAt > 0);

  install(first);
  const restored = drive(dataDir, { mode: 'use', origin: originTwo, port, grantFile });
  assert.equal(restored.started, true, restored.log);
  assert.equal(restored.leaf, paired.leaf);
  assert.equal(restored.meta.status, 401);
  assert.equal(restored.meta.code, 'repair_required');
  assert.match(restored.meta.message, /paired to a different address for this server/);
  assert.doesNotMatch(restored.meta.message, /approval/);
  assert.doesNotMatch(restored.meta.message, /localhost|127\.0\.0\.1/);
  assert.equal(restored.refresh.status, 401, 'on the refresh path too');
  assert.equal(restored.refresh.code, 'repair_required');
  noSecrets(JSON.stringify(restored), 'the refusal body');

  const rePaired = drive(dataDir, { mode: 'pair', origin: originTwo, port, grantFile: join(tempDir(), 'held.json'), deviceName: 'Test iPhone again' });
  assert.equal(rePaired.started, true, rePaired.log);
  assert.equal(rePaired.meta.status, 200);
  assert.equal(rePaired.refresh.status, 200);
});

function interruptGeneration(dataDir, host) {
  const source = `
    const { __setCertificateFault, rotateMobileCertificate } = await import('./src/mobile/cert.js');
    __setCertificateFault('install-record');
    console.log(JSON.stringify(rotateMobileCertificate({ dataDir: process.env.DATA_DIR, host: process.env.CERT_HOST })));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: ROOT,
    env: childEnv(dataDir, { CERT_HOST: host }),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(JSON.parse(run.stdout.trim()).ok, false);
}

test('rotate-cert settles interrupted generation before applying --confirm', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  const portOne = await freePort();
  const portTwo = await freePort();
  const originOne = `https://127.0.0.1:${portOne}`;
  const originTwo = `https://127.0.0.1:${portTwo}`;

  const paired = drive(dataDir, { mode: 'pair', origin: originOne, port: portOne, grantFile });
  assert.equal(paired.started, true, paired.log);
  assert.equal(paired.source, 'generated');
  assert.equal(paired.ack, 200);

  interruptGeneration(dataDir, '127.0.0.1');
  const certBefore = readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8');
  assert.equal(existsSync(join(dataDir, 'tls', 'pending', 'mobile.json')), true);
  assert.notEqual(JSON.parse(readFileSync(join(dataDir, 'tls', 'mobile.json'), 'utf8')).fingerprint, JSON.parse(readFileSync(join(dataDir, 'tls', 'pending', 'mobile.json'), 'utf8')).fingerprint);

  const run = rotate(dataDir, originTwo);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /owner-supplied/);
  assert.match(run.stdout, /Rotated the mobile certificate for 127\.0\.0\.1\./);
  assert.match(run.stdout, /New fingerprint:/);
  assert.ok(run.stdout.includes(`Bound the advertised origin to ${originTwo}.`), run.stdout);
  assert.match(run.stdout, /Revoked 1 of 1 paired device families/);
  noSecrets(run.stdout, 'the approval');
  assert.notEqual(readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8'), certBefore);
  assert.equal(existsSync(join(dataDir, 'tls', 'pending')), false);

  const after = drive(dataDir, { mode: 'use', origin: originTwo, port: portTwo, grantFile });
  assert.equal(after.started, true, after.log);
  assert.equal(after.source, 'generated');
  assert.equal(after.meta.status, 401, 'the grant minted before the rotation is dead');
  assert.equal(after.refresh.status, 401);
});

test('origin approval dry run reports its action without changing files', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  const port = await freePort();
  const originOne = `https://127.0.0.1:${port}`;
  const originTwo = `https://localhost:${port}`;
  const own = buildMultiSanCertificate(['127.0.0.1', 'localhost']);
  mkdirSync(join(dataDir, 'tls'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'tls', 'mobile.crt'), own.certPem);
  writeFileSync(join(dataDir, 'tls', 'mobile.key'), own.keyPem, { mode: 0o600 });
  assert.equal(drive(dataDir, { mode: 'pair', origin: originOne, port, grantFile }).ack, 200);

  const dry = rotate(dataDir, originTwo, []);
  assert.equal(dry.status, 2);
  assert.ok(dry.stdout.includes(`binds the advertised origin ${originTwo} in place of ${originOne}`), dry.stdout);
  assert.match(dry.stdout, /revokes every paired device/);
  assert.match(dry.stdout, /left exactly as found/);
  assert.doesNotMatch(dry.stdout, /This replaces the mobile listener certificate/, 'because that is not what this run does');
  assert.match(dry.stdout, /Re-run with --confirm to proceed\./);
  assert.equal(readFileSync(join(dataDir, 'tls', 'mobile.crt'), 'utf8'), own.certPem);
  assert.equal(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).origin, originOne);
  noSecrets(dry.stdout, 'the dry run');

  const plain = rotate(dataDir, originOne, []);
  assert.equal(plain.status, 2);
  assert.match(plain.stdout, /This replaces the mobile listener certificate and revokes every paired device/);
  assert.doesNotMatch(plain.stdout, /left exactly as found/);
});

test('deleting origin binding does not move paired devices', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  const portOne = await freePort();
  const originOne = `https://127.0.0.1:${portOne}`;

  const paired = drive(dataDir, { mode: 'pair', origin: originOne, port: portOne, grantFile });
  assert.equal(paired.started, true, paired.log);
  assert.equal(paired.meta.status, 200, 'baseline: the grant works where it was minted');
  assert.equal(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).origin, originOne);

  const portTwo = await freePort();
  const originTwo = `https://127.0.0.1:${portTwo}`;
  rmSync(bindingOf(dataDir), { force: true });

  const moved = drive(dataDir, { mode: 'use', origin: originTwo, port: portTwo, grantFile });
  assert.equal(moved.started, false, 'a deleted binding is not an absent one');
  assert.match(moved.log, /advertised origin binding/);
  assert.match(moved.log, /is missing, but 1 paired device family is still bound to its previous origin/);
  assert.match(moved.log, /1 paired device family is/);
  assert.match(moved.log, /rotate-cert\.js --confirm/, 'and the approved way to change the address');
  noSecrets(moved.log, 'the missing-binding refusal');

  const back = drive(dataDir, { mode: 'use', origin: originOne, port: portOne, grantFile });
  assert.equal(back.started, false);
  writeFileSync(bindingOf(dataDir), JSON.stringify({ version: 1, origin: originOne, fingerprint: paired.leaf ?? null, boundAt: 0, approved: false }, null, 2));
  const healed = drive(dataDir, { mode: 'use', origin: originOne, port: portOne, grantFile });
  assert.equal(healed.started, true, healed.log);
  assert.equal(healed.meta.status, 200);
});

test('unbound upgrades adopt the configured origin', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  const portOne = await freePort();
  const originOne = `https://127.0.0.1:${portOne}`;

  const paired = drive(dataDir, { mode: 'pair', origin: originOne, port: portOne, grantFile });
  assert.equal(paired.started, true, paired.log);

  rmSync(bindingOf(dataDir), { force: true });
  rmSync(epochOf(dataDir), { force: true });

  const adopted = drive(dataDir, { mode: 'use', origin: originOne, port: portOne, grantFile });
  assert.equal(adopted.started, true, adopted.log);
  assert.equal(adopted.meta.status, 200);
  assert.equal(JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).origin, originOne, 'and the origin is now recorded');
});

test('temporary sidecar removal does not allow origin changes', async () => {
  const dataDir = tempDir();
  const grantFile = join(tempDir(), 'held.json');
  const portOne = await freePort();
  const originOne = `https://127.0.0.1:${portOne}`;

  const paired = drive(dataDir, { mode: 'pair', origin: originOne, port: portOne, grantFile });
  assert.equal(paired.started, true, paired.log);
  assert.equal(paired.meta.status, 200, 'baseline: the grant works where it was minted');

  const portTwo = await freePort();
  const originTwo = `https://127.0.0.1:${portTwo}`;
  const stashed = readFileSync(sidecarOf(dataDir));
  rmSync(sidecarOf(dataDir), { force: true });

  const moved = drive(dataDir, { mode: 'use', origin: originTwo, port: portTwo, grantFile });
  assert.equal(moved.started, false);
  assert.match(moved.log, /advertised origin changed/);
  assert.match(moved.log, /device families that this installation has recorded are/);
  noSecrets(moved.log, 'the stashed-sidecar refusal');
  assert.equal(
    JSON.parse(readFileSync(bindingOf(dataDir), 'utf8')).origin,
    originOne,
  );

  writeFileSync(sidecarOf(dataDir), stashed);
  const back = drive(dataDir, { mode: 'use', origin: originOne, port: portOne, grantFile });
  assert.equal(back.started, true, back.log);
  assert.equal(back.meta.status, 200);
});
