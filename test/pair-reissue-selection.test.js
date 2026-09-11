import test from 'node:test';
import assert from 'node:assert/strict';
import { pairFixture } from './helpers/pair-reissue-fixture.mjs';

const kinds = (payload) => payload.services.map((service) => service.kind);

test('stale or missing reissue revision cannot export another tab selection or consume its draft', async (t) => {
  const fixture = await pairFixture(t);
  const first = await fixture.create('bazarr');
  const latest = await fixture.create('sonarr');
  assert.ok(first.bundleId);
  assert.notEqual(first.bundleId, latest.bundleId);
  const otherSession = await fixture.otherSessionReissue(latest);
  assert.equal(otherSession.status, 409);
  assert.deepEqual(fixture.selected(otherSession.html), []);
  for (const stale of [first, {}, { bundleId: 'untrusted_bundle_identifier' }]) {
    const refused = await fixture.reissue(stale);
    assert.equal(refused.status, 409);
    assert.deepEqual(fixture.selected(refused.html), []);
    assert.equal(refused.file, undefined);
  }
  const renewed = await fixture.reissue(latest);
  assert.notEqual(renewed.bundleId, latest.bundleId);
  assert.deepEqual(kinds(await fixture.payload(renewed)), ['sonarr']);
});

test('failed reissue preserves the selected subset in the form and in a subsequent retry', async (t) => {
  const fixture = await pairFixture(t, { failQrAt: 2 });
  const first = await fixture.create('bazarr');
  const failure = await fixture.reissue(first);
  assert.equal(failure.status, 400);
  assert.deepEqual(fixture.selected(failure.html), ['bazarr']);
  const retried = await fixture.retry(failure.html);
  assert.deepEqual(kinds(await fixture.payload(retried)), ['bazarr']);
});

test('failed reissue releases its claim so the same reviewed draft can be retried', async (t) => {
  const fixture = await pairFixture(t, { failQrAt: 2 });
  const first = await fixture.create('bazarr');
  assert.equal((await fixture.reissue(first)).status, 400);
  const retry = await fixture.reissue(first);
  assert.deepEqual(kinds(await fixture.payload(retry)), ['bazarr']);
});

for (const failing of [false, true]) {
  test(`a ${failing ? 'failed' : 'successful'} older in-flight reissue cannot overwrite a newer tab draft`, async (t) => {
    const fixture = await pairFixture(t, { holdQrAt: 2, failQrAt: failing ? 2 : 0 });
    const first = await fixture.create('bazarr');
    const pending = fixture.reissue(first);
    await fixture.waitHeld();
    const duplicate = await fixture.reissue(first);
    assert.equal(duplicate.status, 409);
    assert.deepEqual(fixture.selected(duplicate.html), []);
    const latest = await fixture.create('sonarr');
    fixture.release();
    const superseded = await pending;
    assert.equal(superseded.status, 409);
    assert.deepEqual(fixture.selected(superseded.html), []);
    assert.equal(superseded.file, undefined);
    const renewed = await fixture.reissue(latest);
    assert.deepEqual(kinds(await fixture.payload(renewed)), ['sonarr']);
  });
}
