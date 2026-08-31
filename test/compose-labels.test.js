
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function serviceBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() && !line.startsWith('    ') && !line.startsWith('  #')) break;
    block.push(line);
  }
  return block.join('\n');
}

function assertProtected(file) {
  const text = readFileSync(file, 'utf8');
  for (const service of ['companion', 'socket-proxy']) {
    const block = serviceBlock(text, service);
    assert.ok(block, `${file} defines the ${service} service`);
    assert.match(block, /labels:/, `${file}: ${service} carries a labels section`);
    assert.match(block, /qm\.protected: "true"/, `${file}: ${service} keeps qm.protected: "true"`);
  }
}

test('the example compose file protects both control-plane services', () => {
  assertProtected(join(projectRoot, 'docker-compose.example.yml'));
});

test('the NAS override file protects both control-plane services when present', (t) => {
  const nas = join(projectRoot, 'docker-compose.nas.yml');
  if (!existsSync(nas)) return t.skip('docker-compose.nas.yml is gitignored and absent here');
  assertProtected(nas);
});
