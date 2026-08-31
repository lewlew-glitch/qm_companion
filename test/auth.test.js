import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('setup claim preserves the existing owner', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-auth-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const auth = await import('./src/auth.js');
    const store = await import('./src/store.js');
    const first = auth.claimPassword('first secure password');
    auth.setDisplayName('Owner');
    const second = auth.claimPassword('attacker replacement');
    const changed = auth.changePassword('first secure password', 'second secure password');
    console.log(JSON.stringify({ first, second, changed: !!changed, owner: store.getOwner() }));
  `], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { ...process.env, SECRET_KEY: '22'.repeat(32), QM_HOST: 'nas.local', DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.first, true);
  assert.equal(output.second, false);
  assert.equal(output.changed, true);
  assert.equal(output.owner.name, 'Owner');
  assert.equal(output.owner.createdAt > 0, true);
});

test('MFA disappearing after the password step fails closed', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-auth-mfa-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const auth = await import('./src/auth.js');
    const store = await import('./src/store.js');
    auth.claimPassword('first secure password');
    const owner = store.getOwner();
    store.setOwner({ ...owner, mfaEnc: '00'.repeat(12) + ':' + '00'.repeat(16) + ':00' });
    const passwordStep = await auth.attemptLogin('first secure password', '127.0.0.1');
    const changed = store.getOwner();
    delete changed.mfaEnc;
    store.setOwner(changed);
    const session = await auth.completeMfa(passwordStep.mfa, '000000', '127.0.0.1');
    console.log(JSON.stringify({ hadTicket: !!passwordStep.mfa, session }));
  `], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { ...process.env, SECRET_KEY: '33'.repeat(32), QM_HOST: 'nas.local', DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { hadTicket: true, session: null });
});

test('owner passwords have a hard upper bound before scrypt work', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-auth-bound-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const auth = await import('./src/auth.js');
    const store = await import('./src/store.js');
    const claimed = auth.claimPassword('x'.repeat(auth.MAX_PASSWORD_CHARS + 1));
    console.log(JSON.stringify({ claimed, hasOwner: store.hasOwner() }));
  `], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { ...process.env, SECRET_KEY: '55'.repeat(32), QM_HOST: 'nas.local', DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { claimed: false, hasOwner: false });
});

test('failures from other peers cannot globally lock out the owner', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-auth-peer-limit-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const auth = await import('./src/auth.js');
    auth.claimPassword('first secure password');
    await Promise.all(Array.from({ length: 12 }, (_, i) => auth.attemptLogin('wrong', '10.0.0.' + (i + 1))));
    const owner = await auth.attemptLogin('first secure password', '192.0.2.50');
    console.log(JSON.stringify({ signedIn: !!owner?.session, cleanPeerLimited: auth.ipThrottled('192.0.2.50') }));
  `], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { ...process.env, SECRET_KEY: '66'.repeat(32), QM_HOST: 'nas.local', DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { signedIn: true, cleanPeerLimited: false });
});

test('MFA tickets are peer-bound and MFA attempts consume the peer rate limit', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-auth-ticket-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { createHash } = await import('node:crypto');
    const auth = await import('./src/auth.js');
    const store = await import('./src/store.js');
    const secrets = await import('./src/secrets.js');
    auth.claimPassword('first secure password');
    const recoveryCode = 'aabbccddee';
    const recovery = [createHash('sha256').update(recoveryCode).digest('hex')];
    store.setOwner({ ...store.getOwner(), mfaEnc: secrets.seal(JSON.stringify({ secretHex: '11'.repeat(20), recovery }), 'owner-mfa') });
    const passwordStep = await auth.attemptLogin('first secure password', '192.0.2.10');
    const stolen = await auth.completeMfa(passwordStep.mfa, recoveryCode, '192.0.2.11');
    const bound = await auth.completeMfa(passwordStep.mfa, recoveryCode, '192.0.2.10');
    await Promise.all(Array.from({ length: 30 }, () => auth.completeMfa('invalid-ticket', '000000', '192.0.2.12')));
    console.log(JSON.stringify({ stolen: !!stolen, bound: !!bound, mfaPeerLimited: auth.ipThrottled('192.0.2.12') }));
  `], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { ...process.env, SECRET_KEY: '77'.repeat(32), QM_HOST: 'nas.local', DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { stolen: false, bound: true, mfaPeerLimited: true });
});

test('password and MFA changes revoke existing sessions', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-auth-revoke-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { createHmac } = await import('node:crypto');
    const auth = await import('./src/auth.js');
    auth.claimPassword('first secure password');

    const passwordOldA = auth.createSession();
    const passwordOldB = auth.createSession();
    const changed = auth.changePassword('first secure password', 'second secure password');
    const passwordRevoked = !auth.sessionFor(passwordOldA.token, 'http') && !auth.sessionFor(passwordOldB.token, 'http');
    const passwordFresh = !!auth.sessionFor(changed.session.token, 'http');

    const beforeEnable = auth.createSession();
    const secret = Buffer.from('22'.repeat(20), 'hex');
    const step = Math.floor(Date.now() / 1000 / 30);
    const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(step));
    const mac = createHmac('sha1', secret).update(message).digest();
    const at = mac[mac.length - 1] & 15;
    const number = ((mac[at] & 127) << 24) | (mac[at + 1] << 16) | (mac[at + 2] << 8) | mac[at + 3];
    const code = String(number % 1000000).padStart(6, '0');
    const enabled = auth.enableMfa(secret.toString('hex'), code);
    const enableRevoked = !auth.sessionFor(changed.session.token, 'http') && !auth.sessionFor(beforeEnable.token, 'http');
    const enableFresh = !!auth.sessionFor(enabled.session.token, 'http');

    const beforeDisable = auth.createSession();
    const disabled = auth.disableMfa(enabled.recoveryCodes[0]);
    const disableRevoked = !auth.sessionFor(enabled.session.token, 'http') && !auth.sessionFor(beforeDisable.token, 'http');
    const disableFresh = !!auth.sessionFor(disabled.session.token, 'http');
    console.log(JSON.stringify({ passwordRevoked, passwordFresh, enableRevoked, enableFresh, disableRevoked, disableFresh }));
  `], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { ...process.env, SECRET_KEY: '88'.repeat(32), QM_HOST: 'nas.local', DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    passwordRevoked: true,
    passwordFresh: true,
    enableRevoked: true,
    enableFresh: true,
    disableRevoked: true,
    disableFresh: true,
  });
});

test('Docker access step-up requires password and MFA', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-auth-step-up-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { createHash, createHmac } = await import('node:crypto');
    const auth = await import('./src/auth.js');
    const store = await import('./src/store.js');
    const secrets = await import('./src/secrets.js');
    auth.claimPassword('first secure password');

    const wrongWithoutMfa = await auth.verifyOwnerStepUp('wrong', '', '192.0.2.20');
    const rightWithoutMfa = await auth.verifyOwnerStepUp('first secure password', '', '192.0.2.21');

    const secret = Buffer.from('44'.repeat(20), 'hex');
    const recoveryCode = 'aabbccddee';
    const recovery = [createHash('sha256').update(recoveryCode).digest('hex')];
    store.setOwner({
      ...store.getOwner(),
      mfaEnc: secrets.seal(JSON.stringify({ secretHex: secret.toString('hex'), recovery }), 'owner-mfa'),
    });

    const passwordOnly = await auth.verifyOwnerStepUp('first secure password', '', '192.0.2.22');
    const wrongPassword = await auth.verifyOwnerStepUp('wrong', recoveryCode, '192.0.2.23');
    const recoveryWorks = await auth.verifyOwnerStepUp('first secure password', recoveryCode, '192.0.2.24');
    const recoveryIsSingleUse = await auth.verifyOwnerStepUp('first secure password', recoveryCode, '192.0.2.25');

    const step = Math.floor(Date.now() / 1000 / 30);
    const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(step));
    const mac = createHmac('sha1', secret).update(message).digest();
    const at = mac[mac.length - 1] & 15;
    const number = ((mac[at] & 127) << 24) | (mac[at + 1] << 16) | (mac[at + 2] << 8) | mac[at + 3];
    const code = String(number % 1000000).padStart(6, '0');
    const totpWorks = await auth.verifyOwnerStepUp('first secure password', code, '192.0.2.26');
    console.log(JSON.stringify({
      wrongWithoutMfa, rightWithoutMfa, passwordOnly, wrongPassword,
      recoveryWorks, recoveryIsSingleUse, totpWorks,
    }));
  `], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { ...process.env, SECRET_KEY: '9a'.repeat(32), QM_HOST: 'nas.local', DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    wrongWithoutMfa: false,
    rightWithoutMfa: true,
    passwordOnly: false,
    wrongPassword: false,
    recoveryWorks: true,
    recoveryIsSingleUse: false,
    totpWorks: true,
  });
});
