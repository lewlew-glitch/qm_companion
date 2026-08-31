import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';


const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET_KEY = '3d'.repeat(32);
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-access-commit-'));
  roots.push(root);
  return root;
}

function run(dataDir, source, extra = {}, preArgs = []) {
  return spawnSync(process.execPath, [...preArgs, '--input-type=module', '-e', source], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SECRET_KEY,
      DATA_DIR: dataDir,
      QM_HOST: 'nas.local',
      DOCKER_ACCESS_MAX: 'shell',
      ...extra,
    },
    encoding: 'utf8',
  });
}

const SEED = `
  const a = await import('./src/docker-access.js');
  console.log(JSON.stringify(a.setDockerAccessMode('manage').ok));
`;

const READ = `
  const a = await import('./src/docker-access.js');
  console.log(JSON.stringify(a.dockerAccessState().mode));
`;

test('preserves disk and memory after pre-rename failure', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, SEED).status, 0);
  const file = join(dataDir, 'qm-docker-access-v1.json');
  const before = readFileSync(file, 'utf8');
  const out = run(
    dataDir,
    `
      const a = await import('./src/docker-access.js');
      const attempt = a.setDockerAccessMode('shell');
      console.log(JSON.stringify({ ok: attempt.ok, memory: a.dockerAccessState().mode }));
    `,
    { QM_FAIL_RENAME_SUFFIX: 'qm-docker-access-v1.json' },
    ['--require', './test/helpers/fail-rename.cjs'],
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { ok: false, memory: 'manage' });
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('commits mode and reports post-rename durability failure', () => {
  const dataDir = tempDir();
  assert.equal(run(dataDir, SEED).status, 0);
  const out = run(
    dataDir,
    `
      const a = await import('./src/docker-access.js');
      let threw = null;
      try { a.setDockerAccessMode('shell'); } catch (error) { threw = error.code; }
      let readAfter = null;
      try { a.dockerAccessState(); } catch (error) { readAfter = error.code; }
      console.log(JSON.stringify({ threw, readAfter }));
    `,
    { QM_FAIL_DIRFSYNC_DIR: dataDir },
    ['--require', './test/helpers/fail-dirfsync.cjs'],
  );
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {
    threw: 'QM_DOCKER_ACCESS_DURABILITY_UNCERTAIN',
    readAfter: 'QM_DOCKER_ACCESS_INVALID',
  });
  const reread = run(dataDir, READ);
  assert.equal(reread.status, 0, reread.stderr);
  assert.equal(JSON.parse(reread.stdout), 'shell');
});
