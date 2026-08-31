import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const dataDir = mkdtempSync(join(tmpdir(), 'qm-companion-port-scheme-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATA_DIR = dataDir;

const HOST = '192.0.2.10';
const cfg = { qmTitle: 'Home', qmHost: HOST };

let containers = [];
const daemon = createServer((req, res) => {
  if (req.url === '/containers/json?all=1') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(containers));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => daemon.listen(0, '127.0.0.1', resolve));
process.env.DOCKER_HOST = `tcp://127.0.0.1:${daemon.address().port}`;

const { detectServices, mergeLiveProbes, publishedMappingOf, publishedPortOf } = await import('../src/detect.js');
const { schemeForKindPorts, schemeForKindPort } = await import('../src/probe.js');
const { suggestedBaseUrl } = await import('../src/build.js');

after(() => {
  daemon.closeAllConnections();
  rmSync(dataDir, { recursive: true, force: true });
  return new Promise((done) => daemon.close(done));
});

async function rowsFor(list) {
  containers = list;
  return detectServices(undefined);
}

function portainer(name, ports) {
  return {
    Id: '0'.repeat(64),
    Names: [`/${name}`],
    Image: 'portainer/portainer-ce:latest',
    State: 'running',
    Labels: {},
    Ports: ports,
  };
}

function dualStack(privatePort, publicPort) {
  return [
    { IP: '0.0.0.0', PrivatePort: privatePort, PublicPort: publicPort, Type: 'tcp' },
    { IP: '::', PrivatePort: privatePort, PublicPort: publicPort, Type: 'tcp' },
  ];
}

test('deduplicates published mappings without dropping port roles', () => {
  assert.deepEqual(
    publishedMappingOf(dualStack(9000, 18000), 'portainer'),
    { privatePort: 9000, publicPort: 18000 },
  );
  assert.deepEqual(
    publishedMappingOf(dualStack(9443, 9000), 'portainer'),
    { privatePort: 9443, publicPort: 9000 },
  );
  assert.equal(publishedPortOf(dualStack(9000, 18000), 'portainer'), 18000);
  assert.equal(publishedPortOf(dualStack(9443, 9000), 'portainer'), 9000);
});

test('infers protocol from the container port', () => {
  assert.equal(schemeForKindPorts('portainer', 9000, 18000), 'http', '18000:9000 is plain HTTP');
  assert.equal(schemeForKindPorts('portainer', 9443, 9000), 'https', '9000:9443 is TLS on 9000');
  assert.equal(schemeForKindPorts('portainer', '9443', '9000'), 'https', 'string ports too');
  assert.equal(schemeForKindPorts('portainer', undefined, 9000), schemeForKindPort('portainer', 9000));
  assert.equal(schemeForKindPorts('portainer', undefined, 9443), schemeForKindPort('portainer', 9443));
  assert.equal(schemeForKindPorts('portainer', 8000, 9443), 'https');
  assert.equal(schemeForKindPorts('audiobookshelf', 80, 7979), 'http', '7979:80 is unchanged');
  assert.equal(schemeForKindPorts('radarr', 7878, 17878), 'http');
});

test('hands over remapped Portainer HTTP ports', async () => {
  const [row] = await rowsFor([portainer('portainer', dualStack(9000, 18000))]);
  assert.equal(row.kind, 'portainer');
  assert.equal(row.port, 18000, 'the reachable port is the published one');
  assert.equal(row.containerPort, 9000, 'the container port survives on the row');
  assert.equal(suggestedBaseUrl(row, cfg), `http://${HOST}:18000`);
});

test('hands over remapped Portainer HTTPS ports', async () => {
  const [row] = await rowsFor([portainer('portainer-tls', dualStack(9443, 9000))]);
  assert.equal(row.port, 9000);
  assert.equal(row.containerPort, 9443);
  assert.equal(suggestedBaseUrl(row, cfg), `https://${HOST}:9000`, '9000 is TLS here because 9443 is');
});

test('preserves inferred scheme after a failed probe', async () => {
  const detected = await rowsFor([portainer('portainer-tls', dualStack(9443, 9000))]);
  const [row] = mergeLiveProbes(detected, [
    { kind: 'portainer', port: 9000, up: false, confirmed: false, url: `http://${HOST}:9000` },
  ], HOST);
  assert.equal(row.availability, 'unreachable');
  assert.equal(suggestedBaseUrl(row, cfg), `https://${HOST}:9000`, 'a failed probe is not evidence');
});

test('prefers a confirmed probe URL over an inferred URL', async () => {
  const detected = await rowsFor([portainer('portainer', dualStack(9000, 18000))]);
  const rows = mergeLiveProbes(detected, [
    { kind: 'portainer', port: 18000, up: true, confirmed: true, url: `http://${HOST}:18000` },
  ], HOST);
  const row = rows.find((r) => r.availability === 'reachable');
  assert.ok(row);
  assert.equal(suggestedBaseUrl(row, cfg), `http://${HOST}:18000`);
});

test('does not invent ambiguous container routes', async () => {
  const rows = await rowsFor([
    { ...portainer('portainer-none', []), Id: '1'.repeat(64) },
    {
      Id: '2'.repeat(64),
      Names: ['/audiobookshelf'],
      Image: 'ghcr.io/advplyr/audiobookshelf:latest',
      State: 'running',
      Labels: {},
      Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 7979, Type: 'udp' }],
    },
    {
      Id: '3'.repeat(64),
      Names: ['/radarr'],
      Image: 'lscr.io/linuxserver/radarr:latest',
      State: 'running',
      Labels: {},
      Ports: [...dualStack(111, 1111), ...dualStack(222, 2222)],
    },
  ]);
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));

  assert.equal(byKind.portainer.containerPort, undefined);
  assert.equal(byKind.portainer.port, 9443);
  assert.equal(suggestedBaseUrl(byKind.portainer, cfg), `https://${HOST}:9443`);
  assert.equal(byKind.audiobookshelf.containerPort, undefined);
  assert.equal(suggestedBaseUrl(byKind.audiobookshelf, cfg), `http://${HOST}:13378`);
  assert.equal(byKind.radarr.containerPort, undefined);
  assert.equal(suggestedBaseUrl(byKind.radarr, cfg), `http://${HOST}:7878`);
});

test('preserves addresses for unknown container ports', async () => {
  const [row] = await rowsFor([
    {
      Id: '4'.repeat(64),
      Names: ['/audiobookshelf'],
      Image: 'ghcr.io/advplyr/audiobookshelf:latest',
      State: 'running',
      Labels: {},
      Ports: dualStack(80, 7979),
    },
  ]);
  assert.equal(row.port, 7979);
  assert.equal(row.containerPort, 80);
  assert.equal(suggestedBaseUrl(row, cfg), `http://${HOST}:7979`, 'unchanged: no fingerprint on 80');
});
