import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).href;
const KEY = 'fixture-proxy_key.with:punctuation-'.repeat(2);

// Exercise the real Docker response classification and rendered recovery path.
function render(key, status = 403) {
  const dataDir = mkdtempSync(join(tmpdir(), 'qm-proxy-recovery-'));
  const script = `
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.writeHead(${status}, { 'content-type': 'application/json' });
  res.end('[]');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.DOCKER_HOST = 'tcp://127.0.0.1:' + server.address().port;
try {
  const docker = await import(${JSON.stringify(ROOT + 'src/docker.js')});
  const { imagesPage } = await import(${JSON.stringify(ROOT + 'src/ui/pages/images.js')});
  const rows = await docker.listImages();
  const html = imagesPage(rows, new Set(), true, 'fixture-csrf', {});
  const empty = html.match(/<div class="empty">([\\s\\S]*?)<\\/div>/)?.[1];
  process.stdout.write(JSON.stringify({ rows, empty, problem: docker.dockerProxyKeyProblem() }));
} finally { await new Promise(resolve => server.close(resolve)); }
`;
  const env = {
    ...process.env, DATA_DIR: dataDir, QM_HOST: 'nas.local',
    SECRET_KEY: 'a'.repeat(64), DOCKER_ACCESS_MAX: 'read',
  };
  if (key === undefined) delete env.QM_PROXY_KEY;
  else env.QM_PROXY_KEY = key;
  try {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env, encoding: 'utf8', timeout: 10_000,
    }));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

for (const [name, key, problem, message] of [
  ['missing', undefined, 'missing', /QM_PROXY_KEY<\/code> is missing/],
  ['short', 'fixture-short', 'short', /at least 32 characters/],
  ['malformed', KEY + '\n', 'malformed', /unsupported separators or surrounding whitespace/],
]) {
  test(`identifies a ${name} local proxy key without exposing it`, () => {
    const got = render(key);
    assert.equal(got.problem, problem);
    assert.match(got.empty, message);
    assert.match(got.empty, /same private/);
    assert.match(got.empty, /On Unraid.*Apply/);
    assert.match(got.empty, /same project and ordered files/);
    assert.doesNotMatch(got.empty, /IMAGES: 1|docker compose|up -d/);
    if (key) assert.ok(!got.empty.includes(key.trim()), 'the key stays private');
  });
}

test('an ambiguous 403 checks matching keys before endpoint permissions', () => {
  const got = render(KEY);
  assert.equal(got.rows, 'blocked');
  assert.equal(got.problem, null, 'punctuation and non-hex keys remain accepted');
  assert.match(got.empty, /refused this read request/);
  assert.match(got.empty, /key mismatch can block every Docker read request/);
  assert.ok(got.empty.indexOf('QM_PROXY_KEY') < got.empty.indexOf('IMAGES: 1'));
  assert.match(got.empty, /If the keys match/);
  assert.match(got.empty, /POST: 0/);
  assert.match(got.empty, /EXEC: 0/);
  assert.doesNotMatch(got.empty, /POST: 1|EXEC: 1|docker compose|Nothing is answering/);
  assert.ok(!got.empty.includes(KEY));
});

test('a server failure does not claim that no proxy answered', () => {
  const got = render(KEY, 500);
  assert.equal(got.rows, null);
  assert.match(got.empty, /Companion could not read Docker/);
  assert.match(got.empty, /running and reachable from Companion/);
  assert.doesNotMatch(got.empty, /Nothing is answering|refused this read request/);
});

test('a successful empty response stays an empty library', () => {
  const got = render(KEY, 200);
  assert.deepEqual(got.rows, []);
  assert.doesNotMatch(got.empty, /QM_PROXY_KEY|refused this read request|could not read Docker/);
});
