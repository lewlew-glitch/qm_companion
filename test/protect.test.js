import test from 'node:test';
import assert from 'node:assert/strict';

import { isProtectedContainer, PROTECTED_CONTAINER_NAMES, PROTECTED_SERVICE_NAMES, PROTECT_LABEL } from '../src/protect.js';
import { prune } from '../src/docker.js';

test('the companion and its socket proxy are protected by exact container name', () => {
  assert.equal(isProtectedContainer('qm-companion', ''), true);
  assert.equal(isProtectedContainer('qm-socket-proxy', ''), true);
  assert.equal(isProtectedContainer('/qm-companion', ''), true);
});

test('renamed services remain protected by labels', () => {
  assert.equal(isProtectedContainer('renamed-box', 'companion'), true);
  assert.equal(isProtectedContainer('anything', 'socket-proxy'), true);
  assert.equal(isProtectedContainer('renamed-box', 'qm-companion'), true);
  assert.equal(isProtectedContainer('anything', 'qm-socket-proxy'), true);
});

test('qm.protected labels protect any container and service name', () => {
  assert.equal(isProtectedContainer('totally-ordinary', 'radarr', { [PROTECT_LABEL]: 'true' }), true);
  assert.equal(isProtectedContainer('totally-ordinary', 'radarr', { [PROTECT_LABEL]: 'TRUE' }), true);
  assert.equal(isProtectedContainer('totally-ordinary', 'radarr', { [PROTECT_LABEL]: 'false' }), false);
  assert.equal(isProtectedContainer('totally-ordinary', 'radarr', { [PROTECT_LABEL]: '' }), false);
  assert.equal(isProtectedContainer('totally-ordinary', 'radarr', {}), false);
  assert.equal(isProtectedContainer('totally-ordinary', 'radarr', undefined), false);
});

test('ordinary containers are not protected', () => {
  for (const name of ['radarr', 'sonarr', 'jellyfin', 'qm-companionish']) {
    assert.equal(isProtectedContainer(name, 'radarr'), false, name);
  }
  assert.equal(isProtectedContainer('socket-proxy', 'radarr'), false);
  assert.equal(isProtectedContainer('', ''), false);
});

test('blanket daemon container pruning is refused so no caller can restore it', async () => {
  const result = await prune('containers');
  assert.equal(result.ok, false);
  assert.match(result.note, /guarded path/);
});

test('protected sets include containers and service keys', () => {
  assert.deepEqual([...PROTECTED_CONTAINER_NAMES].sort(), ['qm-companion', 'qm-socket-proxy']);
  assert.ok(PROTECTED_SERVICE_NAMES.includes('companion'), 'the real companion service key is protected');
  assert.ok(PROTECTED_SERVICE_NAMES.includes('socket-proxy'), 'the real socket-proxy service key is protected');
  assert.equal(PROTECT_LABEL, 'qm.protected');
});
