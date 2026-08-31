
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DUMMY_SECRET = 'dd'.repeat(32);
const DUMMY_PROXY_KEY = 'ee'.repeat(32);
const ENV = {
  SECRET_KEY: DUMMY_SECRET,
  QM_PROXY_KEY: DUMMY_PROXY_KEY,
  QM_HOST: '192.0.2.10',
  QM_MOBILE_BIND_IP: '192.0.2.10',
  QM_ADVERTISED_ORIGIN: 'https://192.0.2.10:8788',
};

const haveCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const LOCAL_OVERLAY = join(root, 'docker-compose.nas.yml');
const EXAMPLE_OVERLAY = join(root, 'docker-compose.nas.example.yml');

function render(overlay, env = ENV) {
  return spawnSync(
    'docker',
    ['compose', '-f', join(root, 'docker-compose.example.yml'), '-f', overlay, 'config', '--format', 'json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } },
  );
}

function assertContract(doc, label) {
  const services = doc.services ?? {};
  const companion = services.companion;
  const proxy = services['socket-proxy'];
  assert.ok(companion, `${label}: a companion service`);
  assert.ok(proxy, `${label}: a socket-proxy service`);

  const companionKey = companion.environment?.QM_PROXY_KEY;
  const proxyKey = proxy.environment?.QM_PROXY_KEY;
  assert.equal(typeof companionKey, 'string', `${label}: companion carries QM_PROXY_KEY`);
  assert.equal(typeof proxyKey, 'string', `${label}: the proxy demands QM_PROXY_KEY`);
  assert.equal(companionKey, proxyKey, `${label}: both sides resolve the same key`);
  assert.ok(companionKey.length >= 32, `${label}: the key clears the floor the proxy enforces`);
  assert.notEqual(companionKey, companion.environment?.SECRET_KEY, `${label}: it is not SECRET_KEY`);

  assert.ok(!proxy.ports || proxy.ports.length === 0, `${label}: the proxy publishes no ports`);
  const proxyNetworks = Object.keys(proxy.networks ?? {});
  assert.deepEqual(proxyNetworks, ['qm-internal'], `${label}: the proxy is internal only`);

  for (const port of companion.ports ?? []) {
    assert.ok(port.host_ip, `${label}: published port ${port.published} names a host address`);
    assert.notEqual(port.host_ip, '0.0.0.0', `${label}: port ${port.published} is not every interface`);
  }

  assert.match(String(companion.environment?.DOCKER_HOST ?? ''), /^tcp:\/\/socket-proxy:/, `${label}: DOCKER_HOST`);
  for (const volume of companion.volumes ?? []) {
    assert.doesNotMatch(String(volume.source ?? ''), /docker\.sock/, `${label}: no raw socket mount`);
  }

  for (const [name, service] of [['companion', companion], ['socket-proxy', proxy]]) {
    assert.ok(!service.network_mode, `${label}: ${name} does not use network_mode`);
  }

  for (const volume of companion.volumes ?? []) {
    const source = String(volume.source ?? '');
    assert.ok(
      !/^\/(var\/)?run(\/|$)/.test(source) && !/docker\.sock/.test(source),
      `${label}: no mount that contains the runtime socket (${source})`,
    );
  }

  for (const [name, service] of [['companion', companion], ['socket-proxy', proxy]]) {
    assert.equal(service.read_only, true, `${label}: ${name} is read_only`);
    assert.deepEqual(service.cap_drop, ['ALL'], `${label}: ${name} drops all capabilities`);
    assert.ok(
      (service.security_opt ?? []).includes('no-new-privileges:true'),
      `${label}: ${name} sets no-new-privileges`,
    );
    assert.notEqual(service.privileged, true, `${label}: ${name} is not privileged`);
    assert.deepEqual(service.cap_add ?? [], [], `${label}: ${name} adds no capabilities back`);
    assert.ok(!(service.pid || '').includes('host'), `${label}: ${name} does not share the host PID namespace`);
  }

  const env = proxy.environment ?? {};
  for (const [key, forbidden] of [['POST', '1'], ['EXEC', '1'], ['AUTH', '1'], ['SECRETS', '1'], ['CONFIGS', '1']]) {
    assert.notEqual(
      String(env[key] ?? '0'),
      forbidden,
      `${label}: the overlay does not enable ${key} on its own (use the management or shell profile)`,
    );
  }
}

test('the committed NAS contract renders and satisfies every rule', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const out = render(EXAMPLE_OVERLAY);
  assert.equal(out.status, 0, out.stderr);
  assertContract(JSON.parse(out.stdout), 'example overlay');
});

test('refuses to render the NAS contract without QM_PROXY_KEY', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const out = render(EXAMPLE_OVERLAY, { ...ENV, QM_PROXY_KEY: '' });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /QM_PROXY_KEY is required/);
});

test('a local overlay satisfies the same contract when present', { skip: !haveCompose && 'docker compose unavailable' }, (t) => {
  if (!existsSync(LOCAL_OVERLAY)) {
    t.skip('optional docker-compose.nas.yml is absent');
    return;
  }
  const out = render(LOCAL_OVERLAY);
  assert.equal(out.status, 0, out.stderr);
  assertContract(JSON.parse(out.stdout), 'local overlay');
});

test('bundled example omits addresses, paths, and secrets', () => {
  const text = readFileSync(EXAMPLE_OVERLAY, 'utf8');
  assert.doesNotMatch(text, /\b10\.(?:\d{1,3}\.){2}\d{1,3}\b/, 'no private 10/8 address');
  assert.doesNotMatch(text, /\b172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}\b/, 'no private 172.16/12 address');
  assert.doesNotMatch(text, /\b192\.168\.(?:\d{1,3}\.)\d{1,3}\b/, 'no private 192.168/16 address');
  assert.doesNotMatch(text, /\/volume\d+\//, 'no real NAS bind path');
  assert.doesNotMatch(text, /ts\.net/, 'no tailnet name');
  assert.doesNotMatch(text, /[0-9a-f]{32,}/i, 'no literal secret');
  assert.match(text, /192\.0\.2\./, 'documentation addresses only');
});

test('the local overlay stays out of the repository', () => {
  const ignored = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(ignored, /^docker-compose\.nas\.yml$/m, 'the local overlay is gitignored');
  const tracked = spawnSync('git', ['ls-files', 'docker-compose.nas.yml'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.stdout.trim(), '', 'and it is not tracked');
});

const BROKEN = [
  ['the proxy loses the key', (t) => t.replace(/^ {6}QM_PROXY_KEY:.*$/m, '      QM_PROXY_KEY: ""')],
  ['companion loses the key', (t) => t.replace(/(companion:[\s\S]*?)^ {6}QM_PROXY_KEY:.*$/m, '$1      QM_PROXY_KEY: "different-value-entirely-32-chars"')],
  ['the key is too short', (t) => t.replace(/\$\{QM_PROXY_KEY:\?[^}]*\}/g, 'short')],
  ['the proxy publishes a port', (t) => t.replace('    networks: !override [qm-internal]', '    ports:\n      - "192.0.2.10:2375:2375"\n    networks: !override [qm-internal]')],
  ['the proxy joins the egress network', (t) => t.replace('    networks: !override [qm-internal]', '    networks: !override [qm-internal, qm-egress]')],
  ['companion publishes on every interface', (t) => t.replace('      - "192.0.2.10:8787:8787"', '      - "8787:8787"')],
  ['companion is on the host network', (t) => t.replace('    networks: !override [qm-internal, qm-egress]', '    network_mode: host\n    networks: !reset null')],
  ['DOCKER_HOST points at a raw socket', (t) => t.replace('DOCKER_HOST: "tcp://socket-proxy:2375"', 'DOCKER_HOST: "unix:///var/run/docker.sock"')],
  ['the socket arrives via its parent directory', (t) => t.replace('      - qm-data:/data', '      - /var/run:/var/run\n      - qm-data:/data')],
  ['companion is privileged', (t) => t.replace('    read_only: true\n    cap_drop: !override [ALL]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=16m,mode=1777', '    privileged: true\n    read_only: true\n    cap_drop: !override [ALL]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=16m,mode=1777')],
  ['capabilities are added back', (t) => t.replace('    cap_drop: !override [ALL]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=16m', '    cap_drop: !override [ALL]\n    cap_add: [SYS_ADMIN]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=16m')],
  ['the proxy quietly enables POST', (t) => t.replace('      POST: 0', '      POST: 1')],
  ['the proxy quietly enables EXEC', (t) => t.replace('      EXEC: 0', '      EXEC: 1')],
  ['the proxy quietly enables AUTH', (t) => t.replace('      AUTH: 0', '      AUTH: 1')],
  ['companion is no longer read only', (t) => t.replace(
    '    read_only: true\n    cap_drop: !override [ALL]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=16m',
    '    read_only: false\n    cap_drop: !override [ALL]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=16m')],
  ['the proxy is no longer read only', (t) => t.replace(
    '    read_only: true\n    cap_drop: !override [ALL]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=4m',
    '    read_only: false\n    cap_drop: !override [ALL]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=4m')],
  ['the proxy keeps capabilities', (t) => t.replace(
    '    cap_drop: !override [ALL]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=4m',
    '    cap_drop: !override [NET_RAW]\n    security_opt: !override [no-new-privileges:true]\n    tmpfs: !override\n      - /tmp:size=4m')],
  ['no-new-privileges is removed', (t) => t.replace(
    '    security_opt: !override [no-new-privileges:true]',
    '    security_opt: !override []')],
  ['the socket is mounted at another target', (t) => t.replace(
    '      - qm-data:/data',
    '      - /var/run/docker.sock:/host/docker-control.sock\n      - qm-data:/data')],
];

test('every contract rule refuses a real broken overlay', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const base = readFileSync(EXAMPLE_OVERLAY, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'qm-nas-contract-'));
  try {
    for (const [name, mutate] of BROKEN) {
      const text = mutate(base);
      assert.notEqual(text, base, `${name}: the mutation did not apply, so this case proves nothing`);
      const file = join(dir, 'docker-compose.broken.yml');
      writeFileSync(file, text);
      const out = render(file);
      let caught = null;
      if (out.status !== 0) {
        caught = new Error(out.stderr.slice(0, 200));
      } else {
        try {
          assertContract(JSON.parse(out.stdout), name);
        } catch (error) {
          caught = error;
        }
      }
      assert.ok(caught, `${name}: rendered clean and the contract ACCEPTED it`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
