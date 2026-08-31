
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

import { widelyBoundContainers, wideBindingAdvice } from '../src/wide-bindings.js';


let PAYLOAD = [];
const daemon = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(PAYLOAD));
});
await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
const port = daemon.address().port;
process.env.DOCKER_HOST = `tcp://127.0.0.1:${port}`;
const { listContainers } = await import('../src/docker.js');
const { lintCompose } = await import('../src/lint.js');
test.after(() => daemon.close());

const publishedHostPortsAsServerDoes = (containers) => {
  const out = [];
  for (const c of containers) {
    for (const p of c.ports || []) {
      const m = /^(\d{1,5}):/.exec(p);
      if (m) out.push({ port: Number(m[1]), owner: c.name });
    }
  }
  return out;
};

const chipHostPort = (p) => String(p).split(':')[0];

const COMPOSE = [
  'services:',
  '  new:',
  '    image: nginx',
  '    ports:',
  '      - "8080:80"',
].join('\n');


test('reports both IPv4 and IPv6 wildcard publishes', () => {
  const found = widelyBoundContainers([
    {
      Id: 'aaaaaaaaaaaabbbb',
      Names: ['/radarr'],
      Ports: [
        { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
        { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
      ],
    },
  ]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].ports, ['8080:80/tcp', '8080:80/tcp']);
});

test('reports every port in a wildcard range', () => {
  const Ports = [];
  for (let p = 8000; p <= 8010; p += 1) Ports.push({ IP: '0.0.0.0', PrivatePort: p, PublicPort: p, Type: 'tcp' });
  const found = widelyBoundContainers([{ Id: 'r'.repeat(16), Names: ['/rangey'], Ports }]);
  assert.equal(found[0].ports.length, 11);
});

test('host-network containers are reported without port entries', () => {
  const hostMode = {
    Id: 'h'.repeat(16),
    Names: ['/pihole'],
    Ports: [],
    HostConfig: { NetworkMode: 'host' },
  };
  const found = widelyBoundContainers([hostMode]);
  assert.equal(found.length, 1);
  assert.equal(found[0].hostNetwork, true);
  const advice = wideBindingAdvice(found, '192.168.1.20');
  assert.deepEqual(advice.hostNetwork, ['pihole']);
  assert.match(advice.hostNetworkNote, /network_mode: host/);
});

const sweepGrep = (psOutput) => {
  try {
    return execFileSync(
      '/bin/sh',
      ['-c', "printf '%s' \"$1\" | grep -E '0\\.0\\.0\\.0:|:::' || echo 'none publishing on every interface'", 'sh', psOutput],
      { encoding: 'utf8' },
    ).trim();
  } catch (e) {
    return `THREW: ${e.message}`;
  }
};

test('matches legacy and current IPv6 wildcard output', () => {
  assert.match(sweepGrep('legacy\t:::8080->8080/tcp'), /legacy/);
  assert.equal(sweepGrep('modern\t[::]:8080->8080/tcp'), 'none publishing on every interface');
});

test('ignores host-network and address-less publish output in the sweep', () => {
  assert.equal(sweepGrep('pihole\t'), 'none publishing on every interface');
  assert.equal(sweepGrep('odd\t80/tcp'), 'none publishing on every interface');
});

test('wildcard sweep detects standard IPv4 output', () => {
  assert.match(sweepGrep('radarr\t0.0.0.0:7878->7878/tcp, :::7878->7878/tcp'), /radarr/);
});


test('port strings preserve the live host-port index', async () => {
  PAYLOAD = [{
    Id: 'c'.repeat(64),
    Names: ['/jellyfin'],
    Image: 'jellyfin/jellyfin',
    State: 'running',
    Status: 'Up 2 hours',
    Ports: [{ IP: '192.168.1.20', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
    Labels: {},
    NetworkSettings: { Networks: {} },
  }];
  const list = await listContainers();
  assert.deepEqual(list[0].ports, ['8080:80'], 'the display string is unchanged');
  assert.deepEqual(list[0].widePorts, [], 'and a bound port is not reported as wide');

  const after = publishedHostPortsAsServerDoes(list);
  assert.deepEqual(after, [{ port: 8080, owner: 'jellyfin' }]);

  const nowFlagged = lintCompose(COMPOSE, {}, { containers: [], publishedHostPorts: after });
  assert.ok(
    nowFlagged.some((f) => f.id === 'QM003' && /already published by container "jellyfin"/.test(f.message)),
  );
});

test('both chips link, and only the wide one is reported as wide', async () => {
  PAYLOAD = [{
    Id: 'd'.repeat(64),
    Names: ['/wide'],
    Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 9000, Type: 'tcp' }],
    Labels: {},
    NetworkSettings: { Networks: {} },
  }, {
    Id: 'e'.repeat(64),
    Names: ['/narrow'],
    Ports: [{ IP: '192.168.1.20', PrivatePort: 80, PublicPort: 9001, Type: 'tcp' }],
    Labels: {},
    NetworkSettings: { Networks: {} },
  }];
  const list = await listContainers();
  const wide = list.find((c) => c.name === 'wide');
  const narrow = list.find((c) => c.name === 'narrow');
  assert.ok(/^\d+$/.test(chipHostPort(wide.ports[0])), 'the wide port links');
  assert.ok(/^\d+$/.test(chipHostPort(narrow.ports[0])), 'and so does the correctly bound one');
  assert.deepEqual(wide.widePorts, ['9000:80/tcp'], 'the wide one is flagged');
  assert.deepEqual(narrow.widePorts, [], 'the bound one is not');
  assert.equal(chipHostPort(narrow.ports[0]), '9001', 'the chip reads the host PORT, as it always did');
});

test('the panel imports the wide-binding module', () => {
  const out = execFileSync('/usr/bin/grep', [
    '-rl', '--exclude-dir=node_modules', '--exclude-dir=.git',
    '-e', 'wide-bindings', '-e', 'widelyBoundContainers', '-e', 'wideBindingAdvice', '.',
  ], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' })
    .trim().split('\n').sort();
  assert.ok(out.includes('./src/ui/pages/containers.js'), `the panel imports it, got ${out.join(', ')}`);
});
