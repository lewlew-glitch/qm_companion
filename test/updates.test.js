import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-updates-'));
process.env.SECRET_KEY = '33'.repeat(32);
process.env.QM_HOST = '192.168.1.20';
process.env.DATA_DIR = dataDir;
process.env.DOCKER_HOST = 'tcp://127.0.0.1:9';

const { decorateUpdates, updatesState, knownUpdateCount, runUpdateCheck } = await import('../src/updates.js');
const { addDismissedUpdates, getDismissedUpdates } = await import('../src/store.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

const A = `sha256:${'aa'.repeat(32)}`;
const B = `sha256:${'bb'.repeat(32)}`;

test('dismissal applies only to its recorded digest', () => {
  addDismissedUpdates([{ ref: 'lscr.io/linuxserver/radarr:latest', digest: A }]);
  const rows = decorateUpdates([
    { image: 'lscr.io/linuxserver/radarr:latest', status: 'update', localDigest: B, remoteDigest: A },
    { image: 'lscr.io/linuxserver/sonarr:latest', status: 'update', localDigest: B, remoteDigest: A },
  ]);
  assert.equal(rows[0].dismissed, true);
  assert.equal(rows[1].dismissed, false);
  assert.equal(knownUpdateCount(), 1, 'the sidebar figure excludes what was dismissed');
});

test('a changed remote digest clears dismissal', () => {
  const rows = decorateUpdates([
    { image: 'lscr.io/linuxserver/radarr:latest', status: 'update', localDigest: A, remoteDigest: B },
  ]);
  assert.equal(rows[0].dismissed, false);
  assert.equal(knownUpdateCount(), 1);
});

test('current and unknown rows are not dismissed', () => {
  const rows = decorateUpdates([
    { image: 'lscr.io/linuxserver/radarr:latest', status: 'current', localDigest: A, remoteDigest: A },
    { image: 'ghcr.io/private/thing:latest', status: 'unknown', localDigest: '', remoteDigest: '' },
  ]);
  assert.equal(rows[0].dismissed, false);
  assert.equal(rows[1].dismissed, false);
  assert.equal(knownUpdateCount(), 0);
});

test('dismissal merge replaces matching refs', () => {
  addDismissedUpdates([{ ref: 'one:latest', digest: A }]);
  addDismissedUpdates([{ ref: 'one:latest', digest: B }]);
  const rows = getDismissedUpdates().filter((row) => row.ref === 'one:latest');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].digest, B);
});

test('dismissal list retains the newest 500 entries', async () => {
  addDismissedUpdates(Array.from({ length: 520 }, (_, i) => ({ ref: `bulk-${i}:latest`, digest: A })));
  assert.equal(getDismissedUpdates().length, 500);
  await new Promise((resolve) => setTimeout(resolve, 5));
  addDismissedUpdates([{ ref: 'newest:latest', digest: B }]);
  const rows = getDismissedUpdates();
  assert.equal(rows.length, 500);
  assert.equal(rows[0].ref, 'newest:latest');
});

test('invalid dismissal rows are dropped', () => {
  const before = getDismissedUpdates().length;
  addDismissedUpdates([
    { ref: '', digest: A },
    { ref: 'ok:latest', digest: 'not-a-digest' },
    { ref: 'x'.repeat(301), digest: A },
    null,
    'string',
  ]);
  assert.equal(getDismissedUpdates().length, before);
});

test('an empty registry cache returns an empty update state', () => {
  const s = updatesState([{ image: 'lscr.io/linuxserver/radarr:latest' }], []);
  assert.equal(s.checkedAt, null);
  assert.deepEqual(s.results, []);
  assert.equal(s.updateCount, 0);
});

test('cron reports Docker unavailability without running a check', async () => {
  const r = await runUpdateCheck();
  assert.equal(r.ok, false);
  assert.match(r.note, /Docker is unavailable/);
});
