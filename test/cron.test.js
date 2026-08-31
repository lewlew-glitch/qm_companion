import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('cron jobs serialize, coalesce duplicates, and timer failures are handled', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-cron-runner-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { createSerialJobRunner, createGuardedTrigger } = await import('./src/cron.js');

    let active = 0;
    let maxActive = 0;
    let releaseFirst;
    const calls = [];
    const runner = createSerialJobRunner(async (id) => {
      calls.push(id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (id === 'first') await new Promise((resolve) => { releaseFirst = resolve; });
      active -= 1;
      return id;
    });
    const first = runner('first');
    const duplicate = runner('first');
    const second = runner('second');
    assert.equal(first, duplicate);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['first']);
    releaseFirst();
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(maxActive, 1);

    const recovering = createSerialJobRunner(async (id) => {
      if (id === 'bad') throw new Error('state write failed');
      return 'recovered';
    });
    await assert.rejects(recovering('bad'), /state write failed/);
    assert.equal(await recovering('good'), 'recovered');

    let rejectTick;
    let tickCalls = 0;
    let reported = 0;
    let unhandled = null;
    const onUnhandled = (error) => { unhandled = error; };
    process.on('unhandledRejection', onUnhandled);
    const trigger = createGuardedTrigger(() => {
      tickCalls += 1;
      if (tickCalls === 1) return new Promise((_, reject) => { rejectTick = reject; });
      return Promise.resolve();
    }, async () => { reported += 1; throw new Error('reporter failed too'); });
    assert.equal(trigger(), true);
    assert.equal(trigger(), false);
    await new Promise((resolve) => setImmediate(resolve));
    rejectTick(new Error('tick failed'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(trigger(), true);
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    assert.equal(tickCalls, 2);
    assert.equal(reported, 1);
    assert.equal(unhandled, null);

    console.log(JSON.stringify({ calls, maxActive, tickCalls, reported }));
  `], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      SECRET_KEY: '99'.repeat(32),
      QM_HOST: 'nas.local',
      DATA_DIR: dataDir,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    calls: ['first', 'second'],
    maxActive: 1,
    tickCalls: 2,
    reported: 1,
  });
});
