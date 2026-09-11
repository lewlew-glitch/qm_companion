import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
process.env.SECRET_KEY = '77'.repeat(32);
process.env.QM_HOST = 'nas.local';
const { companionUpdateNotice, companionUpdateRuntime } = await import('../src/ui/companion-release.js');

async function render(data, failed = false) {
  const nodes = Object.fromEntries(['companion-update', 'companion-update-version', 'companion-release-status'].map((id) => [id, { hidden: true, textContent: '' }]));
  let calls = 0;
  const code = companionUpdateRuntime().replace(/^<script>|<\/script>$/g, '');
  vm.runInNewContext(code, {
    document: { hidden: false, getElementById: (id) => nodes[id], addEventListener() {} },
    window: { addEventListener() {} }, Date, setInterval() {}, clearInterval() {},
    fetch: async (url, options) => {
      calls += 1;
      assert.equal(url, '/api/companion-release');
      assert.equal(options.credentials, 'same-origin');
      if (failed) throw new Error('Offline');
      return { ok: true, json: async () => data };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  return nodes;
}

test('update notice is a hidden, keyboard-operable About link until a newer release is confirmed', async () => {
  assert.match(companionUpdateNotice(), /<a[^>]+href="\/settings\?tab=about" hidden>/);
  const current = await render({ status: 'current', currentVersion: '0.1.3' });
  assert.equal(current['companion-update'].hidden, true);
  assert.match(current['companion-release-status'].textContent, /No newer stable release/);
  const available = await render({ status: 'available', latestVersion: '0.1.4' });
  assert.equal(available['companion-update'].hidden, false);
  assert.equal(available['companion-update-version'].textContent, 'Companion v0.1.4');
  assert.equal(available['companion-release-status'].textContent, 'Companion v0.1.4 is available.');
});

test('offline and disabled checks are truthful without showing an update badge', async () => {
  for (const [data, failed, expected] of [
    [{ status: 'unknown' }, false, /Could not check/],
    [{ status: 'disabled' }, false, /turned off/],
    [{}, true, /Could not check/],
  ]) {
    const nodes = await render(data, failed);
    assert.equal(nodes['companion-update'].hidden, true);
    assert.match(nodes['companion-release-status'].textContent, expected);
  }
});

test('polling restarts once after a cached page returns and checks again when due', async () => {
  const windowEvents = new Map(), timers = new Map();
  let now = 1000, nextTimer = 0, calls = 0;
  const document = { hidden: false, getElementById: () => null, addEventListener() {} };
  vm.runInNewContext(companionUpdateRuntime().replace(/^<script>|<\/script>$/g, ''), {
    document, window: { addEventListener: (name, callback) => windowEvents.set(name, callback) },
    Date: { now: () => now },
    setInterval(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id) { timers.delete(id); },
    fetch: async () => { calls += 1; return { ok: true, json: async () => ({ status: 'current' }) }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(timers.size, 1);
  windowEvents.get('pagehide')({ persisted: true });
  windowEvents.get('pagehide')({ persisted: true });
  assert.equal(timers.size, 0);
  now += 31 * 60 * 1000;
  windowEvents.get('pageshow')?.({ persisted: true });
  windowEvents.get('pageshow')?.({ persisted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 1);
  assert.equal(calls, 2);
  now += 31 * 60 * 1000;
  timers.values().next().value();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  document.hidden = true;
  now += 31 * 60 * 1000;
  timers.values().next().value();
  assert.equal(calls, 3);
  windowEvents.get('pagehide')({ persisted: false });
  assert.equal(timers.size, 0);
});
