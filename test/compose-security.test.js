import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deployStack, parseCompose, dangerousBinds, parseDeployBindRoots, reservedProtectionClaims } from '../src/compose.js';

test('declared named volumes are parsed for Compose-compatible deployment', () => {
  const parsed = parseCompose(`services:
  app:
    image: example/app:latest
    volumes:
      - app-data:/data
volumes:
  app-data:
`);

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.volumes, ['app-data']);
  assert.deepEqual(parsed.ignored, []);
});

test('unsupported Compose fields block deployment', async () => {
  const result = await deployStack('secure-test', `services:
  app:
    image: example/app:latest
    read_only: true
`, {}, true);

  assert.equal(result.ok, false);
  assert.equal(result.partial, false);
  assert.equal(result.created, 0);
  assert.deepEqual(result.steps.map(({ step }) => step), ['parse', 'unsupported']);
  assert.match(result.steps[1].note, /read_only.*does not support/);
});

test('rejects inline collections', async () => {
  for (const field of [
    'ports: ["8080:80"]',
    'environment: {TZ: Europe/London, PASSWORD: secret}',
  ]) {
    const parsed = parseCompose(`services:
  app:
    image: example/app:latest
    ${field}
`);
    assert.equal(parsed.ok, true);
    assert.match(parsed.ignored.join(', '), /inline syntax/);

    const result = await deployStack('inline-test', `services:
  app:
    image: example/app:latest
    ${field}
`, {}, true);
    assert.deepEqual(result.steps.map(({ step }) => step), ['parse', 'unsupported']);
  }
});

test('service networks and command stop direct deployment before Docker', async () => {
  for (const field of [
    'networks:\n      - private',
    'command: ["sleep", "30"]',
  ]) {
    const result = await deployStack('unsupported-test', `services:
  app:
    image: example/app:latest
    ${field}
`, {}, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.steps.map(({ step }) => step), ['parse', 'unsupported']);
  }
});

test('ports outside the supported forms are rejected', () => {
  for (const port of ['8080', '0:80', '70000:80', '8080-8082:80', '999.1.1.1:8080:80', 'nas.local:8080:80', '::1:8080:80', '1.2.3.4:8080:70000']) {
    const parsed = parseCompose(`services:
  app:
    image: example/app:latest
    ports:
      - "${port}"
`);
    assert.equal(parsed.ok, false, port);
    assert.match(parsed.error, /unsupported port mapping/);
  }
});

test('accepts a host bind address', () => {
  for (const port of ['127.0.0.1:8080:80', '192.168.1.10:8080:80', '0.0.0.0:8080:80', '10.0.0.1:8080:80/udp']) {
    const parsed = parseCompose(`services:
  app:
    image: example/app:latest
    ports:
      - "${port}"
`);
    assert.equal(parsed.ok, true, port);
  }
});

test('a Docker socket bind is refused on the server, read-only or not', async () => {
  for (const bind of ['/var/run/docker.sock:/var/run/docker.sock:ro', '/var/run/docker.sock:/var/run/docker.sock', '/run/docker.sock:/tmp/docker.sock:ro']) {
    const parsed = parseCompose(`services:
  app:
    image: example/app:1.0
    volumes:
      - ${bind}
`);
    assert.equal(parsed.ok, true, bind);
    assert.equal(dangerousBinds(parsed).length, 1, bind);

    const result = await deployStack('socket-test', `services:
  app:
    image: example/app:1.0
    volumes:
      - ${bind}
`, {}, true);
    assert.equal(result.ok, false, bind);
    assert.equal(result.created, 0, bind);
    assert.deepEqual(result.steps.map(({ step }) => step), ['parse', 'unsafe'], bind);
    assert.match(result.steps[1].note, /socket/i, bind);
  }
});

test('a broad host bind is refused on the server before Docker is touched', async () => {
  for (const bind of ['/:/host', '/etc:/host-etc:ro', '/var:/host-var']) {
    const result = await deployStack('broad-test', `services:
  app:
    image: example/app:1.0
    volumes:
      - ${bind}
`, {}, true);
    assert.equal(result.ok, false, bind);
    assert.equal(result.created, 0, bind);
    assert.deepEqual(result.steps.map(({ step }) => step), ['parse', 'unsafe'], bind);
  }
});

test('rejects sensitive host paths after normalisation', async () => {
  const blocked = [
    '/etc/shadow:/host/shadow:ro',
    '/root/.ssh:/host/ssh:ro',
    '/root/.ssh/id_ed25519:/host/key:ro',
    '/var/lib/containerd:/host/containerd:ro',
    '/var/lib/docker:/host/docker:ro',
    '/var/lib/docker/containers:/host/containers:ro',
    '/var/run:/host/run:ro',
    '/var/run/containerd/containerd.sock:/host/containerd.sock:ro',
    '/run/containerd/containerd.sock:/host/containerd.sock:ro',
    '/srv/app/../../etc/shadow:/host/shadow:ro',
  ];
  for (const bind of blocked) {
    const yaml = `services:
  app:
    image: example/app:1.0
    volumes:
      - ${bind}
`;
    const parsed = parseCompose(yaml);
    assert.equal(parsed.ok, true, bind);
    assert.equal(dangerousBinds(parsed).length, 1, bind);
    const result = await deployStack('sensitive-bind-test', yaml, {}, true);
    assert.equal(result.ok, false, bind);
    assert.equal(result.created, 0, bind);
    assert.deepEqual(result.steps.map(({ step }) => step), ['parse', 'unsafe'], bind);
  }
});

test('host binds require a declared root', () => {
  const parse = (bind) => parseCompose(`services:
  app:
    image: example/app:1.0
    volumes:
      - ${bind}
`);

  const declared = parseDeployBindRoots('/volume1/docker,/srv/radarr,/mnt/media,/etc/localtime');
  for (const bind of [
    '/volume1/docker/radarr/config.xml:/config/config.xml:ro',
    '/srv/radarr/config:/config',
    '/mnt/media/movies:/movies:ro',
  ]) {
    const parsed = parse(bind);
    assert.equal(parsed.ok, true, bind);
    assert.deepEqual(dangerousBinds(parsed, declared), [], `${bind} is under a declared root`);
    const refused = dangerousBinds(parsed, []);
    assert.equal(refused.length, 1, bind);
    assert.equal(refused[0].kind, 'unlisted');
    assert.match(refused[0].reason, /allows no host paths at all/);
  }

  for (const bind of [
    '/etc/passwd:/etc/passwd:ro',
    '/etc/sudoers:/etc/sudoers:ro',
    '/etc/docker/daemon.json:/x:ro',
    '/home/operator/.ssh:/keys:ro',
    '/proc/sys:/x',
    '/volume1/homes:/homes',
    '/boot/efi:/x:ro',
  ]) {
    const parsed = parse(bind);
    assert.equal(parsed.ok, true, bind);
    const verdict = dangerousBinds(parsed, declared);
    assert.equal(verdict.length, 1, `${bind} must not deploy`);
    assert.ok(['unlisted', 'host'].includes(verdict[0].kind), bind);
  }

  const named = parseCompose(`services:
  app:
    image: example/app:1.0
    volumes:
      - app-config:/config
volumes:
  app-config:
`);
  assert.equal(named.ok, true);
  assert.deepEqual(dangerousBinds(named, []), [], 'named volumes need no declaration');
});

test('dangerous declared roots authorize no binds', () => {
  assert.deepEqual(parseDeployBindRoots('/'), []);
  assert.deepEqual(parseDeployBindRoots('/var'), []);
  assert.deepEqual(parseDeployBindRoots('/srv'), ['/srv']);
  assert.deepEqual(parseDeployBindRoots('/opt'), ['/opt']);
  assert.deepEqual(parseDeployBindRoots('/var/run'), []);
  assert.deepEqual(parseDeployBindRoots('/root/.ssh'), []);
  assert.deepEqual(parseDeployBindRoots('/volume1/docker'), ['/volume1/docker']);
  assert.deepEqual(parseDeployBindRoots('/,/var,/volume1/docker'), ['/volume1/docker']);
  assert.deepEqual(parseDeployBindRoots('/volume1/docker/../../etc'), []);
  for (const tree of ['/etc', '/usr', '/home', '/boot', '/proc', '/sys', '/dev', '/bin']) {
    assert.deepEqual(parseDeployBindRoots(tree), [], tree);
  }
  assert.deepEqual(parseDeployBindRoots('/etc/localtime'), ['/etc/localtime']);
  assert.deepEqual(parseDeployBindRoots('/volume2'), ['/volume2']);
});

test('user-deployed Compose cannot claim Companion protection identities', async () => {
  const blocked = [
    ['service name', `services:
  companion:
    image: example/app:1.0
`],
    ['socket proxy service name', `services:
  socket-proxy:
    image: example/app:1.0
`],
    ['container name', `services:
  app:
    image: example/app:1.0
    container_name: qm-companion
`],
    ['map label', `services:
  app:
    image: example/app:1.0
    labels:
      qm.protected: "true"
`],
    ['list label', `services:
  app:
    image: example/app:1.0
    labels:
      - qm.protected=true
`],
    ['substituted label', `services:
  app:
    image: example/app:1.0
    labels:
      - \${LABEL_NAME}=true
`],
  ];
  for (const [label, yaml] of blocked) {
    const env = label === 'substituted label' ? { LABEL_NAME: 'qm.protected' } : {};
    const parsed = parseCompose(label === 'substituted label' ? yaml.replace('\${LABEL_NAME}', env.LABEL_NAME) : yaml);
    assert.equal(parsed.ok, true, label);
    assert.equal(reservedProtectionClaims(parsed).length, 1, label);
    const result = await deployStack('reserved-test', yaml, env, true);
    assert.equal(result.ok, false, label);
    assert.equal(result.created, 0, label);
    assert.deepEqual(result.steps.map(({ step }) => step), ['parse', 'reserved'], label);
    assert.match(result.steps[1].note, /reserved|protection identity/i, label);
  }
});

test('ordinary service identities and non-protection qm labels stay available', () => {
  const parsed = parseCompose(`services:
  app:
    image: example/app:1.0
    container_name: media-app
    labels:
      qm.url: https://media.example.test
`);
  assert.equal(parsed.ok, true);
  assert.deepEqual(reservedProtectionClaims(parsed), []);
});

test('a narrow named-volume deploy is not caught by the host-control boundary', () => {
  const parsed = parseCompose(`services:
  app:
    image: example/app:1.0
    volumes:
      - app-data:/config
volumes:
  app-data:
`);
  assert.equal(parsed.ok, true);
  assert.deepEqual(dangerousBinds(parsed), []);
});

test('named volumes must be declared and bind mounts must be absolute', () => {
  const undeclared = parseCompose(`services:
  app:
    image: example/app:latest
    volumes:
      - app-data:/data
`);
  assert.equal(undeclared.ok, false);
  assert.match(undeclared.error, /undeclared named volume/);

  const relative = parseCompose(`services:
  app:
    image: example/app:latest
    volumes:
      - ./config:/config
`);
  assert.equal(relative.ok, false);
  assert.match(relative.error, /unsupported volume mapping/);
});

test('rejected bind roots remain in validation results', async () => {
  const probe = await import(`../src/compose.js?rejects=${Date.now()}`);
  void probe;
  const { REJECTED_BIND_ROOTS } = await import('../src/compose.js');
  assert.ok(Array.isArray(REJECTED_BIND_ROOTS), 'the rejects are exposed, not discarded');
});

test('documents the bind-root symlink risk', () => {
  const guide = readFileSync(new URL('../docs/docker-access.md', import.meta.url).pathname, 'utf8');
  assert.match(guide, /permitted host root still trusts other processes/);
  assert.match(guide, /symbolic links/);
});
