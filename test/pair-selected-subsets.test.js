import test from 'node:test';
import assert from 'node:assert/strict';
import { pairFixture } from './helpers/pair-reissue-fixture.mjs';

const allKinds = ['bazarr', 'prowlarr', 'radarr', 'sonarr'];
const selections = [['bazarr', 'radarr'], ['bazarr', 'radarr', 'sonarr']];

function assertExactSubset(payload, all, selected) {
  const expected = all.services.filter((service) => selected.includes(service.kind));
  const expectedIds = expected.map((service) => service.id);
  assert.deepEqual(payload.services.map((service) => service.kind), selected);
  assert.deepEqual(payload.services.map((service) => service.id), expectedIds);
  assert.equal(payload.profiles.length, 1);
  assert.equal(payload.activeProfileId, all.activeProfileId);
  assert.equal(payload.profiles[0].id, payload.activeProfileId);
  assert.deepEqual(payload.profiles[0].serviceIds, expectedIds);
  assert.equal(payload.profileSecrets, undefined);
  for (const service of payload.services) {
    assert.deepEqual(service.secrets, { apiKey: `fixture-${service.kind}-key` });
  }
  const decoded = JSON.stringify(payload);
  for (const excluded of all.services.filter((service) => !selected.includes(service.kind))) {
    assert.equal(decoded.includes(excluded.id), false, 'excluded service ID must be absent');
    assert.equal(decoded.includes(`fixture-${excluded.kind}-key`), false, 'excluded credential must be absent');
  }
  assert.equal(Date.parse(payload.companion.expiresAt) - Date.parse(payload.companion.issuedAt), 180_000);
}

for (const selected of selections) {
  for (const transport of ['file', 'qr']) {
    test(`real ${transport} handoff exports exactly ${selected.length} selected services from four detected`, async (t) => {
      const fixture = await pairFixture(t, { extraService: true, withKeys: true });
      const all = await fixture.payload(await fixture.createMany(allKinds));
      assert.deepEqual(all.services.map((service) => service.kind), allKinds);
      assert.equal(all.services.length, 4);
      const ready = await fixture.createMany(selected);
      assert.match(ready.html, new RegExp(`Handing over ${selected.length} services`));
      for (const kind of allKinds) assert.equal(ready.html.includes(`fixture-${kind}-key`), false);
      const payload = await fixture.payload(ready, transport);
      assertExactSubset(payload, all, selected);
      const renewed = await fixture.reissue(ready);
      assert.notEqual(renewed.bundleId, ready.bundleId);
      const replay = await fixture.payload(renewed, transport === 'file' ? 'qr' : 'file');
      assertExactSubset(replay, all, selected);
    });
  }
}
