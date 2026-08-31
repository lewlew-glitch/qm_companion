import test from 'node:test';
import assert from 'node:assert/strict';

import { isSafeLiveOrigin, gatherLive } from '../src/live.js';

test('accepts HTTPS origins for recovered keys', () => {
  for (const u of ['https://radarr.example.com', 'https://10.0.0.5:7878', 'https://nas.local']) {
    assert.equal(isSafeLiveOrigin(u), true, u);
  }
});

test('http is safe only to a private or loopback address', () => {
  for (const u of ['http://127.0.0.1:8181', 'http://192.168.1.20:7878', 'http://192.168.1.10:8080', 'http://172.16.0.9', 'http://localhost:8096', 'http://[::1]:9000']) {
    assert.equal(isSafeLiveOrigin(u), true, u);
  }
});

test('refuses cleartext keys for public hosts', () => {
  for (const u of ['http://radarr.example.com', 'http://8.8.8.8:7878', 'http://nas.example.org:8181', 'http://myserver']) {
    assert.equal(isSafeLiveOrigin(u), false, u);
  }
  assert.equal(isSafeLiveOrigin('ftp://127.0.0.1'), false);
  assert.equal(isSafeLiveOrigin('not a url'), false);
});

test('gatherLive skips unsafe origins carrying credentials', async () => {
  const services = [
    { kind: 'sabnzbd', apiKey: 'DO-NOT-SEND', url: 'http://sab.example.com:8080' },
    { kind: 'tautulli', apiKey: 'DO-NOT-SEND', url: 'http://8.8.8.8:8181' },
  ];
  const result = await gatherLive(services);
  assert.deepEqual(result, { arr: [], now: [] });
});
