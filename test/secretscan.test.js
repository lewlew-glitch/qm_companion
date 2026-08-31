import test from 'node:test';
import assert from 'node:assert/strict';

import { isSecretValue, isSafeInspectableEnvValue, isSafeInspectableLabelValue, secretShapedValue } from '../src/secretscan.js';

test('redacts secret-named values', () => {
  for (const name of ['API_KEY', 'DB_PASSWORD', 'JWT_SECRET', 'ACCESS_TOKEN', 'PRIVATE_KEY', 'PUID_TOKEN', 'salt']) {
    assert.equal(isSecretValue(name, 'x'), true, name);
  }
});

test('secret-shaped values are redacted even under an innocent name', () => {
  assert.equal(isSecretValue('CONFIG', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'), true);
  assert.equal(isSecretValue('X', 'f'.repeat(16) + '9'), true);
  assert.equal(secretShapedValue('sk-01234567890abcdefghij'), true);
});

test('plain config is not redacted', () => {
  for (const [name, value] of [['TZ', 'Etc/UTC'], ['PUID', '1000'], ['PGID', '1000'], ['LANG', 'en_GB.UTF-8'], ['PATH', '/usr/local/bin'], ['UMASK', '022']]) {
    assert.equal(isSecretValue(name, value), false, `${name}=${value}`);
  }
});

test('empty values are excluded from secret detection', () => {
  assert.equal(isSecretValue('API_KEY', ''), false);
  assert.equal(isSecretValue('PASSWORD', ''), false);
});

test('short values are not treated as credentials by shape alone', () => {
  assert.equal(secretShapedValue('short1'), false);
  assert.equal(secretShapedValue('1234'), false);
  assert.equal(secretShapedValue('a-b-c'), false);
});

test('detects secret-shaped connection and authorization values', () => {
  for (const value of [
    'postgres://user:pass@db/app',
    'https://user:pass@example.test/path',
    'Bearer abc123',
    'Password=small;Server=db',
    'https://hooks.example.test/a1b2c3d4e5f6g7h8',
  ]) assert.equal(secretShapedValue(value), true, value);
  for (const name of ['AUTH', 'DATABASE_URL', 'DB_URL', 'DSN', 'CONNECTION_STRING']) {
    assert.equal(isSecretValue(name, 'abc123'), true, name);
  }
});

test('inspection returns allowlisted environment values only', () => {
  for (const [name, value] of [['TZ', 'Europe/London'], ['PUID', '1000'], ['LANG', 'en_GB.UTF-8'], ['PATH', '/usr/local/bin:/usr/bin']]) {
    assert.equal(isSafeInspectableEnvValue(name, value), true, `${name}=${value}`);
  }
  for (const [name, value] of [['AUTH', 'abc123'], ['DATABASE_URL', 'postgres://db/app'], ['APP_URL', 'https://example.test'], ['FEATURE_FLAG', 'on']]) {
    assert.equal(isSafeInspectableEnvValue(name, value), false, `${name} stays server-held`);
  }
});

test('container inspection exposes only strict operational labels', () => {
  assert.equal(isSafeInspectableLabelValue('com.docker.compose.project', 'media-stack'), true);
  assert.equal(isSafeInspectableLabelValue('qm.protected', 'true'), true);
  assert.equal(isSafeInspectableLabelValue('qm.url', 'https://radarr.example.test/path'), true);
  assert.equal(isSafeInspectableLabelValue('qm.url', 'https://user:pass@radarr.example.test/path'), false);
  assert.equal(isSafeInspectableLabelValue('homepage.widget.url', 'https://homepage.example.test'), false);
  assert.equal(isSafeInspectableLabelValue('traefik.http.middlewares.auth.basicauth.users', 'user:hash'), false);
});
