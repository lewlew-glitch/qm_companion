
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, hkdfSync } from 'node:crypto';

const SECRET_KEY = '55'.repeat(32);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = readFileSync(join(projectRoot, 'scripts', 'check-state.mjs'), 'utf8');
const roots = [];

test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function tempDir(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function macEnvelope(state) {
  const payload = JSON.stringify(state);
  const stateKey = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET_KEY, 'hex'), Buffer.alloc(0), 'qm-companion:state', 32));
  const mac = createHmac('sha256', stateKey).update('qm-companion:state:v2\0').update(payload, 'utf8').digest('hex');
  return JSON.stringify({ version: 2, payload, mac });
}

const BASE_STATE = {
  installationId: '22222222-2222-4222-8222-222222222222',
  owner: null,
  services: [],
  prefs: {},
  apiTokens: [],
  cron: null,
};

const storeModule = join(projectRoot, 'src', 'store.js');

function checkEnv(overrides = {}) {
  return {
    ...process.env,
    SECRET_KEY,
    QM_HOST: 'nas.local',
    STORE_MODULE: storeModule,
    ...overrides,
  };
}

function runCheck(stateFileContent, overrides = {}) {
  const src = tempDir('qm-check-src-');
  const scratchRoot = tempDir('qm-check-scratch-');
  const stateFile = join(src, 'qm-companion.json');
  writeFileSync(stateFile, stateFileContent);
  const env = checkEnv({ STATE_FILE: stateFile, SCRATCH_ROOT: scratchRoot, ...overrides.env });
  if (overrides.dropScratch) delete env.SCRATCH_ROOT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: projectRoot,
    input: SCRIPT,
    env,
    encoding: 'utf8',
  });
  return { status: result.status, out: result.stdout + result.stderr, scratchRoot, stateFile, src };
}

function runCheckAsync(env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--input-type=module', '-'], { cwd: projectRoot, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolveRun({ status: code, out }));
    child.stdin.end(SCRIPT);
  });
}

test('validates current state and cleans scratch files', () => {
  const { status, out, scratchRoot } = runCheck(macEnvelope(BASE_STATE));
  assert.equal(status, 0, out);
  assert.match(out, /mac: VERIFIED/);
  assert.match(out, /state: ACCEPTED/);
  assert.match(out, /sections: installationId owner services prefs apiTokens cron/);
  assert.match(out, /stackOps: absent/);
  assert.match(out, /verdict: VERIFIED/);
  assert.deepEqual(readdirSync(scratchRoot), []);
});

test('rejects an invalid MAC without payload output', () => {
  const envelope = JSON.parse(macEnvelope(BASE_STATE));
  envelope.mac = envelope.mac.replace(/^./, envelope.mac[0] === '0' ? '1' : '0');
  const { status, out } = runCheck(JSON.stringify(envelope));
  assert.notEqual(status, 0);
  assert.match(out, /authentication failed/);
  assert.doesNotMatch(out, /sections:|stackOps:/);
  assert.doesNotMatch(out, /installationId/);
});

test('rejects a malformed MAC during envelope validation', () => {
  for (const mac of ['zz'.repeat(32), 'abc', '', 42]) {
    const envelope = JSON.parse(macEnvelope(BASE_STATE));
    envelope.mac = mac;
    const { status, out } = runCheck(JSON.stringify(envelope));
    assert.notEqual(status, 0, String(mac));
    assert.match(out, /not 64 hexadecimal|not a string/i);
    assert.doesNotMatch(out, /sections:/);
  }
});

test('rejects stackOps with fixed output and cleanup', () => {
  const { status, out, scratchRoot } = runCheck(macEnvelope({
    ...BASE_STATE,
    stackOps: [{ at: 1, stack: 'media', op: 'deploy', ok: true, note: '' }],
  }));
  assert.notEqual(status, 0);
  assert.match(out, /mac: VERIFIED/, 'the mac is genuine, the structure is the problem');
  assert.match(out, /stackOps: present/);
  assert.match(out, /verdict: FAILED/);
  assert.doesNotMatch(out, /sections:/);
  assert.doesNotMatch(out, /deploy|media/);
  assert.deepEqual(readdirSync(scratchRoot), []);
});

test('redacts rejected top-level field names', () => {
  const { status, out } = runCheck(macEnvelope({ ...BASE_STATE, mystery: [] }));
  assert.notEqual(status, 0);
  assert.match(out, /mac: VERIFIED/);
  assert.match(out, /verdict: FAILED/);
  assert.doesNotMatch(out, /mystery/);
});

test('redacts malicious key names', () => {
  const evil = '\u001b[31mEVIL_SECRET_abcdef1234567890';
  const { status, out } = runCheck(macEnvelope({ ...BASE_STATE, [evil]: 'hunter2value' }));
  assert.notEqual(status, 0);
  assert.doesNotMatch(out, /EVIL_SECRET/);
  assert.doesNotMatch(out, /hunter2value/);
  assert.equal(out.includes('\u001b'), false, 'no terminal control byte reaches the output');
});

test('rejects an authenticated malformed payload', () => {
  const payload = 'not json at all';
  const stateKey = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET_KEY, 'hex'), Buffer.alloc(0), 'qm-companion:state', 32));
  const mac = createHmac('sha256', stateKey).update('qm-companion:state:v2\0').update(payload, 'utf8').digest('hex');
  const { status, out } = runCheck(JSON.stringify({ version: 2, payload, mac }));
  assert.notEqual(status, 0);
  assert.match(out, /mac: VERIFIED/);
  assert.match(out, /verdict: FAILED/);
});

test('rejects invalid envelope versions and types', () => {
  const good = JSON.parse(macEnvelope(BASE_STATE));
  for (const content of [JSON.stringify({ ...good, version: 3 }), '"just a string"', '[]', 'not json']) {
    const { status, out } = runCheck(content);
    assert.notEqual(status, 0, content.slice(0, 20));
    assert.doesNotMatch(out, /sections:/);
  }
});

test('missing scratch configuration is refused', () => {
  const { status, out } = runCheck(macEnvelope(BASE_STATE), { dropScratch: true });
  assert.notEqual(status, 0);
  assert.match(out, /SCRATCH_ROOT/);
});

test('a symlinked state file is refused', () => {
  const src = tempDir('qm-check-link-src-');
  const real = join(src, 'real.json');
  writeFileSync(real, macEnvelope(BASE_STATE));
  const link = join(src, 'qm-companion.json');
  symlinkSync(real, link);
  const scratchRoot = tempDir('qm-check-link-scratch-');
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: projectRoot,
    input: SCRIPT,
    env: checkEnv({ STATE_FILE: link, SCRATCH_ROOT: scratchRoot }),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /symlink/);
});

test('a symlinked scratch root is refused', () => {
  const src = tempDir('qm-check-slr-src-');
  const stateFile = join(src, 'qm-companion.json');
  writeFileSync(stateFile, macEnvelope(BASE_STATE));
  const realScratch = tempDir('qm-check-slr-real-');
  const holder = tempDir('qm-check-slr-holder-');
  const link = join(holder, 'scratch-link');
  symlinkSync(realScratch, link);
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: projectRoot,
    input: SCRIPT,
    env: checkEnv({ STATE_FILE: stateFile, SCRATCH_ROOT: link }),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /symlink/);
});

test('rejects scratch roots inside the state directory', () => {
  const src = tempDir('qm-check-inside-');
  const stateFile = join(src, 'qm-companion.json');
  writeFileSync(stateFile, macEnvelope(BASE_STATE));
  for (const bad of [src, join(src, 'nested')]) {
    mkdirSync(bad, { recursive: true });
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: projectRoot,
      input: SCRIPT,
      env: checkEnv({ STATE_FILE: stateFile, SCRATCH_ROOT: bad }),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, bad);
    assert.match(result.stdout + result.stderr, /live state directory/);
  }
});

test('isolates concurrent runs in one scratch root', async () => {
  const src = tempDir('qm-check-conc-src-');
  const stateFile = join(src, 'qm-companion.json');
  writeFileSync(stateFile, macEnvelope(BASE_STATE));
  const scratchRoot = tempDir('qm-check-conc-scratch-');
  const env = checkEnv({ STATE_FILE: stateFile, SCRATCH_ROOT: scratchRoot });
  const [a, b] = await Promise.all([runCheckAsync(env), runCheckAsync(env)]);
  assert.equal(a.status, 0, a.out);
  assert.equal(b.status, 0, b.out);
  assert.match(a.out, /verdict: VERIFIED/);
  assert.match(b.out, /verdict: VERIFIED/);
  assert.deepEqual(readdirSync(scratchRoot), [], 'temporary directories were not removed');
});

function buildRichEnvelope() {
  const richDir = tempDir('qm-check-rich-');
  const build = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const s = await import('./src/store.js');
    const sec = await import('./src/secrets.js');
    s.claimOwner({ saltHex: 'ab'.repeat(16), hashHex: 'cd'.repeat(64), createdAt: Date.now(), mfaEnc: sec.seal(JSON.stringify({ secretHex: '11'.repeat(10), recovery: [] }), 'owner-mfa') });
    s.saveService({ id: 'radarr-1', kind: 'radarr', baseUrl: 'http://10.0.0.2:7878', label: 'Radarr HD' }, { apiKey: 'k'.repeat(32) });
    s.saveManagedStack('media', 'services:\\n  radarr:\\n    image: lscr.io/linuxserver/radarr:latest\\n');
    if (!s.setMintedKey('radarr-1', { kind: 'radarr', apiKey: 'm'.repeat(32), createdBy: 'mint' })) throw new Error('mint refused');
    s.setCron([]);
  `], {
    cwd: projectRoot,
    env: { ...process.env, SECRET_KEY, QM_HOST: 'nas.local', DATA_DIR: richDir },
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr);
  return JSON.parse(readFileSync(join(richDir, 'qm-companion.json'), 'utf8'));
}

function corruptSealed(sealed) {
  return sealed.replace(/[0-9a-f]/g, (c) => (c === 'f' ? '0' : (parseInt(c, 16) + 1).toString(16)));
}

test('rejects undecryptable sections and accepts intact state', () => {
  const rich = buildRichEnvelope();
  const payload = () => JSON.parse(rich.payload);

  const variants = {
    cron: (p) => { p.cron.sealed = corruptSealed(p.cron.sealed); },
    'managed stacks': (p) => { p.stacks.managed.sealed = corruptSealed(p.stacks.managed.sealed); },
    'minted keys': (p) => { p.mintedKeys.keys['radarr-1'].sealed = corruptSealed(p.mintedKeys.keys['radarr-1'].sealed); },
    'owner mfa': (p) => { p.owner.mfaEnc = corruptSealed(p.owner.mfaEnc); },
    'service secrets': (p) => { p.services[0].secretsEnc = corruptSealed(p.services[0].secretsEnc); },
  };

  for (const [label, mutate] of Object.entries(variants)) {
    const mutated = payload();
    mutate(mutated);
    const { status, out, scratchRoot } = runCheck(macEnvelope(mutated));
    assert.notEqual(status, 0, `${label}: an undecryptable blob must fail the gate`);
    assert.match(out, /mac: VERIFIED/, `${label}: the envelope itself is genuine`);
    assert.match(out, /could not read all protected state/, `${label}: the fixed protected-state verdict is used`);
    assert.doesNotMatch(out, /verdict: VERIFIED/, label);
    assert.doesNotMatch(out, /sections:/, `${label}: no section list on failure`);
    assert.equal(out.includes(mutated.cron.sealed.slice(0, 24)), false, `${label}: no sealed blob fragment in output`);
    assert.doesNotMatch(out, /kkkkkkkk|mmmmmmmm|secretHex/, `${label}: no decrypted value in output`);
    assert.deepEqual(readdirSync(scratchRoot), [], `${label}: the scratch root is left empty`);
  }

  const intact = runCheck(macEnvelope(payload()));
  assert.equal(intact.status, 0, intact.out);
  assert.match(intact.out, /verdict: VERIFIED/);
  assert.match(intact.out, /sections: .*services.*cron.*stacks.*mintedKeys/, 'the rich sections are reported by name only');
  assert.doesNotMatch(intact.out, /kkkkkkkk|mmmmmmmm|secretHex/, 'no decrypted value in the success output');
  assert.deepEqual(readdirSync(intact.scratchRoot), [], 'the scratch root is left empty on success');
});

test('contains state validation import failures and cleans scratch files', () => {
  const { status, out, scratchRoot } = runCheck(macEnvelope(BASE_STATE), { env: { QM_HOST: 'bad host with spaces' } });
  assert.notEqual(status, 0);
  assert.match(out, /state validation process failed/, 'expected controlled failure');
  assert.doesNotMatch(out, /QM_HOST|whitespace/);
  assert.doesNotMatch(out, /verdict: VERIFIED/);
  assert.deepEqual(readdirSync(scratchRoot), []);
});
