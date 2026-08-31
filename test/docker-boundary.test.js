
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function fakeDocker(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = handler ? handler(req) : null;
      res.writeHead(reply?.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply?.json ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

async function withEnv(env, run) {
  const before = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const tag = `?t=${Math.random().toString(36).slice(2)}${Date.now()}`;
  try {
    return await run(tag);
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}


test('proxy requests include the shared key', async () => {
  const fake = await fakeDocker(() => ({ status: 200, json: [] }));
  try {
    await withEnv(
      { DOCKER_HOST: `tcp://127.0.0.1:${fake.port}`, QM_PROXY_KEY: 'k'.repeat(48) },
      async (tag) => {
        const docker = await import(`../src/docker.js${tag}`);
        await docker.dockerGetJson('/containers/json');
        assert.ok(fake.seen.length >= 1);
        assert.ok(fake.seen.some((r) => r.url.includes('/containers/json')), 'the asked-for read went out');
        for (const r of fake.seen) {
          assert.equal(r.headers['x-qm-proxy-key'], 'k'.repeat(48), `${r.method} ${r.url}`);
        }
      },
    );
  } finally {
    await fake.close();
  }
});

test('Docker write requests include the shared key', async () => {
  const fake = await fakeDocker((req) => (req.url.includes('/create') ? { status: 201, json: { Id: 'abc' } } : { status: 200, json: {} }));
  try {
    await withEnv(
      { DOCKER_HOST: `tcp://127.0.0.1:${fake.port}`, QM_PROXY_KEY: 'k'.repeat(48) },
      async (tag) => {
        const docker = await import(`../src/docker.js${tag}`);
        await docker.createContainer('demo', { Image: 'example/app:1.0' });
        const created = fake.seen.find((r) => r.method === 'POST');
        assert.ok(created);
        assert.equal(created.headers['x-qm-proxy-key'], 'k'.repeat(48));
        assert.equal(created.headers['content-type'], 'application/json');
      },
    );
  } finally {
    await fake.close();
  }
});

test('does not send the key to the raw socket', async () => {
  await withEnv({ DOCKER_HOST: undefined, QM_PROXY_KEY: 'k'.repeat(48) }, async (tag) => {
    const docker = await import(`../src/docker.js${tag}`);
    assert.equal(docker.dockerProxyKeyMissing(), false);
  });
});

test('reports a proxy with no configured key', async () => {
  await withEnv({ DOCKER_HOST: 'tcp://socket-proxy:2375', QM_PROXY_KEY: undefined }, async (tag) => {
    const docker = await import(`../src/docker.js${tag}`);
    assert.equal(docker.dockerProxyKeyMissing(), true);
  });
});

test('the proxy image gates on the key above every allow rule', () => {
  const dockerfile = readFileSync(join(projectRoot, 'Dockerfile.socket-proxy'), 'utf8');
  assert.match(dockerfile, /set-var\(txn\.qmkey\) env\(QM_PROXY_KEY\)/);
  assert.match(dockerfile, /req\.hdr\(x-qm-proxy-key\),strcmp\(txn\.qmkey\) eq 0/);
  assert.match(dockerfile, /deny unless \{ var\(txn\.qmkey\) -m found \}/);
  assert.match(dockerfile, /deny unless \{ var\(txn\.qmkey\),length gt 31 \}/);
  assert.match(dockerfile, /test "\$\(grep -n 'set-var\(txn\.qmkey\)'/);
  assert.match(dockerfile, /-lt "\$\(grep -n 'http-request allow'/);
  assert.match(dockerfile, /deny if \{ method HEAD \}/);
  assert.match(dockerfile, /archive/);
});

test('the shipped compose demands the key on both sides and ships no literal', () => {
  const example = readFileSync(join(projectRoot, 'docker-compose.example.yml'), 'utf8');
  const required = [...example.matchAll(/QM_PROXY_KEY: "\$\{QM_PROXY_KEY:\?/g)];
  assert.equal(required.length, 2, 'the proxy demands it and Companion supplies it');
  assert.doesNotMatch(example, /QM_PROXY_KEY: "[0-9a-fA-F]{16,}"/, 'no literal key in the file');
  assert.match(example, /internal.*network still gets a gateway address on the Docker host/s);
});


const COMPOSE = `services:
  app:
    image: example/app:1.0
    container_name: demo-app
    ports:
      - "8080:80"
    volumes:
      - app-config:/config
volumes:
  app-config:
`;

async function deployAgainstFake(env, text = COMPOSE) {
  const fake = await fakeDocker((req) => {
    if (req.url.includes('/networks/create')) return { status: 201, json: { Id: 'net' } };
    if (req.url.includes('/networks')) return { status: 200, json: [] };
    if (req.url.includes('/images/create')) return { status: 200, json: {} };
    if (req.url.includes('/containers/create')) return { status: 201, json: { Id: 'cid' } };
    return { status: 200, json: {} };
  });
  try {
    const source = `
      const compose = await import('./src/compose.js');
      const result = await compose.deployStack('demo', process.env.QM_TEST_COMPOSE, {}, false);
      console.log(JSON.stringify(result));
      // Docker's keep-alive sockets hold the loop open, and spawnSync waits for exit.
      process.exit(0);
    `;
    const child = await new Promise((resolve) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', source], {
        cwd: projectRoot,
        env: {
          ...process.env,
          SECRET_KEY: '5c'.repeat(32),
          QM_HOST: 'nas.local',
          DOCKER_HOST: `tcp://127.0.0.1:${fake.port}`,
          QM_TEST_COMPOSE: text,
          ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)),
        },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (c) => { stdout += c; });
      proc.stderr.on('data', (c) => { stderr += c; });
      proc.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split('\n').pop());
    const create = fake.seen.find((r) => r.method === 'POST' && r.url.includes('/containers/create'));
    return { result, create, seen: fake.seen };
  } finally {
    await fake.close();
  }
}

test('a deployed port binds one address, not every interface', async () => {
  const { result, create } = await deployAgainstFake({ QM_HOST: '192.168.1.10', DOCKER_DEPLOY_BIND_ADDRESS: undefined });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.ok(create, 'a container was created');
  assert.deepEqual(create.body.HostConfig.PortBindings, {
    '80/tcp': [{ HostIp: '192.168.1.10', HostPort: '8080' }],
  });
});

test('missing bind address defaults to loopback', async () => {
  const { create } = await deployAgainstFake({ QM_HOST: 'nas.local', DOCKER_DEPLOY_BIND_ADDRESS: undefined });
  assert.deepEqual(create.body.HostConfig.PortBindings, {
    '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
  });
});

test('deploy address and mapping overrides take precedence', async () => {
  const { create } = await deployAgainstFake({ QM_HOST: '192.168.1.10', DOCKER_DEPLOY_BIND_ADDRESS: '10.0.0.5' });
  assert.deepEqual(create.body.HostConfig.PortBindings, {
    '80/tcp': [{ HostIp: '10.0.0.5', HostPort: '8080' }],
  });

  const pinned = await deployAgainstFake(
    { QM_HOST: '192.168.1.10', DOCKER_DEPLOY_BIND_ADDRESS: '10.0.0.5' },
    COMPOSE.replace('"8080:80"', '"127.0.0.1:8080:80"'),
  );
  assert.deepEqual(pinned.create.body.HostConfig.PortBindings, {
    '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
  });
});

test('wildcard binding requires opt-in configuration', async () => {
  const { create } = await deployAgainstFake(
    { QM_HOST: '192.168.1.10' },
    COMPOSE.replace('"8080:80"', '"0.0.0.0:8080:80"'),
  );
  assert.deepEqual(create.body.HostConfig.PortBindings, {
    '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
  });
});

test('refuses an undeclared host bind before pull or create', async () => {
  const withBind = COMPOSE.replace('      - app-config:/config', '      - /etc/passwd:/etc/passwd:ro');
  const { result, seen } = await deployAgainstFake({ QM_HOST: '192.168.1.10', DOCKER_DEPLOY_BIND_ROOTS: '/volume1/docker' }, withBind);
  assert.equal(result.ok, false);
  const unsafe = result.steps.find((s) => s.step === 'unsafe');
  assert.ok(unsafe, JSON.stringify(result.steps));
  assert.match(unsafe.note, /not under any root this server allows/);
  assert.equal(seen.filter((r) => r.method === 'POST').length, 0, 'no create, no pull, no network');
});

test('a declared root deploys, and its bind reaches the daemon unchanged', async () => {
  const withBind = COMPOSE.replace('      - app-config:/config', '      - /volume1/docker/app/config:/config');
  const { result, create } = await deployAgainstFake(
    { QM_HOST: '192.168.1.10', DOCKER_DEPLOY_BIND_ROOTS: '/volume1/docker' },
    withBind.replace('volumes:\n  app-config:\n', ''),
  );
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(create.body.HostConfig.Binds, ['/volume1/docker/app/config:/config']);
});

test('a walk out of a declared root is resolved before it is judged', async () => {
  const withBind = COMPOSE.replace('      - app-config:/config', '      - /volume1/docker/../../etc/shadow:/x:ro');
  const { result, seen } = await deployAgainstFake(
    { QM_HOST: '192.168.1.10', DOCKER_DEPLOY_BIND_ROOTS: '/volume1/docker' },
    withBind.replace('volumes:\n  app-config:\n', ''),
  );
  assert.equal(result.ok, false);
  assert.equal(seen.filter((r) => r.method === 'POST').length, 0);
});

test('invalid bind address reports the loopback fallback', async () => {
  for (const bad of ['nas.local', '*', '999.999.999.999', '010.0.0.1', '1.2.3', '1.2.3.4.5', '0.0.0.0.0']) {
    const { create } = await deployAgainstFake({ QM_HOST: '192.168.1.10', DOCKER_DEPLOY_BIND_ADDRESS: bad });
    assert.deepEqual(
      create.body.HostConfig.PortBindings,
      { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] },
      `${bad} must not reach the daemon`,
    );
  }
});

test('treats a blank setting as unset and uses the configured host', async () => {
  const { create } = await deployAgainstFake({ QM_HOST: '192.168.1.10', DOCKER_DEPLOY_BIND_ADDRESS: '   ' });
  assert.deepEqual(create.body.HostConfig.PortBindings, {
    '80/tcp': [{ HostIp: '192.168.1.10', HostPort: '8080' }],
  });
});

test('an out-of-range QM_HOST is not mistaken for an address either', async () => {
  const { create } = await deployAgainstFake({ QM_HOST: '999.1.1.1', DOCKER_DEPLOY_BIND_ADDRESS: undefined });
  assert.deepEqual(create.body.HostConfig.PortBindings, {
    '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
  });
});

test('a UDP mapping is bound to one address as well', async () => {
  const { create } = await deployAgainstFake(
    { QM_HOST: '192.168.1.10' },
    COMPOSE.replace('"8080:80"', '"8080:80/udp"'),
  );
  assert.deepEqual(create.body.HostConfig.PortBindings, {
    '80/udp': [{ HostIp: '192.168.1.10', HostPort: '8080' }],
  });
});

test('the port parser refuses an address it could not honour', async () => {
  const { parseCompose } = await import('../src/compose.js');
  for (const port of ['010.0.0.1:8080:80', '999.999.999.999:8080:80', '1.2.3:8080:80']) {
    const parsed = parseCompose(`services:
  app:
    image: example/app:1.0
    ports:
      - "${port}"
`);
    assert.equal(parsed.ok, false, port);
  }
});

test('documented recreate commands rebuild the proxy image', () => {
  for (const file of ['README.md', 'docs/mobile-connection.md', 'docs/tls-and-certificates.md']) {
    const guide = readFileSync(join(projectRoot, file), 'utf8');
    for (const line of guide.split('\n')) {
      if (line.includes('docker compose') && line.includes(' up -d')) {
        assert.ok(line.includes('--build'), `${file} documents a recreate without --build: ${line}`);
      }
    }
  }
});

test('closes the container filesystem export route', () => {
  const dockerfile = readFileSync(join(projectRoot, 'Dockerfile.socket-proxy'), 'utf8');
  assert.match(dockerfile, /\(archive\|export\)/);
});

test('diagnoses an unusable proxy key', async () => {
  for (const [key, expected] of [
    [undefined, 'missing'],
    ['short', 'short'],
    ['k'.repeat(48) + '\n', 'malformed'],
    ['k'.repeat(48), null],
  ]) {
    await withEnv({ DOCKER_HOST: 'tcp://socket-proxy:2375', QM_PROXY_KEY: key }, async (tag) => {
      const docker = await import(`../src/docker.js${tag}`);
      assert.equal(docker.dockerProxyKeyProblem(), expected, String(key).slice(0, 12));
    });
  }
});
