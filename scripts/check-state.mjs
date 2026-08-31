// Read-only validator for qm-companion.json. It authenticates a temporary copy and prints only
// allow-listed metadata.
//
// Environment: STATE_FILE (default /data/qm-companion.json), SCRATCH_ROOT (required), STORE_MODULE
// (default /app/src/store.js), and SECRET_KEY.

import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Canonical sections that may be printed after state validation.
const KNOWN_SECTIONS = new Set(['installationId', 'owner', 'services', 'prefs', 'apiTokens', 'cron', 'updates', 'stacks', 'templates', 'mintedKeys', 'auditLog']);

class Fail extends Error {}
function fail(message) {
  console.log(`verdict: FAILED - ${message}`);
  throw new Fail();
}

let scratchDir = null;

async function main() {
  if (!process.env.SECRET_KEY || !/^[0-9a-f]{64}$/i.test(process.env.SECRET_KEY)) fail('SECRET_KEY is not available to derive the state key');

  // Validate live and scratch paths before reading state.
  const stateFile = resolve(process.env.STATE_FILE || '/data/qm-companion.json');
  let stateStat;
  try {
    stateStat = lstatSync(stateFile);
  } catch {
    fail('the state file does not exist');
  }
  if (stateStat.isSymbolicLink()) fail('the state file is a symlink, which is refused');
  if (!stateStat.isFile()) fail('the state file is not a regular file');
  const liveDir = realpathSync(dirname(stateFile));

  if (!process.env.SCRATCH_ROOT) fail('SCRATCH_ROOT must name a temporary directory');
  const scratchRootGiven = resolve(process.env.SCRATCH_ROOT);
  let scratchStat;
  try {
    scratchStat = lstatSync(scratchRootGiven);
  } catch {
    fail('SCRATCH_ROOT does not exist');
  }
  if (scratchStat.isSymbolicLink()) fail('SCRATCH_ROOT is a symlink, which is refused');
  if (!scratchStat.isDirectory()) fail('SCRATCH_ROOT is not a directory');
  const scratchRoot = realpathSync(scratchRootGiven);
  if (scratchRoot === liveDir || scratchRoot.startsWith(liveDir + sep)) fail('SCRATCH_ROOT must not be the live state directory or inside it');
  if (scratchRoot === '/data' || scratchRoot.startsWith(`/data${sep}`)) fail('SCRATCH_ROOT must not be inside /data');

  // Read once and validate the envelope.
  let raw;
  try {
    raw = readFileSync(stateFile, 'utf8');
  } catch {
    fail('the state file could not be read');
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    fail('the envelope is not valid JSON');
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) fail('the envelope is not an object');
  if (envelope.version !== 2) fail('the envelope version is not 2');
  if (typeof envelope.payload !== 'string') fail('the payload is not a string');
  if (typeof envelope.mac !== 'string' || !/^[0-9a-f]{64}$/i.test(envelope.mac)) fail('the mac is not 64 hexadecimal characters');

  // Authenticate before parsing the payload.
  const stateKey = Buffer.from(hkdfSync('sha256', Buffer.from(process.env.SECRET_KEY, 'hex'), Buffer.alloc(0), 'qm-companion:state', 32));
  const expected = createHmac('sha256', stateKey).update('qm-companion:state:v2\0').update(envelope.payload, 'utf8').digest();
  const supplied = Buffer.from(envelope.mac, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('authentication failed: the mac does not match this SECRET_KEY');
  console.log('mac: VERIFIED');

  // Copy the authenticated bytes to an isolated directory.
  scratchDir = mkdtempSync(join(scratchRoot, 'qm-state-check-'));
  writeFileSync(join(scratchDir, 'qm-companion.json'), raw, { flag: 'wx', mode: 0o600 });

  // Load the state in a child so process.exit cannot bypass parent cleanup. The child checks the
  // canonical state and encrypted sections, then returns a fixed marker.
  const storeModule = resolve(process.env.STORE_MODULE || '/app/src/store.js');
  const moduleDir = dirname(storeModule);
  const CHILD_SOURCE = [
    "const store = await import(process.env.QM_CHECK_STATE_MODULE_URL);",
    "try { store.hasOwner(); } catch { console.log('QM_CHECK_STATE_REFUSED'); process.exit(3); }",
    'try {',
    '  store.getCron();',
    '  store.getManagedStacks();',
    '  store.getMintedKeys();',
    '  const secrets = await import(process.env.QM_CHECK_CRYPTO_MODULE_URL);',
    "  const fs = await import('node:fs');",
    "  const payload = JSON.parse(JSON.parse(fs.readFileSync(process.env.QM_CHECK_STATE_PATH, 'utf8')).payload);",
    "  const jsonObject = (text) => { const v = JSON.parse(text); if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape'); };",
    '  if (payload.owner && payload.owner.mfaEnc) {',
    "    const mfa = secrets.open(payload.owner.mfaEnc, 'owner-mfa');",
    "    if (mfa === null) throw new Error('mfa');",
    '    jsonObject(mfa);',
    '  }',
    '  for (const row of payload.services || []) {',
    '    if (!row.secretsEnc) continue;',
    '    const opened = secrets.open(row.secretsEnc, row.id);',
    "    if (opened === null) throw new Error('service');",
    '    jsonObject(opened);',
    '  }',
    "} catch { console.log('QM_CHECK_STATE_PROTECTED'); process.exit(4); }",
    "console.log('QM_CHECK_STATE_ACCEPTED');",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE], {
    env: {
      ...process.env,
      DATA_DIR: scratchDir,
      QM_CHECK_STATE_MODULE_URL: pathToFileURL(storeModule).href,
      QM_CHECK_CRYPTO_MODULE_URL: pathToFileURL(join(moduleDir, 'secrets.js')).href,
      QM_CHECK_STATE_PATH: join(scratchDir, 'qm-companion.json'),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  // Do not forward child output; accept only the fixed marker protocol.
  const childOut = String(child.stdout || '').trim();
  let refusal;
  if (child.status === 0 && childOut === 'QM_CHECK_STATE_ACCEPTED') {
    refusal = null;
  } else if (child.status === 3 && childOut === 'QM_CHECK_STATE_REFUSED') {
    refusal = 'refused';
  } else if (child.status === 4 && childOut === 'QM_CHECK_STATE_PROTECTED') {
    fail('the state module could not read all protected state');
  } else {
    fail('the state validation process failed');
  }

  // Print section names only after validation.
  let keys = null;
  try {
    const parsed = JSON.parse(envelope.payload);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) keys = Object.keys(parsed);
  } catch {
    keys = null;
  }
  if (refusal !== null) {
    if (keys && keys.includes('stackOps')) console.log('stackOps: present');
    fail('the state module refused this state');
  }
  if (!keys) fail('the payload authenticated but is not a JSON object');
  const unknown = keys.filter((key) => !KNOWN_SECTIONS.has(key));
  if (unknown.length) fail('the accepted payload contains a section outside the allowed set');
  console.log(`sections: ${keys.join(' ')}`);
  console.log('stackOps: absent');
  console.log('state: ACCEPTED');
  console.log('verdict: VERIFIED');
}

try {
  await main();
} catch (error) {
  if (!(error instanceof Fail)) console.log('verdict: FAILED - unexpected error');
  process.exitCode = 1;
} finally {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
}
