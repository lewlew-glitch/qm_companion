import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalHost, integerSetting, numberSetting } from '../src/config-values.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('canonicalHost accepts and normalises host-only values', () => {
  assert.equal(canonicalHost('NAS.Home.Local.'), 'nas.home.local');
  assert.equal(canonicalHost('127.0.0.1'), '127.0.0.1');
  assert.equal(canonicalHost('[2001:0DB8:0:0::1]'), '[2001:db8::1]');
  assert.equal(canonicalHost('', { required: false }), '');
});

test('canonicalHost rejects non-host input', () => {
  for (const value of [
    ' https://nas.local', 'https://nas.local', 'nas.local:7878', 'user@nas.local',
    'nas.local/path', 'nas.local?x=1', 'nas local', '999.1.1.1', '2001:db8::1',
    '[not-ipv6]', '-nas.local', 'nas..local', '010.0.0.1', '127.1', '0x7f.0.0.1',
  ]) {
    assert.throws(() => canonicalHost(value, { name: 'QM_HOST' }), /QM_HOST/);
  }
});

test('numeric settings are finite, bounded, and do not accept coercion syntax', () => {
  assert.equal(integerSetting(undefined, { name: 'PORT', fallback: 8787, min: 1, max: 65535 }), 8787);
  assert.equal(integerSetting('443', { name: 'PORT', fallback: 8787, min: 1, max: 65535 }), 443);
  assert.equal(numberSetting('0.5', { name: 'TTL', fallback: 24, min: 0.1, max: 100 }), 0.5);
  for (const value of ['0', '-1', '1e3', '12px', '65536', 'Infinity']) {
    assert.throws(() => integerSetting(value, { name: 'PORT', fallback: 8787, min: 1, max: 65535 }));
  }
});

test('runtime config refuses a missing host and invalid numeric settings', () => {
  const base = { ...process.env, SECRET_KEY: '00'.repeat(32) };
  delete base.QM_HOST;
  let result = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/config.js'"], {
    cwd: projectRoot, env: base, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QM_HOST is required/);

  result = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/config.js'"], {
    cwd: projectRoot, env: { ...base, QM_HOST: 'nas.local', PORT: 'not-a-port' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PORT must be/);
});
