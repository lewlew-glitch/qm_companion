import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_GID,
  APP_UID,
  PROXY_SWITCHES,
  accessPlan,
  companionEnvironment,
  proxyConfig,
  proxyEnvironment,
  proxyKey,
  proxyPort,
  socketProblem,
} from '../src/all-in-one/plan.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function read(name) {
  return readFileSync(join(projectRoot, name), 'utf8');
}

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

function socketStats({ socket = true, mode, uid = 0, gid = 0 }) {
  return { isSocket: () => socket, mode, uid, gid };
}

test('access follows DOCKER_ACCESS_MAX the way the overlays set the proxy', () => {
  assert.deepEqual(accessPlan(undefined), { mode: 'read', POST: '0', EXEC: '0' });
  for (const [file, mode] of [['docker-compose.management.yml', 'manage'], ['docker-compose.shell.yml', 'shell']]) {
    const proxy = environment(read(file), 'socket-proxy');
    assert.deepEqual(accessPlan(mode), { mode, POST: proxy.POST, EXEC: proxy.EXEC }, file);
  }
  for (const raw of ['', 'Read', 'write', 'manage ']) {
    assert.throws(() => accessPlan(raw), /DOCKER_ACCESS_MAX must be exactly read, manage or shell/);
  }
});

test('the proxy switches match the published read-only profile', () => {
  const published = environment(read('docker-compose.published.yml'), 'socket-proxy');
  for (const [name, value] of Object.entries(published)) {
    if (name === 'QM_PROXY_KEY' || name === 'POST' || name === 'EXEC') continue;
    assert.equal(PROXY_SWITCHES[name], value, name);
  }
  assert.equal(published.POST, accessPlan('read').POST);
  assert.equal(published.EXEC, accessPlan('read').EXEC);
  assert.equal(PROXY_SWITCHES.EVENTS, '1');
  assert.equal(PROXY_SWITCHES.VERSION, '1');
  for (const off of ['AUTH', 'BUILD', 'COMMIT', 'SECRETS', 'SWARM', 'PLUGINS', 'ALLOW_START']) {
    assert.equal(Object.hasOwn(PROXY_SWITCHES, off), false, off);
  }
});

test('the proxy port defaults to 2375 and must be a port', () => {
  assert.equal(proxyPort(undefined), 2375);
  assert.equal(proxyPort('23750'), 23750);
  for (const raw of ['0', '65536', 'abc', '-1', '2375 ']) {
    assert.throws(() => proxyPort(raw), /PROXY_PORT must be a whole number from 1 to 65535/);
  }
});

test('the socket must keep the node user out', () => {
  assert.equal(socketProblem(null), 'missing');
  assert.equal(socketProblem(socketStats({ socket: false, mode: 0o40755 })), 'not a socket');
  assert.equal(socketProblem(socketStats({ mode: 0o140660 })), null);
  assert.equal(socketProblem(socketStats({ mode: 0o140660, gid: 999 })), null);
  assert.equal(socketProblem(socketStats({ mode: 0o140600, gid: APP_GID })), null);
  assert.equal(socketProblem(socketStats({ mode: 0o140666 })), 'open to companion');
  assert.equal(socketProblem(socketStats({ mode: 0o140602 })), 'open to companion');
  assert.equal(socketProblem(socketStats({ mode: 0o140660, gid: APP_GID })), 'open to companion');
  assert.equal(socketProblem(socketStats({ mode: 0o140600, uid: APP_UID })), 'open to companion');
});

test('the proxy listens on loopback only', () => {
  const template = 'frontend dockerfrontend\n    bind ${BIND_CONFIG}\n';
  assert.equal(proxyConfig(template, 2375), 'frontend dockerfrontend\n    bind 127.0.0.1:2375\n');
  assert.equal(proxyConfig(template, 23750), 'frontend dockerfrontend\n    bind 127.0.0.1:23750\n');
  assert.throws(() => proxyConfig('frontend dockerfrontend\n    bind :2375\n', 2375), /BIND_CONFIG/);
  assert.throws(() => proxyConfig(`${template}${template}`, 2375), /BIND_CONFIG/);
});

test('each start gets its own proxy key', () => {
  const first = proxyKey();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(proxyKey(), first);
});

test('the proxy gets only its own settings', () => {
  const env = proxyEnvironment({ key: 'k'.repeat(64), access: accessPlan('manage'), path: '/usr/bin' });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    LOG_LEVEL: 'warning',
    SOCKET_PATH: '/var/run/docker.sock',
    QM_PROXY_KEY: 'k'.repeat(64),
    ...PROXY_SWITCHES,
    POST: '1',
    EXEC: '0',
  });
});

test('Companion keeps the container settings and is pointed at the proxy', () => {
  const env = companionEnvironment(
    { SECRET_KEY: '5c'.repeat(32), QM_HOST: 'nas.local', DOCKER_HOST: 'unix:///var/run/docker.sock', HOME: '/root' },
    { key: 'k'.repeat(64), access: accessPlan(undefined), port: 2375 },
  );
  assert.deepEqual(env, {
    SECRET_KEY: '5c'.repeat(32),
    QM_HOST: 'nas.local',
    DOCKER_HOST: 'tcp://127.0.0.1:2375',
    HOME: '/home/node',
    QM_PROXY_KEY: 'k'.repeat(64),
    DOCKER_ACCESS_MAX: 'read',
  });
});

test('the all-in-one image builds the proxy exactly like the proxy image', () => {
  const single = read('Dockerfile.all-in-one');
  const proxy = read('Dockerfile.socket-proxy');
  const base = read('Dockerfile');
  const from = (text) => [...text.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(from(single), [...from(proxy), ...from(base)]);
  const patch = proxy.slice(proxy.indexOf('RUN apk upgrade'));
  assert.ok(patch.includes('set-var(txn.qmkey) env(QM_PROXY_KEY)'));
  assert.ok(single.includes(patch.trimEnd()), 'the template patch is copied unchanged');
  assert.match(single, /^COPY --from=proxy \/usr\/local\/etc\/haproxy\/haproxy\.cfg\.template /m);
  assert.match(single, /apk add --no-cache haproxy/);
  assert.match(single, /QM_ALL_IN_ONE=1/);
  assert.match(single, /^USER root$/m);
  assert.match(single, /^ENTRYPOINT \["node", "src\/all-in-one\/start\.js"\]$/m);
});

test('the all-in-one compose file mounts the socket for the proxy and ships no key', () => {
  const text = read('docker-compose.all-in-one.yml');
  const block = serviceBlock(text, 'companion').join('\n');
  assert.match(block, /^ {4}image: ghcr\.io\/lewlew-glitch\/qm-companion-all-in-one:\$\{QM_COMPANION_TAG:-latest\}$/m);
  assert.doesNotMatch(text, /^\s*build:/m);
  assert.doesNotMatch(text, /socket-proxy:|QM_PROXY_KEY:|DOCKER_HOST:/);
  assert.match(block, /SECRET_KEY: "\$\{SECRET_KEY:\?/);
  assert.match(block, /^ {6}- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro$/m);
  assert.match(block, /^ {4}read_only: true$/m);
  assert.match(block, /^ {4}cap_drop: \[ALL\]$/m);
  assert.match(block, /^ {4}cap_add: \[SETUID, SETGID\]$/m);
  assert.match(block, /no-new-privileges:true/);
  assert.match(block, /qm\.protected: "true"/);
  assert.equal(environment(text, 'companion').DOCKER_ACCESS_MAX, 'read');
});

test('the all-in-one compose file keeps the published Companion settings', () => {
  const published = environment(read('docker-compose.published.yml'), 'companion');
  const single = environment(read('docker-compose.all-in-one.yml'), 'companion');
  delete published.DOCKER_HOST;
  delete published.QM_PROXY_KEY;
  assert.deepEqual(single, published);
  const mounts = (text) => serviceBlock(text, 'companion').filter((line) => /^\s+#? ?- \/volume1\//.test(line));
  assert.deepEqual(mounts(read('docker-compose.all-in-one.yml')), mounts(read('docker-compose.published.yml')));
});

test('releases publish the all-in-one image', () => {
  const workflow = read('.github/workflows/container-images.yml');
  assert.match(workflow, /- image: ghcr\.io\/lewlew-glitch\/qm-companion-all-in-one\n\s+cache: qm-companion-all-in-one\n\s+dockerfile: \.\/Dockerfile\.all-in-one\n/);
});

test('scripts run with docker exec switch to the node user before reading state', () => {
  for (const file of ['src/mobile/rotate-cert.js', 'src/mobile/repair.js']) {
    const imports = [...read(file).matchAll(/^import .*$/gm)].map((match) => match[0]);
    assert.equal(imports[0], "import '../all-in-one/exec-user.js';", file);
  }
});
