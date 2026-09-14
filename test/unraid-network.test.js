import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
async function template(name) {
  const xml = await readFile(new URL(`templates/${name}.xml`, root), 'utf8');
  const field = (tag) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '';
  const configs = [...xml.matchAll(/<Config\b[^>]*\/>/gu)].map(([tag]) => Object.fromEntries(
    [...tag.matchAll(/\b([A-Za-z]+)="([^"]*)"/gu)].map(([, key, value]) => [key, value]),
  ));
  return { name: field('Name'), network: field('Network'), image: field('Repository'),
    extras: field('ExtraParams').split(/\s+/u).filter(Boolean), configs };
}

function createArgs(t) {
  const args = ['create', '--pull=never', `--name=${t.name}`, `--network=${t.network}`, ...t.extras];
  const fixtures = { SECRET_KEY: 'a'.repeat(64), QM_PROXY_KEY: 'b'.repeat(64), QM_HOST: '192.0.2.10' };
  for (const config of t.configs) {
    const value = fixtures[config.Target] ?? config.Default;
    if (!value) continue;
    if (config.Type === 'Variable') args.push('--env', `${config.Target}=${value}`);
    if (config.Type === 'Port') args.push('--publish', `${value}:${config.Target}/${config.Mode}`);
    if (config.Type === 'Path') args.push('--volume', `${value}:${config.Target}:${config.Mode}`);
  }
  return [...args, t.image];
}

test('Unraid templates use the same named network and resolve the proxy without legacy links', async () => {
  const companion = await template('qm-companion'); const proxy = await template('qm-socket-proxy');
  assert.equal(companion.network, 'qm-companion');
  assert.equal(proxy.network, companion.network);
  assert.ok(!['bridge', 'host', 'none', 'default'].includes(companion.network));
  assert.ok(!companion.extras.some((arg) => /^--link(?:=|$)/u.test(arg)));
  const host = companion.configs.find((config) => config.Target === 'DOCKER_HOST');
  assert.equal(host.Default, `tcp://${proxy.name}:2375`);
});

test('Unraid network migration keeps Docker private and the default access read only', async () => {
  const companion = await template('qm-companion'); const proxy = await template('qm-socket-proxy');
  assert.equal(proxy.configs.some((config) => config.Type === 'Port'), false);
  assert.ok(!proxy.extras.some((arg) => /^(-p|--publish|--network=host|--privileged)/u.test(arg)));
  assert.ok(!companion.configs.some((config) => config.Target === '/var/run/docker.sock'));
  for (const t of [companion, proxy]) {
    assert.ok(t.extras.includes('--read-only')); assert.ok(t.extras.includes('--cap-drop=ALL'));
    assert.ok(t.extras.includes('--security-opt=no-new-privileges'));
  }
  assert.equal(proxy.configs.find((config) => config.Target === '/var/run/docker.sock').Mode, 'ro');
  for (const key of ['POST', 'EXEC']) assert.equal(proxy.configs.find((config) => config.Target === key).Default, '0');
  assert.equal(companion.configs.find((config) => config.Target === 'DOCKER_ACCESS_MAX').Default, 'read');
});

test('Unraid instructions cover new installs and existing saved templates without replacing credentials', async () => {
  const docs = await readFile(new URL('docs/unraid.md', root), 'utf8');
  assert.match(docs, /docker network create qm-companion/u);
  assert.match(docs, /Existing installations/u);
  assert.match(docs, /--link=qm-socket-proxy:socket-proxy/u);
  assert.match(docs, /tcp:\/\/qm-socket-proxy:2375/u);
  assert.match(docs, /keep.*SECRET_KEY.*QM_PROXY_KEY/iu);
  assert.match(docs, /saved.*templates/iu);
});

const dockerAvailable = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
test('Docker CLI accepts both template configurations without publishing the proxy port', { skip: !dockerAvailable, timeout: 15_000 }, async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && /\/containers\/create\?/u.test(req.url)) {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Id: 'fixture-container', Warnings: [] }));
      } else if (req.url.endsWith('/_ping')) { res.writeHead(200); res.end('OK'); }
      else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const configDir = await mkdtemp(join(tmpdir(), 'qm-unraid-cli-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const env = { ...process.env, DOCKER_CONFIG: configDir, DOCKER_API_VERSION: '1.47' };
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  for (const name of ['qm-socket-proxy', 'qm-companion']) {
    const args = ['--host', `tcp://127.0.0.1:${server.address().port}`, ...createArgs(await template(name))];
    const result = await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject); child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(requests.length, 2);
  const [proxy, companion] = requests;
  for (const body of requests) {
    assert.equal(body.HostConfig.NetworkMode, 'qm-companion');
    assert.ok(!body.HostConfig.Links?.length);
    assert.equal(body.HostConfig.Privileged, false);
  }
  assert.deepEqual(proxy.HostConfig.PortBindings ?? {}, {});
  assert.equal(companion.HostConfig.PortBindings['8787/tcp'][0].HostPort, '8787');
  assert.ok(companion.Env.includes('DOCKER_HOST=tcp://qm-socket-proxy:2375'));
});
