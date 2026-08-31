import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { buildSelfSignedCertificate, generalName } from '../src/mobile/x509.js';
import { RESTART_COMMAND, ROTATE_COMMAND, certificateCoversHost, checkMaterial, ensureMobileCertificate, fingerprintOf, rotateMobileCertificate, tlsPaths } from '../src/mobile/cert.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'qm-cert-'));
const haveOpenssl = spawnSync('openssl', ['version']).status === 0;

test('builds a valid self-signed v3 leaf for DNS and IP hosts', () => {
  const cases = [['127.0.0.1', 'IP Address:127.0.0.1'], ['nas.local', 'DNS:nas.local'], ['[::1]', 'IP Address:0:0:0:0:0:0:0:1']];
  for (const [host, san] of cases) {
    const now = new Date('2026-08-21T12:00:00Z');
    const built = buildSelfSignedCertificate({ host, days: 825, now });
    const cert = new X509Certificate(built.certPem);
    assert.equal(cert.subject, `CN=${built.host}`, host);
    assert.equal(cert.issuer, cert.subject);
    assert.equal(cert.subjectAltName, san);
    assert.equal(cert.ca, false);
    assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1']);
    assert.equal(cert.verify(cert.publicKey), true, 'self-signature verifies');
    assert.equal(cert.checkPrivateKey(createPrivateKey(built.keyPem)), true, 'key matches');
    assert.equal(certificateCoversHost(built.certPem, host), true);
    assert.equal(new Date(cert.validFrom).getTime(), now.getTime() - 5 * 60 * 1000);
    assert.equal(new Date(cert.validTo).getTime(), now.getTime() - 5 * 60 * 1000 + 825 * 86_400_000);
    assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
    assert.equal(new X509Certificate(built.certPem).fingerprint256.replace(/:/g, '').toLowerCase(), fingerprintOf(built.certPem));
  }
  assert.equal(certificateCoversHost(buildSelfSignedCertificate({ host: 'nas.local' }).certPem, 'other.local'), false);
  assert.equal(certificateCoversHost(buildSelfSignedCertificate({ host: '10.0.0.1' }).certPem, '10.0.0.2'), false);
  assert.equal(generalName('192.168.1.10').kind, 'ip');
  assert.equal(generalName('nas.tailnet.ts.net').kind, 'dns');
  assert.throws(() => generalName('bad host'), /DNS name or IP/);
  assert.throws(() => buildSelfSignedCertificate({ host: 'nas.local', days: 900 }), /1\.\.825/);
  const late = buildSelfSignedCertificate({ host: 'nas.local', days: 10, now: new Date('2049-12-30T00:00:00Z') });
  assert.match(new X509Certificate(late.certPem).validTo, /2050/);
});

test('OpenSSL verifies generated self-signed certificates', { skip: !haveOpenssl && 'openssl unavailable' }, () => {
  const dir = fresh();
  const built = buildSelfSignedCertificate({ host: '192.168.1.10' });
  writeFileSync(join(dir, 'c.crt'), built.certPem);
  const text = spawnSync('openssl', ['x509', '-in', join(dir, 'c.crt'), '-noout', '-text'], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Version: 3/);
  assert.match(text.stdout, /IP Address:192\.168\.1\.10/);
  assert.match(text.stdout, /CA:FALSE/);
  assert.match(text.stdout, /TLS Web Server Authentication/);
  const verify = spawnSync('openssl', ['verify', '-CAfile', join(dir, 'c.crt'), join(dir, 'c.crt')], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
});

test('persists the first generated certificate across restarts', () => {
  const dataDir = fresh();
  const paths = tlsPaths(dataDir);
  const first = ensureMobileCertificate({ dataDir, host: '10.1.2.3' });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.source, 'generated');
  assert.equal(first.created, true);
  assert.equal(statSync(paths.dir).mode & 0o777, 0o700);
  assert.equal(statSync(paths.keyPath).mode & 0o777, 0o600);
  assert.equal(statSync(paths.recordPath).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(paths.recordPath, 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'fingerprint', 'generated', 'host', 'notAfter', 'sanKind']);
  assert.equal(record.host, '10.1.2.3');
  assert.equal(record.sanKind, 'ip');
  assert.equal(record.fingerprint, fingerprintOf(readFileSync(paths.certPath)));
  assert.deepEqual(readdirSync(paths.dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
  const second = ensureMobileCertificate({ dataDir, host: '10.1.2.3' });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(readFileSync(paths.certPath, 'utf8'), first.cert.toString());
  assert.equal(readFileSync(paths.keyPath, 'utf8'), first.key.toString());
  const named = ensureMobileCertificate({ dataDir: fresh(), host: 'nas.tailnet.ts.net' });
  assert.equal(named.record.sanKind, 'dns');
  assert.equal(new X509Certificate(named.cert).subjectAltName, 'DNS:nas.tailnet.ts.net');
});

test('preserves owner-supplied material across start and rotation', () => {
  const dataDir = fresh();
  const paths = tlsPaths(dataDir);
  mkdirSync(paths.dir, { recursive: true });
  const own = buildSelfSignedCertificate({ host: 'owner.local' });
  writeFileSync(paths.certPath, own.certPem);
  writeFileSync(paths.keyPath, own.keyPem);
  const got = ensureMobileCertificate({ dataDir, host: 'owner.local' });
  assert.equal(got.ok, true, got.reason);
  assert.equal(got.source, 'owner');
  assert.equal(got.record, null);
  assert.equal(got.fingerprint, fingerprintOf(own.certPem));
  const elsewhere = ensureMobileCertificate({ dataDir, host: 'elsewhere.local' });
  assert.equal(elsewhere.ok, false);
  assert.equal(elsewhere.code, 'host_mismatch');
  assert.match(elsewhere.reason, /mobile\.crt does not name elsewhere\.local in its SAN/);
  assert.doesNotMatch(elsewhere.reason, /rotate-cert/);
  assert.equal(readFileSync(paths.certPath, 'utf8'), own.certPem);
  assert.equal(existsSync(paths.recordPath), false);
  const rotated = rotateMobileCertificate({ dataDir, host: 'owner.local' });
  assert.equal(rotated.ok, false);
  assert.match(rotated.reason, /owner-supplied/);
  assert.equal(readFileSync(paths.certPath, 'utf8'), own.certPem);
  writeFileSync(paths.recordPath, '{"generated":false}');
  assert.equal(ensureMobileCertificate({ dataDir, host: 'owner.local' }).source, 'owner');
});

test('owner TLS works from a read-only directory', () => {
  const dataDir = fresh();
  const paths = tlsPaths(dataDir);
  mkdirSync(paths.dir, { recursive: true });
  const own = buildSelfSignedCertificate({ host: 'owner.local' });
  writeFileSync(paths.certPath, own.certPem);
  writeFileSync(paths.keyPath, own.keyPem);
  chmodSync(paths.certPath, 0o444);
  chmodSync(paths.keyPath, 0o400);
  chmodSync(paths.dir, 0o555);
  try {
    const got = ensureMobileCertificate({ dataDir, host: 'owner.local' });
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.source, 'owner');
    assert.equal(got.fingerprint, fingerprintOf(own.certPem));
    assert.equal(existsSync(join(paths.dir, '.mobile-tls.lock')), false, 'no lock is written into the certificate mount');
    assert.equal(existsSync(paths.lockPath), false);
  } finally {
    chmodSync(paths.dir, 0o700);
  }
});

test('refuses a generated certificate for a different advertised host', () => {
  const dataDir = fresh();
  const first = ensureMobileCertificate({ dataDir, host: '192.168.1.10' });
  const moved = ensureMobileCertificate({ dataDir, host: '192.168.1.11' });
  assert.equal(moved.ok, false);
  assert.equal(moved.code, 'host_changed');
  assert.match(moved.reason, /advertised origin changed/);
  assert.match(moved.reason, /issued for 192\.168\.1\.10 but QM_ADVERTISED_ORIGIN now names 192\.168\.1\.11/);
  assert.ok(moved.reason.includes(ROTATE_COMMAND));
  assert.match(moved.reason, /re-pair every phone/);
  assert.equal(fingerprintOf(readFileSync(tlsPaths(dataDir).certPath)), first.fingerprint, 'the old leaf is untouched');
  const paths = tlsPaths(dataDir);
  const record = JSON.parse(readFileSync(paths.recordPath, 'utf8'));
  writeFileSync(paths.recordPath, JSON.stringify({ ...record, host: '192.168.1.11' }));
  assert.equal(ensureMobileCertificate({ dataDir, host: '192.168.1.11' }).code, 'host_changed');
});

test('uses fixed container names in certificate commands', () => {
  const composeExample = readFileSync(join(import.meta.dirname, '..', 'docker-compose.example.yml'), 'utf8');
  assert.match(composeExample, /container_name: qm-companion/);
  assert.ok(ROTATE_COMMAND.startsWith('docker exec qm-companion ') || /docker compose( -f docker-compose\.[a-z]+\.yml)+ exec/.test(ROTATE_COMMAND), ROTATE_COMMAND);
  assert.ok(RESTART_COMMAND.startsWith('docker restart qm-companion') || /docker compose( -f docker-compose\.[a-z]+\.yml)+ restart/.test(RESTART_COMMAND), RESTART_COMMAND);
  assert.doesNotMatch(ROTATE_COMMAND, /^docker compose exec/);
  for (const file of ['docs/tls-and-certificates.md', 'docker-compose.mobile.yml', 'src/mobile/rotate-cert.js']) {
    const text = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
    assert.doesNotMatch(text, /docker compose (exec|restart) companion/, `${file} must not document a project-less compose command`);
    assert.ok(text.includes(ROTATE_COMMAND), `${file} carries the rotation command`);
  }
});

test('rejects operator certificates whose SAN omits the advertised host', () => {
  const dataDir = fresh();
  const paths = tlsPaths(dataDir);
  mkdirSync(paths.dir, { recursive: true });
  const own = buildSelfSignedCertificate({ host: 'other.example' });
  writeFileSync(paths.certPath, own.certPem);
  writeFileSync(paths.keyPath, own.keyPem);
  const got = ensureMobileCertificate({ dataDir, host: 'nas.local' });
  assert.equal(got.ok, false);
  assert.equal(got.code, 'host_mismatch');
  assert.match(got.reason, /does not name nas\.local/);
  assert.equal(ensureMobileCertificate({ dataDir, host: 'other.example' }).ok, true);
});

test('reports dates for expired and not-yet-valid certificates', () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000 - 5 * 60 * 1000);
  const expired = buildSelfSignedCertificate({ host: 'nas.local', days: 10, now: new Date(tenDaysAgo.getTime() - 10 * 86_400_000) });
  const owner = fresh();
  mkdirSync(tlsPaths(owner).dir, { recursive: true });
  writeFileSync(tlsPaths(owner).certPath, expired.certPem);
  writeFileSync(tlsPaths(owner).keyPath, expired.keyPem);
  const o = ensureMobileCertificate({ dataDir: owner, host: 'nas.local' });
  assert.equal(o.ok, false);
  assert.equal(o.code, 'expired');
  assert.match(o.reason, /mobile\.crt expired on \d{4}-\d{2}-\d{2}T/);
  assert.match(o.reason, /Replace mobile\.crt/);
  assert.doesNotMatch(o.reason, /rotate-cert/);
  const gen = fresh();
  const first = ensureMobileCertificate({ dataDir: gen, host: 'nas.local' });
  assert.equal(first.ok, true);
  const paths = tlsPaths(gen);
  const record = JSON.parse(readFileSync(paths.recordPath, 'utf8'));
  writeFileSync(paths.certPath, expired.certPem);
  writeFileSync(paths.keyPath, expired.keyPem);
  writeFileSync(paths.recordPath, JSON.stringify({ ...record, fingerprint: fingerprintOf(expired.certPem) }));
  const g = ensureMobileCertificate({ dataDir: gen, host: 'nas.local' });
  assert.equal(g.code, 'expired');
  assert.match(g.reason, /the generated certificate expired on/);
  assert.ok(g.reason.includes(ROTATE_COMMAND));
  assert.equal(rotateMobileCertificate({ dataDir: gen, host: 'nas.local' }).ok, true);
  assert.equal(ensureMobileCertificate({ dataDir: gen, host: 'nas.local' }).ok, true);
  const future = buildSelfSignedCertificate({ host: 'nas.local', days: 10, now: new Date(Date.now() + 60 * 60 * 1000) });
  const soon = fresh();
  mkdirSync(tlsPaths(soon).dir, { recursive: true });
  writeFileSync(tlsPaths(soon).certPath, future.certPem);
  writeFileSync(tlsPaths(soon).keyPath, future.keyPem);
  const f = ensureMobileCertificate({ dataDir: soon, host: 'nas.local' });
  assert.equal(f.code, 'not_yet_valid');
  assert.match(f.reason, /server clock/);
  const fine = ensureMobileCertificate({ dataDir: fresh(), host: 'nas.local' });
  assert.equal(fine.expiresSoon, false);
  assert.match(fine.notAfter, /^\d{4}-\d{2}-\d{2}T/);
  const closing = buildSelfSignedCertificate({ host: 'nas.local', days: 10 });
  const near = fresh();
  mkdirSync(tlsPaths(near).dir, { recursive: true });
  writeFileSync(tlsPaths(near).certPath, closing.certPem);
  writeFileSync(tlsPaths(near).keyPath, closing.keyPem);
  const n = ensureMobileCertificate({ dataDir: near, host: 'nas.local' });
  assert.equal(n.ok, true);
  assert.equal(n.expiresSoon, true);
  assert.equal(n.notAfter, new Date(new X509Certificate(closing.certPem).validTo).toISOString());
});

test('classifies owner files independently of stale generation records', () => {
  const dataDir = fresh();
  const paths = tlsPaths(dataDir);
  const first = ensureMobileCertificate({ dataDir, host: 'nas.local' });
  assert.equal(first.source, 'generated');
  const own = buildSelfSignedCertificate({ host: 'owner.example' });
  writeFileSync(paths.certPath, own.certPem);
  writeFileSync(paths.keyPath, own.keyPem);
  const sameHost = ensureMobileCertificate({ dataDir, host: 'nas.local' });
  assert.equal(sameHost.ok, false);
  assert.equal(sameHost.code, 'host_mismatch', sameHost.reason);
  assert.doesNotMatch(sameHost.reason, /issued for nas\.local but QM_ADVERTISED_ORIGIN now names nas\.local/);
  const ownerHost = ensureMobileCertificate({ dataDir, host: 'owner.example' });
  assert.equal(ownerHost.ok, true, ownerHost.reason);
  assert.equal(ownerHost.source, 'owner');
  assert.equal(ownerHost.record, null);
  const rotated = rotateMobileCertificate({ dataDir, host: 'nas.local' });
  assert.equal(rotated.ok, false);
  assert.equal(rotated.code, 'owner');
  assert.equal(readFileSync(paths.certPath, 'utf8'), own.certPem);
  const tampered = fresh();
  const t = ensureMobileCertificate({ dataDir: tampered, host: 'nas.local' });
  const tp = tlsPaths(tampered);
  const replacement = buildSelfSignedCertificate({ host: 'nas.other' });
  writeFileSync(tp.certPath, replacement.certPem);
  writeFileSync(tp.keyPath, replacement.keyPem);
  writeFileSync(tp.recordPath, JSON.stringify({ ...JSON.parse(readFileSync(tp.recordPath, 'utf8')), fingerprint: fingerprintOf(replacement.certPem) }));
  assert.notEqual(t.fingerprint, fingerprintOf(replacement.certPem));
  const s = ensureMobileCertificate({ dataDir: tampered, host: 'nas.local' });
  assert.equal(s.code, 'host_changed');
  assert.match(s.reason, /no longer names nas\.local/);
});

test('stale temporary files do not block generation', () => {
  const dataDir = fresh();
  const paths = tlsPaths(dataDir);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${paths.keyPath}.1.tmp`, 'stale');
  const got = ensureMobileCertificate({ dataDir, host: 'nas.local' });
  assert.equal(got.ok, true, got.reason);
  assert.equal(existsSync(`${paths.keyPath}.1.tmp`), true);
});

test('rotation requires confirmation and prints the replacement fingerprint', () => {
  const dataDir = fresh();
  const first = ensureMobileCertificate({ dataDir, host: '192.168.1.10' });
  const paths = tlsPaths(dataDir);
  writeFileSync(join(dataDir, 'unrelated.txt'), 'kept');
  const env = { ...process.env, SECRET_KEY: 'ab'.repeat(32), QM_HOST: '192.168.1.11', DATA_DIR: dataDir, QM_ADVERTISED_ORIGIN: 'https://192.168.1.11:8788' };
  const dry = spawnSync(process.execPath, ['src/mobile/rotate-cert.js'], { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.equal(dry.status, 2);
  assert.match(dry.stdout, /--confirm/);
  assert.equal(fingerprintOf(readFileSync(paths.certPath)), first.fingerprint);
  const run = spawnSync(process.execPath, ['src/mobile/rotate-cert.js', '--confirm'], { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const after = ensureMobileCertificate({ dataDir, host: '192.168.1.11' });
  assert.equal(after.ok, true, after.reason);
  assert.notEqual(after.fingerprint, first.fingerprint);
  assert.match(run.stdout, new RegExp(`New fingerprint:\\s+${after.fingerprint}`));
  assert.match(run.stdout, new RegExp(`Previous fingerprint: ${first.fingerprint}`));
  assert.match(run.stdout, /re-pair every phone/);
  assert.doesNotMatch(run.stdout, /PRIVATE KEY/);
  assert.equal(readFileSync(join(dataDir, 'unrelated.txt'), 'utf8'), 'kept');
  assert.equal(statSync(paths.keyPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(paths.recordPath, 'utf8')).host, '192.168.1.11');
  const noOrigin = spawnSync(process.execPath, ['src/mobile/rotate-cert.js', '--confirm'], { cwd: join(import.meta.dirname, '..'), env: { ...env, QM_ADVERTISED_ORIGIN: 'http://x' }, encoding: 'utf8' });
  assert.equal(noOrigin.status, 1);
  assert.match(noOrigin.stdout, /Cannot rotate/);
});

test('rejects invalid certificate material', () => {
  const good = buildSelfSignedCertificate({ host: 'nas.local' });
  const other = buildSelfSignedCertificate({ host: 'nas.local' });
  assert.throws(() => checkMaterial('not a cert', good.keyPem), /mobile\.crt is not a readable/);
  assert.throws(() => checkMaterial(good.certPem, 'not a key'), /mobile\.key is not a readable/);
  assert.throws(() => checkMaterial(good.certPem, other.keyPem), /does not match/);
  const corrupt = fresh();
  mkdirSync(tlsPaths(corrupt).dir);
  writeFileSync(tlsPaths(corrupt).certPath, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
  writeFileSync(tlsPaths(corrupt).keyPath, good.keyPem);
  assert.equal(ensureMobileCertificate({ dataDir: corrupt, host: 'nas.local' }).code, 'invalid');
  const mismatch = fresh();
  mkdirSync(tlsPaths(mismatch).dir);
  writeFileSync(tlsPaths(mismatch).certPath, good.certPem);
  writeFileSync(tlsPaths(mismatch).keyPath, other.keyPem);
  const m = ensureMobileCertificate({ dataDir: mismatch, host: 'nas.local' });
  assert.equal(m.code, 'invalid');
  assert.match(m.reason, /does not match/);
  const half = fresh();
  mkdirSync(tlsPaths(half).dir);
  writeFileSync(tlsPaths(half).certPath, good.certPem);
  assert.equal(ensureMobileCertificate({ dataDir: half, host: 'nas.local' }).code, 'partial');
  if (process.getuid && process.getuid() !== 0) {
    const locked = fresh();
    chmodSync(locked, 0o500);
    const denied = ensureMobileCertificate({ dataDir: locked, host: 'nas.local' });
    assert.equal(denied.code, 'generate');
    assert.match(denied.reason, /EACCES|EPERM|EROFS/);
    assert.doesNotMatch(denied.reason, /PRIVATE KEY/);
    chmodSync(locked, 0o700);
  }
});
