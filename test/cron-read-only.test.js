import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const projectRoot = join(import.meta.dirname, '..');
const KEY = 'ab'.repeat(32);
const roots = [];
test.after(() => { for (const root of roots) { spawnSync('chflags', ['nouchg', root]); rmSync(root, { recursive: true, force: true }); } });

function seededVolume() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-cron-ro-'));
  roots.push(dir);
  const seed = spawnSync(process.execPath, ['-e', `
    process.env.DATA_DIR = ${JSON.stringify(dir)};
    process.env.SECRET_KEY = ${JSON.stringify(KEY)};
    process.env.QM_HOST = 'nas.local';
    const s = await import('./src/store.js');
    s.claimOwner({ hashHex: 'aa'.repeat(64), saltHex: 'bb'.repeat(16) });
  `], { cwd: projectRoot, encoding: 'utf8', env: { ...process.env } });
  assert.equal(seed.status, 0, `seeding failed: ${seed.stderr}`);
  return dir;
}

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('cron listing does not write state', () => {
  const dir = seededVolume();
  const stateFile = join(dir, 'qm-companion.json');
  const before = digest(stateFile);

  const run = spawnSync(process.execPath, ['-e', `
    const c = await import('./src/cron.js');
    process.stdout.write(String(c.listJobs().length));
  `], {
    cwd: projectRoot, encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir, SECRET_KEY: KEY, QM_HOST: 'nas.local' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Number(run.stdout) > 0);
  assert.equal(digest(stateFile), before, 'and the state file is byte-identical');
});

test('cron page works on read-only volumes', (t) => {
  const dir = seededVolume();
  if (spawnSync('chflags', ['uchg', dir], { encoding: 'utf8' }).status !== 0) {
    t.skip('chflags is unavailable, so an unwritable volume cannot be simulated here');
    return;
  }
  t.after(() => spawnSync('chflags', ['nouchg', dir]));

  const run = spawnSync(process.execPath, ['-e', `
    const c = await import('./src/cron.js');
    process.stdout.write(String(c.listJobs().length));
  `], {
    cwd: projectRoot, encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir, SECRET_KEY: KEY, QM_HOST: 'nas.local' },
  });
  assert.equal(run.status, 0, `reading cron must not need write access: ${run.stderr}`);
  assert.doesNotMatch(run.stderr, /EPERM/);
  assert.ok(Number(run.stdout) > 0);
});
