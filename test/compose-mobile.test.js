import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const root = join(import.meta.dirname, '..');
const haveCompose = spawnSync('docker', ['compose', 'version'], { cwd: root, encoding: 'utf8' }).status === 0;

const haveNas = existsSync(join(root, 'docker-compose.nas.yml'));
const withNas = (combos) => combos.filter((files) => haveNas || !files.includes('nas'));

const DUMMY_SECRET = 'dd'.repeat(32);
const DUMMY_PROXY_KEY = 'ee'.repeat(32);
const LAN = { QM_HOST: '192.168.1.20', QM_MOBILE_BIND_IP: '192.168.1.20', QM_ADVERTISED_ORIGIN: 'https://192.168.1.20:8788', SECRET_KEY: DUMMY_SECRET, QM_PROXY_KEY: DUMMY_PROXY_KEY };
const TAILSCALE = { QM_HOST: '100.100.20.5', QM_MOBILE_BIND_IP: '100.100.20.5', QM_ADVERTISED_ORIGIN: 'https://nas.tail1a2b3c.ts.net:8788', SECRET_KEY: DUMMY_SECRET, QM_PROXY_KEY: DUMMY_PROXY_KEY };

const COMBINATIONS = withNas([
  ['example'],
  ['example', 'nas'],
  ['example', 'management'],
  ['example', 'shell'],
  ['example', 'mobile'],
  ['example', 'nas', 'mobile'],
  ['example', 'nas', 'management', 'mobile'],
  ['example', 'nas', 'shell', 'mobile'],
  ['example', 'management', 'mobile'],
  ['example', 'shell', 'mobile'],
]);

function compose(files, args, env = LAN) {
  return spawnSync('docker', ['compose', ...files.flatMap((f) => ['-f', `docker-compose.${f}.yml`]), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const render = (files, env = LAN) => compose(files, ['config'], env);

/** Parse the rendered companion service for comparison. */
function companion(files, env = LAN) {
  const out = render(files, env);
  assert.equal(out.status, 0, `${files.join('+')}: ${out.stderr}`);
  const lines = out.stdout.split('\n');
  const ports = [];
  const environment = {};
  let inCompanion = false;
  let section = null;
  for (const line of lines) {
    if (/^  [a-z0-9-]+:/.test(line)) {
      inCompanion = line.trim() === 'companion:';
      section = null;
      continue;
    }
    if (!inCompanion) continue;
    if (/^    [a-z_]+:/.test(line)) {
      section = line.trim().replace(/:.*$/, '');
      continue;
    }
    if (section === 'ports') {
      const host = /host_ip:\s*(\S+)/.exec(line);
      const published = /published:\s*"?(\d+)"?/.exec(line);
      const target = /target:\s*(\d+)/.exec(line);
      if (host) ports.push({ hostIp: host[1] });
      if (published && ports.length) ports[ports.length - 1].published = published[1];
      if (target && ports.length) ports[ports.length - 1].target = target[1];
    }
    if (section === 'environment') {
      const kv = /^\s{6}([A-Z_0-9]+):\s*(.*)$/.exec(line);
      if (kv) environment[kv[1]] = kv[2].replace(/^"|"$/g, '');
    }
  }
  return { ports, environment, stdout: out.stdout };
}

test('all profile combinations pass Compose validation', { skip: !haveCompose && 'docker compose is unavailable; validate with `docker compose -f ... config --quiet` in an environment that provides it' }, () => {
  for (const files of COMBINATIONS) {
    const result = compose(files, ['config', '--quiet']);
    assert.equal(result.status, 0, `${files.join('+')}: ${result.stderr}`);
  }
});

test('missing install values fail Compose interpolation by name', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const noBind = compose(['example', 'mobile'], ['config', '--quiet'], { ...LAN, QM_MOBILE_BIND_IP: '' });
  assert.notEqual(noBind.status, 0, 'a missing bind IP must not compose');
  assert.match(noBind.stderr, /QM_MOBILE_BIND_IP is required/);
  const noOrigin = compose(['example', 'mobile'], ['config', '--quiet'], { ...LAN, QM_ADVERTISED_ORIGIN: '' });
  assert.notEqual(noOrigin.status, 0, 'a missing advertised origin must not compose');
  assert.match(noOrigin.stderr, /QM_ADVERTISED_ORIGIN is required/);
  const neither = compose(['example', 'mobile'], ['config', '--quiet'], { ...LAN, QM_MOBILE_BIND_IP: '', QM_ADVERTISED_ORIGIN: '' });
  assert.notEqual(neither.status, 0);
});

test('SECRET_KEY reaches the merged Compose configuration', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const files = withNas([['example', 'nas', 'management', 'mobile']])[0] ?? ['example', 'management', 'mobile'];
  const { environment } = companion(files);
  assert.equal(environment.SECRET_KEY, DUMMY_SECRET, 'the supplied value is what the container gets');
  assert.match(environment.SECRET_KEY, /^[0-9a-f]{64}$/);

  const missing = compose(files, ['config', '--quiet'], { ...LAN, SECRET_KEY: '' });
  assert.notEqual(missing.status, 0, 'a missing secret must not render');
  assert.match(missing.stderr, /SECRET_KEY is required/);

  const example = readFileSync(join(root, 'docker-compose.example.yml'), 'utf8');
  assert.doesNotMatch(example, /SECRET_KEY: "PUT_A_64_HEX_KEY_HERE"/);
  assert.doesNotMatch(example, /SECRET_KEY: "[0-9a-fA-F]{64}"/);
  assert.match(example, /SECRET_KEY: "\$\{SECRET_KEY:\?/);
});

test('QM_PROXY_KEY reaches Companion and the proxy', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const files = withNas([['example', 'nas', 'management', 'mobile']])[0] ?? ['example', 'management', 'mobile'];
  assert.equal(companion(files).environment.QM_PROXY_KEY, DUMMY_PROXY_KEY);
  const rendered = render(files);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /QM_PROXY_KEY: e{64}/, 'the proxy service gets it as well');

  const missing = compose(files, ['config', '--quiet'], { ...LAN, QM_PROXY_KEY: '' });
  assert.notEqual(missing.status, 0, 'a missing proxy key must not render');
  assert.match(missing.stderr, /QM_PROXY_KEY is required/);

  const example = readFileSync(join(root, 'docker-compose.example.yml'), 'utf8');
  assert.doesNotMatch(example, /QM_PROXY_KEY: "[0-9a-fA-F]{32,}"/, 'no literal key ships in the file');
});

test('rejects placeholder and malformed secrets at runtime', () => {
  for (const value of ['PUT_A_64_HEX_KEY_HERE', '', 'short', 'zz'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(32)}c`, ' '.repeat(64)]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.js');"], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, SECRET_KEY: value },
    });
    assert.notEqual(result.status, 0, `SECRET_KEY=${value.slice(0, 12)}... must not boot`);
    assert.match(result.stdout + result.stderr, /SECRET_KEY/);
  }
  const ok = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.js');"], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SECRET_KEY: DUMMY_SECRET, QM_HOST: '192.168.1.20', DATA_DIR: mkdtempSync(join(tmpdir(), 'qm-secret-')) },
  });
  assert.equal(ok.status, 0, ok.stderr);
});

test('base profile does not publish a mobile listener', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const base = render(['example']);
  assert.equal(base.status, 0, base.stderr);
  assert.doesNotMatch(base.stdout, /8788|MOBILE_API_ENABLED/);
});

test('preserves the supplied values for every mobile combination', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  for (const files of withNas([['example', 'mobile'], ['example', 'nas', 'mobile'], ['example', 'nas', 'management', 'mobile'], ['example', 'nas', 'shell', 'mobile'], ['example', 'management', 'mobile'], ['example', 'shell', 'mobile']])) {
    const { ports, environment, stdout } = companion(files);
    const label = files.join('+');
    const mobile = ports.find((p) => p.target === '8788');
    const panelTarget = files.includes('nas') ? '18787' : '8787';
    const panel = ports.find((p) => p.target === panelTarget);
    assert.equal(environment.PORT || '8787', panelTarget, `${label}: the listener and published panel port agree`);
    assert.ok(panel, `${label}: the panel is still published`);
    assert.ok(mobile, `${label}: the mobile listener is published`);
    assert.equal(mobile.hostIp, LAN.QM_MOBILE_BIND_IP, `${label}: the 8788 publish uses the supplied host IP`);
    assert.equal(mobile.published, '8788', label);
    assert.equal(environment.QM_ADVERTISED_ORIGIN, LAN.QM_ADVERTISED_ORIGIN, label);
    assert.equal(environment.MOBILE_API_ENABLED, 'true', label);
    assert.equal(environment.MOBILE_ENROLMENT_ENABLED, 'true', label);
    assert.equal(environment.MOBILE_PORT, '8788', label);
    assert.equal(environment.MOBILE_BIND_ADDRESS, '0.0.0.0', label);
    assert.doesNotMatch(stdout, /\/data\/tls/, `${label}: the owner-supplied mount stays opt-in`);
    assert.doesNotMatch(readFileSync(join(root, 'docker-compose.mobile.yml'), 'utf8'), /^\s*SECRET_KEY:/m);
  }
  assert.equal(companion(['example', 'management', 'mobile']).environment.DOCKER_ACCESS_MAX, 'manage');
  assert.equal(companion(['example', 'shell', 'mobile']).environment.DOCKER_ACCESS_MAX, 'shell');
});

test('pairing can be disabled without disabling existing phone links', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const { environment } = companion(['example', 'mobile'], { ...LAN, MOBILE_ENROLMENT_ENABLED: 'false' });
  assert.equal(environment.MOBILE_API_ENABLED, 'true');
  assert.equal(environment.MOBILE_ENROLMENT_ENABLED, 'false');
});

test('supports distinct Tailscale bind IP and MagicDNS origin values', { skip: !haveCompose && 'docker compose unavailable' }, () => {
  const { ports, environment } = companion(['example', 'mobile'], TAILSCALE);
  const mobile = ports.find((p) => p.target === '8788');
  assert.equal(mobile.hostIp, '100.100.20.5');
  assert.equal(environment.QM_ADVERTISED_ORIGIN, 'https://nas.tail1a2b3c.ts.net:8788');
  assert.notEqual(mobile.hostIp, new URL(environment.QM_ADVERTISED_ORIGIN).hostname);
});

test('mobile overlay preserves the published port', { skip: (!haveCompose || !haveNas) && 'docker compose or the private nas override is unavailable' }, () => {
  const correct = companion(['example', 'nas', 'mobile']);
  assert.ok(correct.ports.find((p) => p.target === '8788'));
  const reversed = companion(['example', 'mobile', 'nas']);
  assert.equal(reversed.ports.find((p) => p.target === '8788'), undefined, 'mobile before nas loses the publish');
  assert.equal(reversed.environment.MOBILE_API_ENABLED, 'true');
});

test('guides document secret generation and preservation', () => {
  const install = readFileSync(join(root, 'README.md'), 'utf8');
  const recovery = readFileSync(join(root, 'docs', 'recovery.md'), 'utf8');
  assert.match(install, /openssl rand -hex 32/);
  assert.match(install, /umask 077/);
  assert.match(recovery, /An upgrade preserves the existing value/);
  assert.match(recovery, /without printing it/);
  assert.match(recovery, /SECRET_KEY length/);
  assert.doesNotMatch(`${install}\n${recovery}`, /SECRET_KEY=[0-9a-fA-F]{64}/, 'no real key is ever written down here');
});

test('documents required mobile values and overlay order', () => {
  const text = readFileSync(join(root, 'docker-compose.mobile.yml'), 'utf8');
  assert.match(text, /QM_MOBILE_BIND_IP/);
  assert.match(text, /QM_ADVERTISED_ORIGIN/);
  assert.match(text, /Apply this file after every Compose file that changes `ports`/);
  assert.match(text, /ports: !override/);
  assert.match(text, /Tailscale/);
  assert.match(text, /MagicDNS/);
  assert.match(text, /rotate-cert\.js --confirm/);
  assert.match(text, /no reverse-proxy, tunnel or Cloudflare support/i);
  assert.match(text, /no automatic LAN\/away switching/i);
  assert.doesNotMatch(text, /SECRET_KEY: /);
  assert.doesNotMatch(text, /^\s*-\s*"?\d{1,3}(\.\d{1,3}){3}:8788/m, 'no hard-coded publish address');
  assert.doesNotMatch(text, /QM_ADVERTISED_ORIGIN: "https:\/\/\d/, 'no hard-coded advertised origin');
});
