
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

process.env.SECRET_KEY = '5c'.repeat(32);
process.env.QM_HOST = 'nas.local';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-wide-bindings-'));
const DATA_DIR = process.env.DATA_DIR;
test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

import { widelyBoundContainers, wideBindingAdvice } from '../src/wide-bindings.js';

const container = (name, ports) => ({ Id: `${name}0123456789ab`, Names: [`/${name}`], Ports: ports });

test('detects missing and wildcard host addresses', () => {
  const found = widelyBoundContainers([
    container('radarr', [{ PublicPort: 7878, PrivatePort: 7878, Type: 'tcp' }]),
    container('sonarr', [{ IP: '0.0.0.0', PublicPort: 8989, PrivatePort: 8989, Type: 'tcp' }]),
    container('prowlarr', [{ IP: '::', PublicPort: 9696, PrivatePort: 9696, Type: 'tcp' }]),
  ]);
  assert.deepEqual(found.map((c) => c.name), ['prowlarr', 'radarr', 'sonarr']);
});

test('ignores ports bound to one address', () => {
  const found = widelyBoundContainers([
    container('radarr', [{ IP: '192.168.1.10', PublicPort: 7878, PrivatePort: 7878, Type: 'tcp' }]),
    container('sabnzbd', [{ IP: '127.0.0.1', PublicPort: 8080, PrivatePort: 8080, Type: 'tcp' }]),
  ]);
  assert.deepEqual(found, []);
});

test('ignores unpublished ports', () => {
  assert.deepEqual(widelyBoundContainers([container('internal', [{ PrivatePort: 5432, Type: 'tcp' }])]), []);
  assert.deepEqual(widelyBoundContainers([container('none', [])]), []);
  assert.deepEqual(widelyBoundContainers([]), []);
  assert.deepEqual(widelyBoundContainers(undefined), []);
});

test('lists affected ports', () => {
  const found = widelyBoundContainers([
    container('mixed', [
      { IP: '192.168.1.10', PublicPort: 1, PrivatePort: 1, Type: 'tcp' },
      { PublicPort: 7878, PrivatePort: 7878, Type: 'tcp' },
      { IP: '0.0.0.0', PublicPort: 9091, PrivatePort: 9091, Type: 'udp' },
    ]),
  ]);
  assert.deepEqual(found[0].ports, ['7878:7878/tcp', '9091:9091/udp']);
  assert.equal(found[0].id.length, 12);
});

test('the advice explains how to replace a wildcard binding', () => {
  const advice = wideBindingAdvice(
    widelyBoundContainers([container('radarr', [{ PublicPort: 7878, PrivatePort: 7878 }])]),
    '192.168.1.10',
  );
  assert.equal(advice.count, 1);
  assert.match(advice.names, /radarr/);
  assert.match(advice.summary, /every host interface/);
  assert.match(advice.updateNote, /Image updates keep the existing port bindings/);
  assert.match(advice.remedy, /"192\.168\.1\.10:8080:80" instead of "8080:80"/);
  assert.match(advice.remedy, /--force-recreate/);
  assert.match(advice.remedy, /Volumes and bind mounts remain/);
  assert.match(advice.remedy, /writable layer/);
  assert.match(advice.remedy, /edit its Compose text in Stacks and redeploy/);
});

test('returns null when no bindings are wide', () => {
  assert.equal(wideBindingAdvice([], '192.168.1.10'), null);
  assert.equal(wideBindingAdvice(undefined, '192.168.1.10'), null);
});

test('the advice falls back to loopback when no bind address is configured', () => {
  const advice = wideBindingAdvice([{ name: 'x', id: 'abc', ports: ['1:1/tcp'] }], undefined);
  assert.match(advice.remedy, /"127\.0\.0\.1:8080:80"/);
});

test('host network mode is reported, even though Docker lists no ports for it', () => {
  const found = widelyBoundContainers([
    { Id: 'hostnet00000', Names: ['/plex'], Ports: [], HostConfig: { NetworkMode: 'host' } },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].hostNetwork, true);
  assert.deepEqual(found[0].ports, []);

  const advice = wideBindingAdvice(found, '192.168.1.10');
  assert.deepEqual(advice.hostNetwork, ['plex']);
  assert.match(advice.hostNetworkNote, /network_mode: host/);
  assert.match(advice.hostNetworkNote, /Move the stack to a bridged network/);
});

test('a bridged container is not mistaken for a host-network one', () => {
  const found = widelyBoundContainers([
    { Id: 'bridge000000', Names: ['/radarr'], Ports: [], HostConfig: { NetworkMode: 'bridge' } },
  ]);
  assert.deepEqual(found, []);
});

test('port strings preserve address metadata', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const docker = readFileSync(join(root, 'src/docker.js'), 'utf8');
  assert.match(docker, /const ports = published\.map\(\(p\) => `\$\{p\.PublicPort\}:\$\{p\.PrivatePort\}`\);/);
  assert.match(docker, /widePorts: \[\.\.\.new Set\(widePorts\)\]/);
  const server = readFileSync(join(root, 'src/server.js'), 'utf8');
  assert.match(server, /\/\^\(\\d\{1,5\}\):\//);
});

test('panel renders the wide-binding notice', async () => {
  const { containersPage } = await import('../src/ui/pages/containers.js');
  const rows = [
    { id: 'a1', name: 'radarr', state: 'running', image: 'r', ports: ['7878:7878'], widePorts: ['7878:7878/tcp'] },
    { id: 'b2', name: 'sonarr', state: 'running', image: 's', ports: ['8989:8989'], widePorts: [] },
  ];
  const html = containersPage(rows, false, 'csrf-token');
  assert.match(html, /data-wide-bindings/, 'the notice renders');
  assert.match(html, /radarr/);
  assert.match(html, /Updating an image does not change this/);
  assert.doesNotMatch(html.split('data-wide-bindings')[1].slice(0, 400), /sonarr/, 'only the affected one is named');
});

test('no notice when every published port names an address', async () => {
  const { containersPage } = await import('../src/ui/pages/containers.js');
  const html = containersPage(
    [{ id: 'a1', name: 'radarr', state: 'running', image: 'r', ports: ['7878:7878'], widePorts: [] }],
    false,
    'csrf-token',
  );
  assert.doesNotMatch(html, /data-wide-bindings/);
});

test('host-network containers are named without port entries', async () => {
  const { containersPage } = await import('../src/ui/pages/containers.js');
  const html = containersPage(
    [{ id: 'a1', name: 'plex', state: 'running', image: 'p', ports: [], widePorts: [], hostNetwork: true }],
    false,
    'csrf-token',
  );
  assert.match(html, /data-wide-bindings/);
  assert.match(html, /plex/);
  assert.match(html, /host network cannot be fixed this way/);
});
