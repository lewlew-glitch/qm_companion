import test from 'node:test';
import assert from 'node:assert/strict';
import { pairFixture } from './helpers/pair-reissue-fixture.mjs';

for (const transport of ['file', 'qr']) test(`new connections require explicit selection and survive real ${transport} delivery and reissue`, async (t) => {
  const fixture = await pairFixture(t, { newConnections: true, withKeys: true });
  assert.deepEqual(fixture.selected(fixture.initialHtml), ['bazarr', 'radarr', 'sonarr']);
  const selected = ['peanut', 'pulsarr', 'uptimekuma'];
  const ready = await fixture.createMany(selected);
  assert.equal(ready.status, 200);
  assert.match(ready.html, /requires Quartermaster 1\.3 or later/);
  const payload = await fixture.payload(ready, transport);
  assert.deepEqual(payload.services.map((service) => service.kind), selected);
  assert.deepEqual(payload.profiles[0].serviceIds, payload.services.map((service) => service.id));
  for (const service of payload.services) {
    assert.deepEqual(service.secrets, {}, 'unverified widget values and passwords do not become API keys');
    assert.equal(service.disabled === true, service.kind === 'pulsarr');
  }
  const renewed = await fixture.reissue(ready);
  const replay = await fixture.payload(renewed, transport === 'file' ? 'qr' : 'file');
  assert.deepEqual(replay.services, payload.services);
  assert.notEqual(replay.companion.bundleId, payload.companion.bundleId);
});
