
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function serviceBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `service ${name} exists`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() && !line.startsWith('    ') && !line.startsWith('  #')) break;
    block.push(line);
  }
  return block;
}

function environment(text, service) {
  const block = serviceBlock(text, service);
  const start = block.findIndex((line) => line.trim() === 'environment:');
  assert.notEqual(start, -1, `${service} has an environment mapping`);
  const values = Object.create(null);
  for (let i = start + 1; i < block.length; i += 1) {
    const line = block[i];
    if (line.trim() && !line.startsWith('      ') && !line.startsWith('    #')) break;
    const match = /^\s{6}([A-Z][A-Z0-9_]*):\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/.exec(line);
    if (match) values[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  return values;
}

function compose(name) {
  return readFileSync(join(projectRoot, name), 'utf8');
}

const profiles = [
  { file: 'docker-compose.example.yml', post: '0', exec: '0', maximum: 'read' },
  { file: 'docker-compose.management.yml', post: '1', exec: '0', maximum: 'manage' },
  { file: 'docker-compose.shell.yml', post: '1', exec: '1', maximum: 'shell' },
];

test('profiles match Companion and proxy access ceilings', () => {
  for (const profile of profiles) {
    const text = compose(profile.file);
    const proxy = environment(text, 'socket-proxy');
    const companion = environment(text, 'companion');
    assert.equal(proxy.POST, profile.post, `${profile.file} POST`);
    assert.equal(proxy.EXEC, profile.exec, `${profile.file} EXEC`);
    assert.equal(companion.DOCKER_ACCESS_MAX, profile.maximum, `${profile.file} maximum`);
    assert.ok(proxy.POST === '1' || proxy.EXEC !== '1', `${profile.file} never enables EXEC without POST`);
  }
});

test('optional access overlays change capability fields only', () => {
  for (const file of ['docker-compose.management.yml', 'docker-compose.shell.yml']) {
    const text = compose(file);
    assert.deepEqual(Object.keys(environment(text, 'socket-proxy')).sort(), ['EXEC', 'POST']);
    assert.deepEqual(Object.keys(environment(text, 'companion')), ['DOCKER_ACCESS_MAX']);
  }
});

test('base profile uses read-only access without the legacy switch', () => {
  const text = compose('docker-compose.example.yml');
  assert.equal(environment(text, 'socket-proxy').POST, '0');
  assert.equal(environment(text, 'socket-proxy').EXEC, '0');
  assert.equal(environment(text, 'companion').DOCKER_ACCESS_MAX, 'read');
  assert.doesNotMatch(text, /^\s+DOCKER_CONTROL\s*:/m);
});
