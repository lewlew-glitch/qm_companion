import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const base = join(root, 'docker-compose.example.yml');
const saltbox = join(root, 'docker-compose.saltbox.yml');
const mobile = join(root, 'docker-compose.mobile.yml');

const ENV = {
  SECRET_KEY: 'dd'.repeat(32),
  QM_PROXY_KEY: 'ee'.repeat(32),
  QM_HOST: 'companion.example.test',
  QM_COMPANION_DOMAIN: 'companion.example.test',
  QM_TRAEFIK_CERTRESOLVER: 'cfdns',
};

const MOBILE_ENV = {
  ...ENV,
  QM_MOBILE_BIND_IP: '192.0.2.20',
  QM_ADVERTISED_ORIGIN: 'https://192.0.2.20:8788',
};

const haveCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

function render(files, env = ENV) {
  return spawnSync(
    'docker',
    ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } },
  );
}

function config(files, env = ENV) {
  const result = render(files, env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function publishedPorts(service) {
  return (service.ports ?? []).map((port) => String(port.published));
}

test('Saltbox routes Companion through Traefik without exposing the panel port', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const services = config([base, saltbox]).services;
  const companion = services.companion;
  const proxy = services['socket-proxy'];

  assert.deepEqual(Object.keys(companion.networks).sort(), ['qm-egress', 'qm-internal', 'saltbox']);
  assert.equal(companion.environment.TRUST_PROXY, 'true');
  assert.ok(!publishedPorts(companion).includes('8787'));

  const labels = companion.labels ?? {};
  assert.equal(labels['traefik.enable'], 'true');
  assert.equal(labels['traefik.docker.network'], 'saltbox');
  assert.equal(labels['traefik.http.routers.qm-companion.rule'], 'Host(`companion.example.test`)');
  assert.equal(labels['traefik.http.routers.qm-companion.tls.certresolver'], 'cfdns');
  assert.equal(labels['qm.protected'], 'true');
  assert.ok(Object.entries(labels).some(([key, value]) => (
    key.startsWith('traefik.http.services.')
      && key.endsWith('.loadbalancer.server.port')
      && value === '8787'
  )));

  assert.deepEqual(Object.keys(proxy.networks), ['qm-internal']);
  assert.deepEqual(proxy.ports ?? [], []);

  assert.equal(companion.volumes.length, 1);
  assert.equal(companion.volumes[0].type, 'volume');
  assert.equal(companion.volumes[0].source, 'qm-data');
  assert.equal(companion.volumes[0].target, '/data');
  assert.ok((companion.volumes ?? []).every((volume) => (
    !String(volume.source).includes('docker.sock')
      && !String(volume.target).includes('docker.sock')
  )));
});

test('Saltbox refuses to render without its required values', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  for (const name of ['QM_HOST', 'QM_COMPANION_DOMAIN', 'QM_TRAEFIK_CERTRESOLVER']) {
    const result = render([base, saltbox], { ...ENV, [name]: '' });
    assert.notEqual(result.status, 0, `${name} must be required`);
    assert.match(result.stderr, new RegExp(`${name} is required`));
  }
});

test('the mobile overlay must follow Saltbox to keep its direct port', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const mobileLast = config([base, saltbox, mobile], MOBILE_ENV).services.companion;
  assert.ok(publishedPorts(mobileLast).includes('8788'));
  assert.ok(!publishedPorts(mobileLast).includes('8787'));

  const saltboxLast = config([base, mobile, saltbox], MOBILE_ENV).services.companion;
  assert.ok(!publishedPorts(saltboxLast).includes('8788'));
});
