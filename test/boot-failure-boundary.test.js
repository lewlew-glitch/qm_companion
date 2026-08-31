
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac, hkdfSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(projectRoot, 'src', 'index.js');
const SECRET_KEY = '55'.repeat(64 / 2);
const OTHER_KEY = 'aa'.repeat(32);
const CANARY = 'CANARY-b4f0c1d2e3-do-not-print';
const dirs = [];

test.after(() => {
  for (const dir of dirs) {
    try { chmodSync(join(dir, 'qm-companion.json'), 0o600); } catch {  }
    rmSync(dir, { recursive: true, force: true });
  }
});

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qm-boot-'));
  dirs.push(dir);
  return dir;
}

function sealed(state, key) {
  const payload = JSON.stringify(state);
  const stateKey = Buffer.from(hkdfSync('sha256', Buffer.from(key, 'hex'), Buffer.alloc(0), 'qm-companion:state', 32));
  const mac = createHmac('sha256', stateKey).update('qm-companion:state:v2\0').update(payload, 'utf8').digest('hex');
  return JSON.stringify({ version: 2, payload, mac });
}

function baseState() {
  return {
    installationId: '22222222-2222-4222-8222-222222222222',
    owner: null,
    services: [],
    prefs: {},
    apiTokens: [],
    cron: null,
  };
}

async function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Run the application entry point to completion. */
function boot(env, { port = 45999 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        SECRET_KEY,
        QM_HOST: '127.0.0.1',
        BIND_ADDRESS: '127.0.0.1',
        PORT: String(port),
        ...env,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function assertNoRawTrace(text) {
  assert.ok(!/\n\s+at /.test(text), 'a V8 stack frame reached the log');
  assert.ok(!text.includes('file:///'), 'a module URL reached the log');
  assert.ok(!text.includes('ModuleJob'), 'an ES module loader frame reached the log');
  assert.ok(!text.includes('node:internal'), 'a Node internal frame reached the log');
  assert.ok(!text.includes('Node.js v'), 'the default crash footer reached the log');
  assert.ok(!text.includes(projectRoot), 'the install path reached the log');
  assert.ok(!text.includes('src/store.js'), 'a source file and line reached the log');
}

function assertNoHostPath(text, dir) {
  assert.ok(!text.includes(dir), 'the host data directory path reached the log');
  assert.ok(!text.includes('qm-mobile-v1.json'), 'a second host file path reached the log');
}

function assertNothingSecret(text) {
  assert.ok(!text.includes(SECRET_KEY), 'the SECRET_KEY value reached the log');
  assert.ok(!text.includes(CANARY), 'state file content reached the log');
}

function assertBootFailure(result, { code, label }) {
  assert.equal(result.code, 1);
  assertNoRawTrace(result.err);
  assertNothingSecret(result.err);
  assertNothingSecret(result.out);
  assert.match(result.err, new RegExp(`code ${code}, label ${label}`));
  assert.ok(result.err.startsWith('\n  QM Companion '), 'the failure is not formatted like die()');
  assert.match(result.err, /\n  Cause:/);
  assert.match(result.err, /\n  Action:/);
}

test('rejects malformed state without logging file contents', async () => {
  const dir = dataDir();
  writeFileSync(join(dir, 'qm-companion.json'), `${CANARY} not json at all`);
  const result = await boot({ DATA_DIR: dir });
  assertBootFailure(result, { code: 'QM_STATE_INVALID', label: 'boot-state-not-companion' });
  assert.match(result.err, /Cause: .*not in the Companion state format/);
  assert.match(result.err, /DATA_DIR/);
  assertNoHostPath(result.err, dir);
  assert.ok(!result.err.includes('CANARY'), 'the parse cause echoed the file');
});

test('reports state auth mismatch before recovery options', async () => {
  const dir = dataDir();
  const state = baseState();
  state.prefs = { theme: 'dark' };
  writeFileSync(join(dir, 'qm-companion.json'), sealed(state, OTHER_KEY));
  const result = await boot({ DATA_DIR: dir });
  assertBootFailure(result, { code: 'QM_STATE_INVALID', label: 'boot-state-key-mismatch' });
  assertNoHostPath(result.err, dir);
  assert.match(result.err, /Action: Restore the SECRET_KEY previously used/);
  assert.match(result.err, /Warning: Do not delete qm-companion\.json/);
  assert.doesNotMatch(result.err, /is intact/);
  assert.match(result.err, /cannot distinguish a changed key from a damaged or replaced state file/);
  const keyAt = result.err.indexOf('Action: Restore the SECRET_KEY');
  const moveAt = result.err.indexOf('Fallback: If the key cannot be recovered');
  assert.ok(keyAt > 0 && moveAt > keyAt, 'key restoration is offered before file removal');
});

test('reports unreadable state with permission recovery', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root can read a 000 file');
  const dir = dataDir();
  const file = join(dir, 'qm-companion.json');
  writeFileSync(file, sealed(baseState(), SECRET_KEY));
  chmodSync(file, 0o000);
  const result = await boot({ DATA_DIR: dir });
  assertBootFailure(result, { code: 'QM_STATE_INVALID', label: 'boot-state-unreadable' });
  assertNoHostPath(result.err, dir);
  assert.match(result.err, /EACCES/);
  assert.match(result.err, /read and write access/);
  assert.match(result.err, /Warning: Do not delete qm-companion\.json/);
});

test('reports authenticated state with unsupported contents', async () => {
  const dir = dataDir();
  const state = baseState();
  state.owner = { saltHex: 'not-a-salt', hashHex: CANARY };
  writeFileSync(join(dir, 'qm-companion.json'), sealed(state, SECRET_KEY));
  const result = await boot({ DATA_DIR: dir });
  assertBootFailure(result, { code: 'QM_STATE_INVALID', label: 'boot-state-contents' });
  assertNoHostPath(result.err, dir);
  assert.match(result.err, /authenticated with SECRET_KEY/);
  assert.match(result.err, /owner password record is invalid/);
  assert.match(result.err, /Warning: Do not delete qm-companion\.json/);
});

test('reports invalid SETUP_TOKEN without logging its value', async () => {
  const secretish = 'nope!!';
  const result = await boot({ DATA_DIR: dataDir(), SETUP_TOKEN: secretish });
  assert.equal(result.code, 1);
  assertNoRawTrace(result.err);
  assert.ok(!result.err.includes(secretish), 'the rejected SETUP_TOKEN value was printed');
  assert.match(result.err, /code SETUP_TOKEN_INVALID, label boot-setup-token-invalid/);
  assert.match(result.err, /6 characters long, under the 32 minimum/);
  assert.match(result.err, /outside A-Z, a-z, 0-9, - and _/);
  assert.match(result.err, /docker-compose file/);
  assert.match(result.err, /\.env file/);
  assert.ok(result.err.startsWith('\n  QM Companion '), 'the failure is not formatted like die()');
});

test('reports blank SETUP_TOKEN with removal guidance', async () => {
  const result = await boot({ DATA_DIR: dataDir(), SETUP_TOKEN: '' });
  assert.equal(result.code, 1);
  assertNoRawTrace(result.err);
  assert.match(result.err, /code SETUP_TOKEN_EMPTY, label boot-setup-token-empty/);
  assert.match(result.err, /Delete the SETUP_TOKEN line entirely/);
  assert.match(result.err, /not a short token, it is no token/);
  assert.ok(!/32 to 256/.test(result.err));
  assert.ok(!/32-256/.test(result.err));
});

test('reports EADDRINUSE with the configured address', async () => {
  const port = await freePort();
  const squatter = createServer();
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
  try {
    const result = await boot({ DATA_DIR: dataDir() }, { port });
    assertBootFailure(result, { code: 'EADDRINUSE', label: 'boot-port-in-use' });
    assert.match(result.err, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.match(result.err, /Set PORT to a free port/);
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});

test('imports boot-guard before other application modules', () => {
  const source = readFileSync(ENTRY, 'utf8');
  const imports = [...source.matchAll(/^import .*$/gmu)].map((match) => match[0]);
  assert.ok(imports.length > 1, 'the entry point no longer imports anything');
  assert.match(imports[0], /'\.\/boot-guard\.js'/);
});

test('preserves healthy startup behavior', async () => {
  const port = await freePort();
  const dir = dataDir();
  writeFileSync(join(dir, 'qm-companion.json'), sealed(baseState(), SECRET_KEY));
  const child = spawn(process.execPath, [ENTRY], {
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SECRET_KEY,
      QM_HOST: '127.0.0.1',
      BIND_ADDRESS: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dir,
    },
  });
  try {
    const line = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('startup timeout')), 15_000);
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('qm companion on http://')) {
          clearTimeout(timer);
          resolve(out);
        }
      });
      child.on('close', () => { clearTimeout(timer); reject(new Error('the Companion exited instead of listening')); });
    });
    assert.match(line, new RegExp(`http://localhost:${port}`));
  } finally {
    child.kill('SIGKILL');
  }
});

/** Inject an error directly into the boot guard. */
function bootThrowing(message, env = {}, code = 'QM_STATE_INVALID') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import ${JSON.stringify(join(projectRoot, 'src', 'boot-guard.js'))};`
      + `const e = new Error(${JSON.stringify(message)}); e.code = ${JSON.stringify(code)}; throw e;`],
    { cwd: projectRoot, env: { PATH: process.env.PATH, ...env } });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, err }));
  });
}

const ALIEN = 'a message shape src/boot-guard.js did not write and cannot read';

test('does not infer a cause for unclassified state failures', async () => {
  const result = await bootThrowing(ALIEN);
  assert.equal(result.code, 1);
  assertNoRawTrace(result.err);
  assert.ok(!result.err.includes(ALIEN), 'an unrecognised message was printed verbatim');
  assert.match(result.err, /code QM_STATE_INVALID, label boot-state-unclassified/);
  assert.ok(!/authenticated with SECRET_KEY/.test(result.err), 'unclassified failure asserted key validity');
});

test('prints full failure details only when debug is enabled', async () => {
  const quiet = await bootThrowing(ALIEN);
  const loud = await bootThrowing(ALIEN, { QM_BOOT_DEBUG: 'true' });
  assertNoRawTrace(quiet.err);
  assert.match(quiet.err, /QM_BOOT_DEBUG=true/, 'debug guidance missing');
  assert.equal(loud.code, 1);
  assert.match(loud.err, /treat as sensitive/);
  assert.match(loud.err, /\n\s+at /);
  assert.ok(loud.err.includes(ALIEN));
});


const MARKER_FILE = 'qm-companion.v1-migration-used';

function v1State() {
  return JSON.stringify({
    version: 1,
    installationId: '44444444-4444-4444-8444-444444444444',
    owner: null,
    services: [],
    prefs: {},
    apiTokens: [],
    cron: null,
  });
}

function spendTheMigration(dir) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const s = await import('./src/store.js'); s.getInstallationId();"], {
    cwd: projectRoot,
    env: { PATH: process.env.PATH, SECRET_KEY, QM_HOST: '127.0.0.1', DATA_DIR: dir, MIGRATE_V1_STATE: 'true' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, MARKER_FILE)), 'migration marker was not created');
}

test('reports an unreadable migration marker', async () => {
  const dir = dataDir();
  writeFileSync(join(dir, 'qm-companion.json'), v1State());
  writeFileSync(join(dir, MARKER_FILE), 'not-a-hex-line\n');
  const result = await boot({ DATA_DIR: dir, MIGRATE_V1_STATE: 'true' });
  assert.equal(result.code, 1);
  assertNoHostPath(result.err, dir);
  assert.match(result.err, new RegExp(MARKER_FILE), 'migration marker filename missing');
  assert.match(result.err, /Detail: it is not one 64 character hexadecimal line/);
  assert.match(result.err, /Warning: Leave qm-companion\.json in place/);
  assert.match(result.err, /contains only the single-use migration record/);
  assertBootFailure(result, { code: 'QM_STATE_INVALID', label: 'boot-state-migration-marker' });
});

test('reports migration marker authentication mismatch', async () => {
  const dir = dataDir();
  writeFileSync(join(dir, 'qm-companion.json'), v1State());
  writeFileSync(join(dir, MARKER_FILE), `${'ab'.repeat(32)}\n`);
  const result = await boot({ DATA_DIR: dir, MIGRATE_V1_STATE: 'true' });
  assert.equal(result.code, 1);
  assertNoHostPath(result.err, dir);
  assert.match(result.err, /SECRET_KEY/);
  assert.match(result.err, new RegExp(MARKER_FILE), 'migration marker filename missing');
  assert.match(result.err, /cannot distinguish a changed key from a damaged or replaced marker/);
  const keyAt = result.err.indexOf('Action: Restore the SECRET_KEY');
  const deleteAt = result.err.indexOf(`delete ${MARKER_FILE}`);
  assert.ok(keyAt > 0 && deleteAt > keyAt, 'migration recovery actions are out of order');
  assert.match(result.err, /contains only the single-use migration record/);
  assertBootFailure(result, { code: 'QM_STATE_INVALID', label: 'boot-state-migration-marker-key' });
});

test('reports a spent v1 migration', async () => {
  const dir = dataDir();
  writeFileSync(join(dir, 'qm-companion.json'), v1State());
  spendTheMigration(dir);
  writeFileSync(join(dir, 'qm-companion.json'), v1State());
  const result = await boot({ DATA_DIR: dir, MIGRATE_V1_STATE: 'true' });
  assert.equal(result.code, 1);
  assertNoHostPath(result.err, dir);
  assert.match(result.err, new RegExp(MARKER_FILE), 'migration marker filename missing');
  assert.match(result.err, /qm-companion\.json/, 'state filename missing');
  assert.match(result.err, /unset\s+MIGRATE_V1_STATE/);
  assert.match(result.err, new RegExp(`delete ${MARKER_FILE}`), 'the re-run route is missing');
  assertBootFailure(result, { code: 'QM_STATE_INVALID', label: 'boot-state-migration-spent' });
});

test('reports the required first-time v1 migration action', async () => {
  const dir = dataDir();
  writeFileSync(join(dir, 'qm-companion.json'), v1State());
  const result = await boot({ DATA_DIR: dir });
  assert.equal(result.code, 1);
  assertNoHostPath(result.err, dir);
  assert.match(result.err, /MIGRATE_V1_STATE=true/);
  assert.match(result.err, /Action: Back up DATA_DIR/);
  assertBootFailure(result, { code: 'QM_STATE_INVALID', label: 'boot-state-migration-v1' });
});

test('reports rejected v1 state with migration enabled', async () => {
  const dir = dataDir();
  const stray = JSON.parse(v1State());
  stray.strayField = 1;
  writeFileSync(join(dir, 'qm-companion.json'), JSON.stringify(stray));
  const result = await boot({ DATA_DIR: dir, MIGRATE_V1_STATE: 'true' });
  assert.equal(result.code, 1);
  assertNoHostPath(result.err, dir);
  assert.match(result.err, /Detail: legacy format has unknown fields/);
  assert.match(result.err, /Migration was already enabled/);
  assert.doesNotMatch(result.err, /start the Companion once with MIGRATE_V1_STATE=true/,
    'migration action repeats the enabled setting');
  assert.match(result.err, /The file was not changed/);
  assertBootFailure(result, { code: 'QM_STATE_INVALID', label: 'boot-state-v1-refused' });
});


const ACCESS_FILE = 'qm-docker-access-v1.json';

function assertAccessResetImpact(text) {
  assert.match(text, new RegExp(ACCESS_FILE), 'Docker access filename missing');
  assert.match(text, /resets only the Docker access mode to Read only/);
  assert.match(text, /does not remove accounts, services, credentials, API tokens or paired phones/);
  assert.doesNotMatch(text, /label boot-unexpected/, 'Docker access error was not classified');
  assert.doesNotMatch(text, /Debug: Set QM_BOOT_DEBUG/);
}

test('classifies invalid Docker access state', async () => {
  const dir = dataDir();
  writeFileSync(join(dir, 'qm-companion.json'), sealed(baseState(), SECRET_KEY));
  writeFileSync(join(dir, ACCESS_FILE), `{ not json ${CANARY}`);
  const result = await boot({ DATA_DIR: dir });
  assert.equal(result.code, 1);
  assertNoHostPath(result.err, dir);
  assertAccessResetImpact(result.err);
  assert.match(result.err, /Detail: file is invalid JSON/);
  assert.ok(!result.err.includes(CANARY), 'the parse cause echoed the sidecar');
  assertBootFailure(result, { code: 'QM_DOCKER_ACCESS_INVALID', label: 'boot-docker-access-unreadable' });
});

test('reports Docker access authentication mismatch', async () => {
  const dir = dataDir();
  const seeded = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const a = await import('./src/docker-access.js'); a.setDockerAccessMode('manage');"], {
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SECRET_KEY: OTHER_KEY,
      QM_HOST: '127.0.0.1',
      DATA_DIR: dir,
      DOCKER_ACCESS_MAX: 'shell',
    },
    encoding: 'utf8',
  });
  assert.equal(seeded.status, 0, seeded.stderr);
  rmSync(join(dir, 'qm-companion.json'));

  const result = await boot({ DATA_DIR: dir, DOCKER_ACCESS_MAX: 'shell' });
  assert.equal(result.code, 1);
  assertNoHostPath(result.err, dir);
  assertAccessResetImpact(result.err);
  assert.match(result.err, /cannot distinguish a changed key from a damaged or replaced file/);
  assert.doesNotMatch(result.err, /is intact/, 'it claims an integrity a MAC check cannot prove');
  const keyAt = result.err.indexOf('Action: Restore the SECRET_KEY');
  const removeAt = result.err.indexOf(`remove ${ACCESS_FILE}`);
  assert.ok(keyAt > 0 && removeAt > keyAt, 'Docker access recovery actions are out of order');
  assertBootFailure(result, { code: 'QM_DOCKER_ACCESS_INVALID', label: 'boot-docker-access-key-mismatch' });
});

test('does not infer a cause for unclassified Docker access failures', async () => {
  const alien = 'a docker access message shape src/boot-guard.js did not write and cannot read';
  const result = await bootThrowing(alien, {}, 'QM_DOCKER_ACCESS_INVALID');
  assert.equal(result.code, 1);
  assertNoRawTrace(result.err);
  assert.ok(!result.err.includes(alien), 'an unrecognised message was printed verbatim');
  assert.match(result.err, /qm-docker-access-v1\.json/, 'Docker access filename missing');
  assert.match(result.err, /resets only the Docker access mode to Read only/);
  assert.match(result.err, /key, file and volume remain possible causes/);
  assert.match(result.err, /code QM_DOCKER_ACCESS_INVALID, label boot-docker-access-unclassified/);
});

const ACCESS_WRITE_MESSAGE = [
  'The Docker access mode could not be saved to /data/qm-docker-access-v1.json (EPERM).',
  'The previously selected mode is still in force, on disk and in memory, and no partial file was left behind.',
  'Make the data directory writable and check it has free space, then choose the mode again.',
].join(' ');

test('matches Docker access write classification', () => {
  const source = readFileSync(join(projectRoot, 'src', 'docker-access.js'), 'utf8');
  assert.match(source, /The Docker access mode could not be saved to \$\{FILE\} \(\$\{\(cause && cause\.code\) \|\| 'write failed'\}\)\./,
    'Docker access write prefix changed');
  assert.match(source, /\}\)\.`,\n\s+'The previously selected mode is still in force/,
    'Docker access write-code delimiter changed');
});

test('classifies Docker access write failures', async () => {
  const result = await bootThrowing(ACCESS_WRITE_MESSAGE, {}, 'QM_DOCKER_ACCESS_INVALID');
  assert.equal(result.code, 1);
  assertNoRawTrace(result.err);
  assert.ok(!result.err.includes('/data/qm-docker-access-v1.json'), 'the absolute path was echoed into the log');
  assert.doesNotMatch(result.err, /could not be loaded/, 'a file that read perfectly was called unloadable');
  assert.doesNotMatch(result.err, /was rejected/, 'a file that read perfectly was called rejected');
  assert.match(result.err, /could not be saved/, 'write failure summary missing');
  assert.match(result.err, /Detail: EPERM/);
  assert.match(result.err, /Action: Make DATA_DIR writable/);
  assert.match(result.err, /Warning: Restoring or removing qm-docker-access-v1\.json will not fix/);
  assert.match(result.err, /existing file is unchanged and no partial file was left behind/);
  assert.ok(result.err.startsWith('\n  QM Companion '), 'the failure is not formatted like die()');
  assert.match(result.err, /code QM_DOCKER_ACCESS_INVALID, label boot-docker-access-write-failed/);
});
