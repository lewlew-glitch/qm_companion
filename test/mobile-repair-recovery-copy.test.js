
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSelfSignedCertificate } from '../src/mobile/x509.js';
import { tlsPaths } from '../src/mobile/cert.js';

const projectRoot = join(import.meta.dirname, '..');
const SECRET_KEY = 'ab'.repeat(32);
const HOST = '192.168.1.11';
const PORT = 8788;
const MOBILE_OVERLAY = 'docker-compose.mobile.yml';
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'qm-repair-copy-'));
  roots.push(root);
  return root;
}

function env(dataDir, extra = {}) {
  const inherited = { ...process.env };
  for (const name of ['QM_CLONE_AS_NEW', 'DOCKER_CONTROL', 'DOCKER_ACCESS_MAX', 'MIGRATE_V1_STATE']) delete inherited[name];
  const base = {
    ...inherited,
    SECRET_KEY,
    DATA_DIR: dataDir,
    QM_HOST: HOST,
    QM_ADVERTISED_ORIGIN: `https://${HOST}:${PORT}`,
    MOBILE_API_ENABLED: 'true',
    MOBILE_ENROLMENT_ENABLED: 'true',
    MOBILE_PORT: String(PORT),
    MOBILE_BIND_ADDRESS: '0.0.0.0',
    ...extra,
  };
  for (const [name, value] of Object.entries(base)) if (value === undefined) delete base[name];
  return base;
}

const url = (relative) => join(projectRoot, relative).replace(/\\/g, '/');
const mobileGuide = () => readFileSync(join(projectRoot, 'docs', 'mobile-connection.md'), 'utf8');
const recoveryGuide = () => readFileSync(join(projectRoot, 'docs', 'recovery.md'), 'utf8');
const tlsGuide = () => readFileSync(join(projectRoot, 'docs', 'tls-and-certificates.md'), 'utf8');
const overlay = () => readFileSync(join(projectRoot, MOBILE_OVERLAY), 'utf8');

/** Normalize continued shell commands for comparison. */
const oneLine = (text) => text.replace(/\\\n\s*/g, ' ').replace(/[ \t]+/g, ' ');

function repair(dataDir, extra = {}) {
  return spawnSync(process.execPath, ['src/mobile/repair.js'], { cwd: projectRoot, env: env(dataDir, extra), encoding: 'utf8' });
}

function provision(dataDir) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { loadMobileState } = await import('${url('src/mobile/store.js')}');
    const { setDockerAccessMode } = await import('${url('src/docker-access.js')}');
    const { ensureMobileCertificate } = await import('${url('src/mobile/cert.js')}');
    loadMobileState();
    const saved = setDockerAccessMode('read');
    if (!saved.ok) throw new Error(saved.error);
    const made = ensureMobileCertificate({ dataDir: ${JSON.stringify(dataDir)}, host: ${JSON.stringify(HOST)} });
    if (!made.ok) throw new Error(made.reason);
  `], { cwd: projectRoot, env: env(dataDir), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

/** Read the repair command from process output. */
function printedRepairCommand() {
  const result = repair(tempDir());
  const line = result.stdout.split('\n').find((row) => row.includes('src/mobile/repair.js') && row.includes('docker'));
  assert.ok(line, `the command is printed:\n${result.stdout}`);
  return line.trim();
}

const composeFilesIn = (command) => [...command.matchAll(/-f\s+(\S+)/g)].map((found) => found[1]);

test('prints the deployed Compose file list in order', () => {
  const command = printedRepairCommand();
  const files = composeFilesIn(command);

  assert.ok(files.length >= 2, `the command carries an -f list: ${command}`);
  for (const file of files) {
    assert.ok(existsSync(join(projectRoot, file)), `${file} is a file this repository ships`);
  }
  assert.equal(files[0], 'docker-compose.example.yml', 'the base install file comes first');
  assert.equal(files.at(-1), MOBILE_OVERLAY, 'the mobile overlay is last');
  assert.equal(new Set(files).size, files.length, 'no file is repeated');
  assert.match(overlay(), /Apply this file after every Compose file that changes `ports`/);
  assert.match(command, /docker compose (-f \S+ )+run --rm --no-deps --entrypoint node companion src\/mobile\/repair\.js/);
});

test('repair output matches the mobile guide', () => {
  const files = composeFilesIn(printedRepairCommand());
  const documented = oneLine(mobileGuide())
    .split('\n')
    .filter((line) => line.includes('docker compose') && line.includes('up -d') && line.includes(MOBILE_OVERLAY))
    .map((line) => composeFilesIn(line));

  assert.ok(documented.length > 0);
  for (const list of documented) {
    assert.equal(list.at(-1), MOBILE_OVERLAY, `every documented mobile deployment keeps the overlay last: ${list.join(' ')}`);
  }
  assert.ok(
    documented.some((list) => list.join(' ') === files.join(' ')),
    `the repair command repeats a documented deployment list exactly. Printed: ${files.join(' ')}. Documented: ${documented.map((list) => list.join(' ')).join(' | ')}`,
  );
});

test('recovery commands match repair output', () => {
  const printed = printedRepairCommand();
  const text = oneLine(recoveryGuide());
  assert.ok(text.includes(printed), `the recovery guide carries the printed command verbatim: ${printed}`);
  assert.match(text, /same list this installation is deployed with, in the same order/);
  assert.match(text, /Include `docker-compose\.mobile\.yml` after every file that changes `ports`/);
});

test('reports the mobile plane off when the mobile overlay is omitted', () => {
  const environment = overlay().split(/^\s*environment:\s*$/m)[1] ?? '';
  const supplied = [...environment.matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)].map((found) => found[1]);
  assert.ok(supplied.includes('MOBILE_API_ENABLED') && supplied.includes('QM_ADVERTISED_ORIGIN'), supplied.join(', '));

  const dataDir = tempDir();
  provision(dataDir);
  assert.equal(repair(dataDir).status, 0);

  const without = Object.fromEntries(supplied.map((name) => [name, undefined]));
  const missing = repair(dataDir, without);
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stdout, /Mobile listener plan:\s+refused/);
  assert.match(missing.stdout, /MOBILE_API_ENABLED is not true/);
});


/** Text that mentions exec only to reject it. */
const REFUSAL = '`docker exec` requires\na running container.';
const EXEC_INSTRUCTION = /docker (compose (-f \S+ )*)?exec/;

function assertNoExecInstruction(stdout, what) {
  const withoutRefusal = stdout.split(REFUSAL).join('');
  const found = EXEC_INSTRUCTION.exec(withoutRefusal);
  assert.equal(found, null, `${what} prints an exec instruction, which needs a running container: ${found && withoutRefusal.slice(Math.max(0, found.index - 120), found.index + 160)}`);
}

test('omits exec instructions from repair diagnoses', () => {
  const cases = [];

  const healthy = tempDir();
  provision(healthy);
  cases.push(['a healthy volume', repair(healthy)]);
  cases.push(['a wrong SECRET_KEY', repair(healthy, { SECRET_KEY: 'cd'.repeat(32) })]);

  const moved = tempDir();
  provision(moved);
  const paths = tlsPaths(moved);
  const built = buildSelfSignedCertificate({ host: '192.168.1.21' });
  writeFileSync(paths.certPath, built.certPem);
  writeFileSync(paths.keyPath, built.keyPem, { mode: 0o600 });
  cases.push(['a certificate that no longer names the origin', repair(moved)]);

  const broken = tempDir();
  provision(broken);
  writeFileSync(join(broken, 'qm-mobile-v1.json'), '{"version":1,"payload":"{}","mac":"00"}');
  const unreadable = repair(broken);
  assert.match(unreadable.stdout, /Mobile state error:/, 'the fixture reaches the mobile failure line');
  cases.push(['an unreadable mobile sidecar', unreadable]);

  for (const [what, result] of cases) {
    assert.match(result.stdout, /docker compose (-f \S+ )+run --rm/, `${what} still offers the out-of-band form`);
    assertNoExecInstruction(result.stdout, what);
  }
});

test('omits exec guidance for stopped containers', () => {
  const text = oneLine(`${recoveryGuide()}\n${tlsGuide()}`);
  assert.doesNotMatch(text, /docker exec qm-companion node src\/mobile\/repair\.js/, 'the repair command is not an exec');
  assert.doesNotMatch(text, /docker exec qm-companion sh -lc/, 'the key-length check is not an exec either');
  assert.match(text, /run --rm --no-deps --entrypoint sh companion -lc 'printf "SECRET_KEY length/);

  const refuses = (line) => /`?docker( compose)? exec`? cannot/.test(line)
    || /\b(not|never) `?docker( compose)? exec`?/i.test(line);
  const execLines = text.split('\n').filter((line) => EXEC_INSTRUCTION.test(line) && !refuses(line));
  for (const line of execLines) {
    assert.match(line, /rotate-cert\.js --confirm/, `every remaining exec line in the recovery guides is the rotation command: ${line}`);
  }
  assert.match(text, /If the container is not up/);
  assert.match(text, /run --rm --no-deps --entrypoint node companion src\/mobile\/rotate-cert\.js --confirm/);
});
