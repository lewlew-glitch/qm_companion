import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';


const root = join(import.meta.dirname, '..');

function preflight(env) {
  return spawnSync(process.execPath, ['scripts/preflight-mobile.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, QM_MOBILE_BIND_IP: '', QM_ADVERTISED_ORIGIN: '', MOBILE_PORT: '', ...env },
  });
}

function preflightBlock(guide) {
  const match = guide.match(/```sh\n(\([\s\S]*?node scripts\/preflight-mobile\.mjs[\s\S]*?\))\n```/);
  assert.ok(match, 'the preflight runs in a subshell');
  assert.doesNotMatch(match[1], /\bunset\b/, 'the parent shell environment is untouched');
  return match[1];
}

test('preflight accepts an address assigned to the host', () => {
  const ok = preflight({ QM_MOBILE_BIND_IP: '127.0.0.1', QM_ADVERTISED_ORIGIN: 'https://127.0.0.1:8788' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /is assigned to this host/);
  assert.match(ok.stdout, /Safe to deploy/);
  assert.match(ok.stdout, /after files that change ports/);
});

test('unowned addresses fail preflight with guidance', () => {
  const bad = preflight({ QM_MOBILE_BIND_IP: '203.0.113.7', QM_ADVERTISED_ORIGIN: 'https://203.0.113.7:8788' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /is not an address on this host/);
  assert.match(bad.stdout, /taking the 8787 panel with it/);
});

test('wildcard, missing, and mismatched values fail preflight', () => {
  const wildcard = preflight({ QM_MOBILE_BIND_IP: '0.0.0.0', QM_ADVERTISED_ORIGIN: 'https://127.0.0.1:8788' });
  assert.equal(wildcard.status, 1);
  assert.match(wildcard.stdout, /unspecified \(wildcard\) address/);

  const missing = preflight({});
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /QM_MOBILE_BIND_IP is not set/);
  assert.match(missing.stdout, /QM_ADVERTISED_ORIGIN is not set/);

  const mismatch = preflight({ QM_MOBILE_BIND_IP: '127.0.0.1', QM_ADVERTISED_ORIGIN: 'https://127.0.0.1:9999', MOBILE_PORT: '8788' });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stdout, /does not match MOBILE_PORT/);
});

test('Tailscale configuration accepts distinct bind and origin values', () => {
  const ts = preflight({ QM_MOBILE_BIND_IP: '127.0.0.1', QM_ADVERTISED_ORIGIN: 'https://nas.tail1a2b3c.ts.net:8788' });
  assert.equal(ts.status, 0, ts.stdout);
  assert.match(ts.stdout, /differs from the bind address/);
  assert.match(ts.stdout, /Tailscale MagicDNS install/);
});

test('mobile guide separates publish and listener failures', () => {
  const guide = readFileSync(join(root, 'docs', 'mobile-connection.md'), 'utf8');
  assert.doesNotMatch(guide, /\*\*Failure stays contained\.\*\* Whatever goes wrong/);
  assert.match(guide, /### Failure behavior/);
  assert.match(guide, /Docker refuses to start the container and port 8787 is unavailable as well/);
  assert.match(guide, /internal listener may still report healthy/);
  assert.match(guide, /scripts\/preflight-mobile\.mjs/);
  assert.match(guide, /address owned only by a container/);
  assert.match(guide, /without a host `tailscale0` address/);
  assert.match(guide, /Enter `8788` in Mobile HTTPS port/);
  assert.match(guide, /`QM_MOBILE_BIND_IP` is used only to build the host-side port mapping in Docker Compose/);
  assert.match(guide, /normal port 8787 reverse-proxy address cannot be used for sign-in/);
  assert.match(guide, /does not restrict the listener to Tailscale/);
  preflightBlock(guide);
});

test('Saltbox contains the preflight environment and runs it before deployment', () => {
  const guide = readFileSync(join(root, 'docs', 'saltbox.md'), 'utf8');
  const preflight = guide.indexOf('node scripts/preflight-mobile.mjs');
  const deploy = guide.indexOf('docker-compose.saltbox.yml -f docker-compose.mobile.yml up -d --build');
  assert.notEqual(preflight, -1);
  assert.notEqual(deploy, -1);
  assert.ok(preflight < deploy, 'the preflight appears before the mobile start command');
  preflightBlock(guide);
  assert.match(guide, /address that is assigned to the Docker host/);
  assert.match(guide, /Tailscale container or userspace network/);
});
