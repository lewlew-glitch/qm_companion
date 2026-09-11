import test from 'node:test';
import assert from 'node:assert/strict';
import { PORTS, matchImage } from '../src/kinds.js';
import { homepageCredential, mountedConfigKind, extractContainerApiKey } from '../src/detect.js';
import { canSaveManualKey, ladderFor } from '../src/keyladder.js';

// These widgets document a scalar API key independently of their optional login methods.
// https://gethomepage.dev/widgets/services/komga/
// https://gethomepage.dev/widgets/services/tdarr/
// https://gethomepage.dev/widgets/services/gluetun/
for (const kind of ['komga', 'tdarr', 'gluetun']) test(`${kind} transfers only its own explicitly supplied widget key`, () => {
  assert.deepEqual(homepageCredential(kind, {
    'homepage.widget.type': kind, 'homepage.widget.key': `${kind}-key`,
  }), { apiKey: `${kind}-key`, credentialConflict: false });
  assert.deepEqual(homepageCredential(kind, {
    'homepage.widgets[0].type': 'radarr', 'homepage.widgets[0].key': 'other-service-key',
    'homepage.widgets[1].type': kind, 'homepage.widgets[1].key': `${kind}-key`,
  }), { apiKey: `${kind}-key`, credentialConflict: false });
  assert.deepEqual(homepageCredential(kind, {
    'homepage.widget.type': kind, 'homepage.widget.key': 'first-key',
    'homepage.widgets[1].type': kind, 'homepage.widgets[1].key': 'second-key',
  }), { apiKey: undefined, credentialConflict: true });
  assert.deepEqual(homepageCredential(kind, {
    'homepage.widget.type': kind, 'homepage.widget.username': 'account', 'homepage.widget.password': 'private-password',
  }), { apiKey: undefined, credentialConflict: false });
});

test('optional Tdarr, Gluetun and explicitly supplied Plex tokens have manual entry without inventing a key', () => {
  for (const kind of ['tdarr', 'gluetun', 'plex']) {
    assert.equal(canSaveManualKey(kind), true, kind);
    assert.equal(ladderFor(kind).class, 'manual');
    assert.ok(ladderFor(kind).settingsPath);
    assert.equal(canSaveManualKey(kind, 'already-supplied'), false);
    assert.equal(canSaveManualKey(kind, undefined, true), false);
  }
});

test('all catalogue images keep their kind when pinned by tag or digest', () => {
  for (const kind of Object.keys(PORTS)) {
    assert.equal(matchImage(`registry.example/${kind}:latest`, `${kind}-second`), kind);
    assert.equal(matchImage(`registry.example/${kind}@sha256:${'a'.repeat(64)}`, 'service'), kind);
  }
});

// Seerr retains the existing Jellyseerr API and settings shape.
// https://gethomepage.dev/widgets/services/seerr/
// https://github.com/seerr-team/seerr/blob/v3.2.0/server/lib/settings/index.ts
test('official Seerr image, widget and bounded config aliases map to Jellyseerr without swallowing MusicSeerr', () => {
  for (const image of ['ghcr.io/seerr-team/seerr:latest', `ghcr.io/seerr-team/seerr@sha256:${'b'.repeat(64)}`]) {
    assert.equal(matchImage(image, 'seerr'), 'jellyseerr');
  }
  for (const name of ['seerr', 'seerr-main', 'seerr_4k', 'seerr.archive']) assert.equal(mountedConfigKind(name), 'jellyseerr');
  assert.equal(mountedConfigKind('notseerr'), undefined);
  assert.equal(matchImage('registry.example/musicseerr-worker:latest', 'musicseerr-second'), 'musicseerr');
  assert.deepEqual(homepageCredential('jellyseerr', {
    'homepage.widget.type': 'seerr', 'homepage.widget.key': 'seerr-key',
  }), { apiKey: 'seerr-key', credentialConflict: false });
  assert.deepEqual(homepageCredential('musicseerr', {
    'homepage.widget.type': 'seerr', 'homepage.widget.key': 'wrong-key',
  }), { apiKey: undefined, credentialConflict: false });
  assert.equal(extractContainerApiKey(mountedConfigKind('seerr-main'), '/app/config/settings.json', Buffer.from(JSON.stringify({
    main: { apiKey: 'seerr-main-key' }, jellyfin: { apiKey: 'unrelated-media-server-key' },
  }))), 'seerr-main-key');
});
