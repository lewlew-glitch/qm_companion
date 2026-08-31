import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBundle } from '../src/build.js';

test('credential recovery reads allowlisted stack files', async (t) => {
  const valid = [
    { kind: 'radarr', file: 'config.xml', value: '<Config><ApiKey>radarr-key</ApiKey></Config>', key: 'radarr-key' },
    { kind: 'sonarr', file: 'config.xml', value: '<Config><ApiKey>sonarr-key</ApiKey></Config>', key: 'sonarr-key' },
    { kind: 'lidarr', file: 'config.xml', value: '<Config><ApiKey>lidarr-key</ApiKey></Config>', key: 'lidarr-key' },
    { kind: 'prowlarr', file: 'config.xml', value: '<Config><ApiKey>prowlarr-key</ApiKey></Config>', key: 'prowlarr-key' },
    { kind: 'bazarr', file: 'config.yaml', value: 'auth:\n  apikey: bazarr-key\n', key: 'bazarr-key' },
    { kind: 'sabnzbd', file: 'sabnzbd.ini', value: '[misc]\napi_key = sabnzbd-key\n', key: 'sabnzbd-key' },
    { kind: 'jellyseerr', file: 'settings.json', value: JSON.stringify({ main: { apiKey: 'jellyseerr-key' } }), key: 'jellyseerr-key' },
    {
      kind: 'jellyseerr',
      name: 'overseerr',
      file: 'settings.json',
      value: JSON.stringify({ main: { apiKey: 'overseerr-key' } }),
      key: 'overseerr-key',
      image: 'sctx/overseerr:latest',
    },
  ];
  const invalid = [
    { kind: 'radarr', name: 'radarr-linked' },
    { kind: 'sonarr', name: 'sonarr-oversized' },
    { kind: 'lidarr', name: 'lidarr-malformed' },
    { kind: 'radarr', name: 'notradarr' },
  ];
  const stackDir = mkdtempSync(join(tmpdir(), 'qm-mounted-credential-test-'));
  t.after(() => rmSync(stackDir, { recursive: true, force: true }));

  for (const entry of valid) {
    const instanceDir = join(stackDir, entry.name || entry.kind);
    mkdirSync(instanceDir);
    writeFileSync(join(instanceDir, entry.file), entry.value);
  }

  const linkedDir = join(stackDir, 'radarr-linked');
  mkdirSync(linkedDir);
  const linkedTarget = join(stackDir, 'linked-target.xml');
  writeFileSync(linkedTarget, '<Config><ApiKey>linked-key</ApiKey></Config>');
  symlinkSync(linkedTarget, join(linkedDir, 'config.xml'));

  const oversizedDir = join(stackDir, 'sonarr-oversized');
  mkdirSync(oversizedDir);
  writeFileSync(join(oversizedDir, 'config.xml'), Buffer.alloc(256 * 1024 + 1, 65));

  const malformedDir = join(stackDir, 'lidarr-malformed');
  mkdirSync(malformedDir);
  writeFileSync(join(malformedDir, 'config.xml'), Buffer.concat([
    Buffer.from('<Config><ApiKey>'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('</ApiKey></Config>'),
  ]));

  const lookalikeDir = join(stackDir, 'notradarr');
  mkdirSync(lookalikeDir);
  writeFileSync(join(lookalikeDir, 'config.xml'), '<Config><ApiKey>lookalike-key</ApiKey></Config>');

  const images = {
    radarr: 'lscr.io/linuxserver/radarr:latest',
    sonarr: 'lscr.io/linuxserver/sonarr:latest',
    lidarr: 'lscr.io/linuxserver/lidarr:latest',
    prowlarr: 'lscr.io/linuxserver/prowlarr:latest',
    bazarr: 'lscr.io/linuxserver/bazarr:latest',
    sabnzbd: 'lscr.io/linuxserver/sabnzbd:latest',
    jellyseerr: 'fallenbagel/jellyseerr:latest',
  };
  const all = [
    ...valid.map((entry) => ({ ...entry, name: entry.name || entry.kind })),
    ...invalid,
  ];
  const containers = all.map((entry, index) => ({
    Id: index.toString(16).padStart(64, '0'),
    Names: [`/${entry.name}`],
    Image: entry.image || images[entry.kind],
    Ports: [{ Type: 'tcp', PrivatePort: 7000 + index, PublicPort: 17000 + index }],
    Labels: {},
  }));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/containers/json?all=1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(containers));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const previousHost = process.env.DOCKER_HOST;
  const address = server.address();
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${address.port}`;
  t.after(() => {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  });

  const { detectServices } = await import(`../src/detect.js?mounted-credential-integration=${Date.now()}`);
  const detected = await detectServices(stackDir);
  for (const entry of valid) {
    const row = detected.find((candidate) => candidate.name === (entry.name || entry.kind));
    assert.equal(row?.apiKey, entry.key, entry.name || entry.kind);
    assert.equal(row?.sources.includes('config'), true, entry.name || entry.kind);
  }
  for (const { name } of invalid) {
    const row = detected.find((candidate) => candidate.name === name);
    assert.equal(row?.apiKey, undefined, name);
    assert.deepEqual(row?.sources, ['docker'], name);
  }
  const transferable = valid.map((entry) => detected.find((row) => row.name === (entry.name || entry.kind)));
  const bundle = buildBundle(
    transferable,
    { qmTitle: 'Home', qmHost: '192.168.1.20' },
    {
      services: transferable.map((row) => ({
        instanceId: row.instanceId,
        included: true,
        baseUrl: `http://192.168.1.20:${row.port}`,
      })),
      edgeAccess: {},
    },
    'installation-mounted-config-test',
    {
      bundleId: 'bundle_mounted_config_test',
      issuedAt: '2026-08-19T10:00:00.000Z',
      expiresAt: '2026-08-19T10:03:00.000Z',
    },
  );
  for (const [index, service] of bundle.payload.services.entries()) {
    assert.equal(service.secrets.apiKey, valid[index].key, service.name);
  }
  assert.equal(bundle.summary.every((service) => service.credentialState === 'included'), true);
  assert.equal(requests.some((request) => request.includes('/archive')), false);
  assert.equal(requests.includes('GET /containers/json?all=1'), true);
});
