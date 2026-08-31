import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHmac, hkdfSync } from 'node:crypto';

const SECRET_KEY = '11'.repeat(32);
const roots = [];
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function tempData() {
  const path = mkdtempSync(join(tmpdir(), 'qm-store-test-'));
  roots.push(path);
  return path;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function run(dataDir, source, extraEnv = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectRoot,
    env: { ...process.env, SECRET_KEY, QM_HOST: 'nas.local', DATA_DIR: dataDir, ...extraEnv },
    encoding: 'utf8',
  });
}

test('first load writes authenticated state and a stable installation ID', () => {
  const dataDir = tempData();
  const result = run(dataDir, `
    const s = await import('./src/store.js');
    console.log(JSON.stringify([s.getInstallationId(), s.getInstallationId()]));
  `);
  assert.equal(result.status, 0, result.stderr);
  const [first, second] = JSON.parse(result.stdout.trim());
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/);
  const file = join(dataDir, 'qm-companion.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(envelope.version, 2);
  assert.match(envelope.mac, /^[0-9a-f]{64}$/);
  assert.equal(typeof envelope.payload, 'string');
});

test('owner claim has one winner and cannot replace the stored owner', () => {
  const dataDir = tempData();
  const result = run(dataDir, `
    const s = await import('./src/store.js');
    const a = { saltHex: 'aa'.repeat(16), hashHex: 'bb'.repeat(64), createdAt: 1 };
    const b = { saltHex: 'cc'.repeat(16), hashHex: 'dd'.repeat(64), createdAt: 2 };
    const first = s.claimOwner(a);
    const second = s.claimOwner(b);
    let clearRefused = false;
    try { s.setOwner(null); } catch { clearRefused = true; }
    console.log(JSON.stringify([first, second, clearRefused, s.getOwner()]));
  `);
  assert.equal(result.status, 0, result.stderr);
  const [first, second, clearRefused, owner] = JSON.parse(result.stdout.trim());
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(clearRefused, true);
  assert.equal(owner.hashHex, 'bb'.repeat(64));
});

test('a failed persistence attempt does not mutate the in-memory cache', () => {
  const dataDir = tempData();
  const result = run(dataDir, `
    const fs = await import('node:fs');
    const s = await import('./src/store.js');
    s.setPrefs({ theme: 'dark' });
    const parked = process.env.DATA_DIR + '.parked';
    fs.renameSync(process.env.DATA_DIR, parked);
    fs.writeFileSync(process.env.DATA_DIR, 'blocks the data directory');
    let failed = false;
    try { s.setPrefs({ theme: 'light' }); } catch { failed = true; }
    const theme = s.getPrefs().theme;
    fs.unlinkSync(process.env.DATA_DIR);
    fs.renameSync(parked, process.env.DATA_DIR);
    console.log(JSON.stringify({ failed, theme }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { failed: true, theme: 'dark' });
});

test('v1 migration requires opt-in and is one-way', () => {
  const dataDir = tempData();
  const file = join(dataDir, 'qm-companion.json');
  const legacy = JSON.stringify({
    version: 1,
    owner: { saltHex: 'aa'.repeat(16), hashHex: 'bb'.repeat(64) },
    services: [], prefs: {}, apiTokens: [], cron: null,
  });
  writeFileSync(file, legacy);
  let result = run(dataDir, `
    const s = await import('./src/store.js');
    console.log(JSON.stringify({ id: s.getInstallationId(), owner: s.hasOwner() }));
  `);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy v1 is unauthenticated/);
  assert.equal(readFileSync(file, 'utf8'), legacy);

  result = run(dataDir, `
    const s = await import('./src/store.js');
    console.log(JSON.stringify({ id: s.getInstallationId(), owner: s.hasOwner() }));
  `, { MIGRATE_V1_STATE: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).owner, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);

  writeFileSync(file, legacy);
  result = run(dataDir, `const s = await import('./src/store.js'); s.hasOwner();`, { MIGRATE_V1_STATE: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /v1 migration was already consumed/);
  assert.equal(readFileSync(file, 'utf8'), legacy);
});

test('malformed or unauthenticated existing state fails closed', () => {
  const malformedDir = tempData();
  const malformedFile = join(malformedDir, 'qm-companion.json');
  writeFileSync(malformedFile, '{broken');
  const malformed = run(malformedDir, `const s = await import('./src/store.js'); s.hasOwner();`);
  assert.notEqual(malformed.status, 0);
  assert.equal(readFileSync(malformedFile, 'utf8'), '{broken');

  const tamperedDir = tempData();
  assert.equal(run(tamperedDir, `const s = await import('./src/store.js'); s.getInstallationId();`).status, 0);
  const tamperedFile = join(tamperedDir, 'qm-companion.json');
  const envelope = JSON.parse(readFileSync(tamperedFile, 'utf8'));
  envelope.payload = envelope.payload.replace('"owner":null', '"owner":{}');
  writeFileSync(tamperedFile, JSON.stringify(envelope));
  const tampered = run(tamperedDir, `const s = await import('./src/store.js'); s.hasOwner();`);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /authentication failed/);
});

test('cron commands and command results are sealed at rest', () => {
  const dataDir = tempData();
  const command = 'curl -H "Authorization: Bearer command-secret" https://example.invalid';
  const note = 'command-secret appeared in output';
  const result = run(dataDir, `
    const s = await import('./src/store.js');
    const jobs = [{
      id: 'custom-aabbccdd', kind: 'custom', name: 'private job', enabled: false,
      schedule: { type: 'daily', hour: 3, minute: 0 },
      action: { type: 'exec', ref: 'aabbccddeeff', cmd: ${JSON.stringify(command)} },
      lastResult: { ok: false, note: ${JSON.stringify(note)}, ms: 12 },
      history: [{ at: 1, ok: false, note: ${JSON.stringify(note)}, ms: 12, trigger: 'manual' }],
    }];
    s.setCron(jobs);
    console.log(JSON.stringify(s.getCron()));
  `);
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout.trim());
  assert.equal(jobs[0].action.cmd, command);
  assert.equal(jobs[0].history[0].note, note);

  const envelope = JSON.parse(readFileSync(join(dataDir, 'qm-companion.json'), 'utf8'));
  assert.equal(envelope.payload.includes('command-secret'), false);
  assert.equal(envelope.payload.includes('Authorization: Bearer'), false);
  const stored = JSON.parse(envelope.payload);
  assert.deepEqual(Object.keys(stored.cron), ['sealed']);
  assert.match(stored.cron.sealed, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
});

function macEnvelope(state) {
  const payload = JSON.stringify(state);
  const stateKey = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET_KEY, 'hex'), Buffer.alloc(0), 'qm-companion:state', 32));
  const mac = createHmac('sha256', stateKey).update('qm-companion:state:v2\0').update(payload, 'utf8').digest('hex');
  return JSON.stringify({ version: 2, payload, mac });
}

const BASE_STATE = {
  installationId: '11111111-1111-4111-8111-111111111111',
  owner: null,
  services: [],
  prefs: {},
  apiTokens: [],
  cron: null,
};

test('update dismissals round-trip and tolerate missing sections', () => {
  const dataDir = tempData();
  const digest = 'sha256:' + 'ab'.repeat(32);
  const result = run(dataDir, `
    const s = await import('./src/store.js');
    const before = s.getDismissedUpdates();
    s.addDismissedUpdates([{ ref: 'lscr.io/linuxserver/radarr:latest', digest: ${JSON.stringify(digest)} }]);
    console.log(JSON.stringify([before, s.getDismissedUpdates()]));
  `);
  assert.equal(result.status, 0, result.stderr);
  const [before, after] = JSON.parse(result.stdout.trim());
  assert.deepEqual(before, []);
  assert.equal(after.length, 1);
  assert.equal(after[0].digest, digest);
  const reread = run(dataDir, `
    const s = await import('./src/store.js');
    console.log(JSON.stringify(s.getDismissedUpdates().length));
  `);
  assert.equal(reread.status, 0, reread.stderr);
  assert.equal(JSON.parse(reread.stdout.trim()), 1, 'the dismissal survives a restart');
});

test('a tampered dismissal record fails the whole state closed', () => {
  const bad = [
    { updates: { dismissed: [{ ref: 'x', digest: 'not-a-digest', at: 1 }] } },
    { updates: { dismissed: [{ ref: '', digest: 'sha256:' + 'ab'.repeat(32), at: 1 }] } },
    { updates: { dismissed: [{ ref: 'x', digest: 'sha256:' + 'ab'.repeat(32), at: -1 }] } },
    { updates: { dismissed: 'nope' } },
    { updates: { dismissed: [], extra: true } },
    { updates: { dismissed: Array.from({ length: 501 }, (_, i) => ({ ref: `r${i}`, digest: 'sha256:' + 'ab'.repeat(32), at: 1 })) } },
  ];
  for (const patch of bad) {
    const dataDir = tempData();
    writeFileSync(join(dataDir, 'qm-companion.json'), macEnvelope({ ...BASE_STATE, ...patch }));
    const result = run(dataDir, `const s = await import('./src/store.js'); s.hasOwner();`);
    assert.notEqual(result.status, 0, `accepted: ${JSON.stringify(patch).slice(0, 80)}`);
    assert.match(result.stderr, /update (state|dismissal)|dismissals/i);
  }
});

test('template sources round-trip, validate https and stay unique', () => {
  const dataDir = tempData();
  const result = run(dataDir, `
    const s = await import('./src/store.js');
    const out = [];
    out.push(s.getTemplateSources());
    out.push(s.addTemplateSource('Community apps', 'https://templates.example.com/v2.json'));
    out.push(s.addTemplateSource('Duplicate', 'https://templates.example.com/v2.json'));
    out.push(s.addTemplateSource('Plain http', 'http://templates.example.com/v2.json'));
    out.push(s.addTemplateSource('Credentialed', 'https://user:pw@example.com/v2.json'));
    out.push(s.addTemplateSource('', 'https://other.example.com/v2.json'));
    out.push(s.getTemplateSources());
    console.log(JSON.stringify(out));
  `);
  assert.equal(result.status, 0, result.stderr);
  const [before, added, dupe, http, creds, unnamed, after] = JSON.parse(result.stdout.trim());
  assert.deepEqual(before, [], 'a file without the section reads as no sources');
  assert.equal(added.ok, true);
  assert.match(added.source.id, /^[0-9a-f]{16}$/);
  assert.equal(dupe.ok, false);
  assert.equal(http.ok, false, 'plain http sources are refused');
  assert.equal(creds.ok, false, 'credentialed URLs are refused');
  assert.equal(unnamed.ok, false);
  assert.equal(after.length, 1);

  const reread = run(dataDir, `
    const s = await import('./src/store.js');
    const rows = s.getTemplateSources();
    const removed = s.removeTemplateSource(rows[0].id);
    console.log(JSON.stringify([rows.length, removed && removed.url, s.getTemplateSources().length, s.removeTemplateSource('0000000000000000')]));
  `);
  assert.equal(reread.status, 0, reread.stderr);
  assert.deepEqual(JSON.parse(reread.stdout.trim()), [1, 'https://templates.example.com/v2.json', 0, null]);
});

test('a malformed template source record fails the whole state closed', () => {
  const good = { id: 'aabbccdd00112233', name: 'ok', url: 'https://templates.example.com/v2.json', addedAt: 1 };
  const bad = [
    { templates: {} },
    { templates: { sources: 'nope' } },
    { templates: { sources: [{ ...good, id: 'UPPER-not-hex-16' }] } },
    { templates: { sources: [{ ...good, url: 'http://templates.example.com/v2.json' }] } },
    { templates: { sources: [{ ...good, name: '' }] } },
    { templates: { sources: [{ ...good, addedAt: -5 }] } },
    { templates: { sources: [good, { ...good, name: 'twin' }] } },
    { templates: { sources: [], extra: true } },
    { templates: { sources: Array.from({ length: 21 }, (_, i) => ({ ...good, id: `${i}`.padStart(16, 'a'), url: `https://t${i}.example.com/x` })) } },
  ];
  for (const patch of bad) {
    const dataDir = tempData();
    writeFileSync(join(dataDir, 'qm-companion.json'), macEnvelope({ ...BASE_STATE, ...patch }));
    const result = run(dataDir, `const s = await import('./src/store.js'); s.hasOwner();`);
    assert.notEqual(result.status, 0, `accepted: ${JSON.stringify(patch).slice(0, 80)}`);
    assert.match(result.stderr, /template (state|source)/i);
  }
});

test('managed stack compose files are sealed at rest and round-trip', () => {
  const dataDir = tempData();
  const yaml = 'services:\n  radarr:\n    image: lscr.io/linuxserver/radarr:latest\n    environment:\n      - API_SECRET=stack-yaml-secret\n';
  const result = run(dataDir, `
    const s = await import('./src/store.js');
    const saved = s.saveManagedStack('media-stack', ${JSON.stringify(yaml)});
    const junk = s.saveManagedStack('bad name!', 'services:');
    console.log(JSON.stringify([saved, junk, s.getManagedStacks()]));
  `);
  assert.equal(result.status, 0, result.stderr);
  const [saved, junk, rows] = JSON.parse(result.stdout.trim());
  assert.equal(saved, true);
  assert.equal(junk, false, 'a junk stack name is refused');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].yaml, yaml);
  const envelope = JSON.parse(readFileSync(join(dataDir, 'qm-companion.json'), 'utf8'));
  assert.equal(envelope.payload.includes('stack-yaml-secret'), false, 'yaml can carry env secrets, so it is sealed');
  const stored = JSON.parse(envelope.payload);
  assert.match(stored.stacks.managed.sealed, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

  const tamperedEnvelope = JSON.parse(readFileSync(join(dataDir, 'qm-companion.json'), 'utf8'));
  const payload = JSON.parse(tamperedEnvelope.payload);
  const sealed = payload.stacks.managed.sealed;
  payload.stacks.managed.sealed = sealed.slice(0, -1) + (sealed.endsWith('0') ? '1' : '0');
  writeFileSync(join(dataDir, 'qm-companion.json'), macEnvelope(payload));
  const tampered = run(dataDir, `const s = await import('./src/store.js'); s.getManagedStacks();`);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /managed stack state could not be decrypted/);
});

test('a malformed stacks section fails the whole state closed', () => {
  const bad = [
    { stacks: {} },
    { stacks: { managed: 'plain' } },
    { stacks: { managed: { sealed: 'zz' } } },
    { stacks: { managed: { sealed: 'aa'.repeat(12) + ':' + 'bb'.repeat(16) + ':cc', extra: 1 } } },
  ];
  for (const patch of bad) {
    const dataDir = tempData();
    writeFileSync(join(dataDir, 'qm-companion.json'), macEnvelope({ ...BASE_STATE, ...patch }));
    const result = run(dataDir, `const s = await import('./src/store.js'); s.hasOwner();`);
    assert.notEqual(result.status, 0, `accepted: ${JSON.stringify(patch).slice(0, 80)}`);
    assert.match(result.stderr, /stack state is invalid|managed stack/);
  }
});

test('minted keys are sealed per instance and self-heal', () => {
  const dataDir = tempData();
  const SENTINEL = 'MINTED-SENTINEL-KEY-do-not-log';
  const id = 'jellyfin-aabbccddeeff0011';
  const result = run(dataDir, `
    const fs = await import('node:fs');
    const s = await import('./src/store.js');
    const { open } = await import('./src/secrets.js');
    const install = s.getInstallationId();
    s.setMintedKey(${JSON.stringify(id)}, { kind: 'jellyfin', apiKey: ${JSON.stringify(SENTINEL)}, createdBy: 'admin' });
    const record = s.getMintedKeys()[${JSON.stringify(id)}];
    const envelope = JSON.parse(fs.readFileSync(process.env.DATA_DIR + '/qm-companion.json', 'utf8'));
    const sealed = JSON.parse(envelope.payload).mintedKeys.keys[${JSON.stringify(id)}].sealed;
    const aad = (a, b) => 'qm-companion:minted:v1:' + a + '\\0' + b;
    console.log(JSON.stringify({
      roundTrip: record.apiKey === ${JSON.stringify(SENTINEL)},
      name: record.name,
      createdBy: record.createdBy,
      sealedAtRest: !envelope.payload.includes(${JSON.stringify(SENTINEL)}),
      openRight: open(sealed, aad(install, ${JSON.stringify(id)})) === ${JSON.stringify(SENTINEL)},
      openWrongInstall: open(sealed, aad('00000000-0000-4000-8000-000000000000', ${JSON.stringify(id)})),
      openWrongInstance: open(sealed, aad(install, 'other-instance')),
    }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.roundTrip, true, 'the key round-trips through the seal');
  assert.equal(out.name, 'Quartermaster');
  assert.equal(out.createdBy, 'admin');
  assert.equal(out.sealedAtRest, true);
  assert.equal(out.openRight, true);
  assert.equal(out.openWrongInstall, null, 'the AAD binds the key to this installation');
  assert.equal(out.openWrongInstance, null, 'the AAD binds the key to this instance');

  const envelope = JSON.parse(readFileSync(join(dataDir, 'qm-companion.json'), 'utf8'));
  const payload = JSON.parse(envelope.payload);
  const sealed = payload.mintedKeys.keys[id].sealed;
  payload.mintedKeys.keys[id].sealed = sealed.slice(0, -1) + (sealed.endsWith('0') ? '1' : '0');
  writeFileSync(join(dataDir, 'qm-companion.json'), macEnvelope(payload));
  const tampered = run(dataDir, `const s = await import('./src/store.js'); s.getMintedKeys();`);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /minted key state could not be decrypted/);
});

test('minted keys forget cleanly and cap at the newest 200', () => {
  const dataDir = tempData();
  const result = run(dataDir, `
    const s = await import('./src/store.js');
    s.setMintedKey('radarr-0000000000000001', { kind: 'radarr', apiKey: 'one', createdBy: 'a' });
    s.setMintedKey('radarr-0000000000000002', { kind: 'radarr', apiKey: 'two', createdBy: 'b' });
    const before = Object.keys(s.getMintedKeys()).length;
    s.forgetMintedKey('radarr-0000000000000001');
    const after = Object.keys(s.getMintedKeys());
    for (let i = 0; i < 205; i += 1) {
      s.setMintedKey('cap-' + String(i).padStart(12, '0'), { kind: 'radarr', apiKey: 'k' + i, createdBy: 'c' });
    }
    console.log(JSON.stringify({ before, afterLen: after.length, afterHas2: after.includes('radarr-0000000000000002'), capped: Object.keys(s.getMintedKeys()).length }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.before, 2);
  assert.equal(out.afterLen, 1);
  assert.equal(out.afterHas2, true);
  assert.equal(out.capped, 200, 'the section caps at 200 newest');
});

test('a malformed minted key section fails the whole state closed', () => {
  const good = { kind: 'jellyfin', name: 'Quartermaster', sealed: 'aa'.repeat(12) + ':' + 'bb'.repeat(16) + ':cc', createdAt: 1, createdBy: 'admin' };
  const bad = [
    { mintedKeys: {} },
    { mintedKeys: { keys: 'nope' } },
    { mintedKeys: { keys: { 'ok-0000000000000001': { ...good, name: 'Other' } } } },
    { mintedKeys: { keys: { 'ok-0000000000000001': { ...good, sealed: 'not-sealed' } } } },
    { mintedKeys: { keys: { 'ok-0000000000000001': { ...good, createdAt: -1 } } } },
    { mintedKeys: { keys: { 'UPPER!bad': good } } },
    { mintedKeys: { keys: {}, extra: true } },
    { mintedKeys: { keys: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`cap-${String(i).padStart(12, '0')}`, good])) } },
  ];
  for (const patch of bad) {
    const dataDir = tempData();
    writeFileSync(join(dataDir, 'qm-companion.json'), macEnvelope({ ...BASE_STATE, ...patch }));
    const result = run(dataDir, `const s = await import('./src/store.js'); s.hasOwner();`);
    assert.notEqual(result.status, 0, `accepted: ${JSON.stringify(patch).slice(0, 80)}`);
    assert.match(result.stderr, /minted key/i);
  }
});

test('audit log persists across restart', () => {
  const dataDir = tempData();
  const result = run(dataDir, `
    const s = await import('./src/store.js');
    const before = s.getAuditLog();
    s.addAudit('created a jellyfin api key named Quartermaster for admin');
    s.addAudit('read the radarr api key from its container');
    console.log(JSON.stringify([before, s.getAuditLog()]));
  `);
  assert.equal(result.status, 0, result.stderr);
  const [before, after] = JSON.parse(result.stdout.trim());
  assert.deepEqual(before, [], 'a file without the section reads as no activity');
  assert.equal(after.length, 2);
  assert.equal(after[0].line, 'read the radarr api key from its container', 'newest line is first');
  const reread = run(dataDir, `const s = await import('./src/store.js'); console.log(JSON.stringify(s.getAuditLog().length));`);
  assert.equal(reread.status, 0, reread.stderr);
  assert.equal(JSON.parse(reread.stdout.trim()), 2, 'the trail survives a restart');
});

test('a malformed audit record fails the whole state closed', () => {
  const bad = [
    { auditLog: 'nope' },
    { auditLog: [{ line: '', at: 1 }] },
    { auditLog: [{ line: 'ok', at: -1 }] },
    { auditLog: [{ at: 1 }] },
    { auditLog: Array.from({ length: 201 }, () => ({ line: 'x', at: 1 })) },
  ];
  for (const patch of bad) {
    const dataDir = tempData();
    writeFileSync(join(dataDir, 'qm-companion.json'), macEnvelope({ ...BASE_STATE, ...patch }));
    const result = run(dataDir, `const s = await import('./src/store.js'); s.hasOwner();`);
    assert.notEqual(result.status, 0, `accepted: ${JSON.stringify(patch).slice(0, 80)}`);
    assert.match(result.stderr, /audit/i);
  }
});

test('authenticated legacy cron arrays migrate atomically to sealed storage', () => {
  const dataDir = tempData();
  const file = join(dataDir, 'qm-companion.json');
  const legacyCron = [{
    id: 'custom-11223344', kind: 'custom', name: 'legacy', enabled: false,
    schedule: { type: 'every', hours: 24 },
    action: { type: 'exec', ref: 'aabbccddeeff', cmd: 'LEGACY_TOKEN=plaintext-before-migration' },
    history: [{ at: 1, ok: true, note: 'plaintext-before-migration', ms: 2, trigger: 'manual' }],
  }];
  const state = {
    installationId: '11111111-1111-4111-8111-111111111111',
    owner: null,
    services: [],
    prefs: {},
    apiTokens: [],
    cron: legacyCron,
  };
  const payload = JSON.stringify(state);
  const stateKey = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET_KEY, 'hex'), Buffer.alloc(0), 'qm-companion:state', 32));
  const mac = createHmac('sha256', stateKey).update('qm-companion:state:v2\0').update(payload, 'utf8').digest('hex');
  writeFileSync(file, JSON.stringify({ version: 2, payload, mac }));

  const result = run(dataDir, `
    const s = await import('./src/store.js');
    console.log(JSON.stringify(s.getCron()));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), legacyCron);

  const migrated = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(migrated.payload.includes('plaintext-before-migration'), false);
  assert.match(JSON.parse(migrated.payload).cron.sealed, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
});
