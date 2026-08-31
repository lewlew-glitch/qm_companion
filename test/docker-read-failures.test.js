import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';


function listeningOn(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function withDocker(handler, run) {
  const { server, port } = await listeningOn(handler);
  const previous = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${port}`;
  try {
    const docker = await import(`../src/docker.js?read-failure=${port}`);
    await run(docker);
  } finally {
    if (previous === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previous;
    server.close();
  }
}

const READS = [
  { fn: 'listImages', path: '/images/json' },
  { fn: 'listVolumes', path: '/volumes' },
  { fn: 'listNetworks', path: '/networks' },
  { fn: 'recentEvents', path: '/events' },
];

test('returns null for Docker 500 responses', async () => {
  for (const read of READS) {
    await withDocker(
      (req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"message":"boom"}'); },
      async (docker) => {
        const answer = await docker[read.fn]();
        assert.equal(answer, null, `${read.fn} answers null on a 500, not an empty list`);
      },
    );
  }
});

test('returns null after a Docker transport failure', async () => {
  for (const read of READS) {
    await withDocker(
      (req, res) => { res.socket.destroy(); },
      async (docker) => {
        const answer = await docker[read.fn]();
        assert.equal(answer, null, `${read.fn} answers null when the connection dies`);
      },
    );
  }
});

test('preserves the blocked sentinel for Docker 403 responses', async () => {
  for (const read of READS) {
    await withDocker(
      (req, res) => { res.writeHead(403); res.end('access denied'); },
      async (docker) => {
        const answer = await docker[read.fn]();
        assert.equal(answer, 'blocked', `${read.fn} keeps the proxy-refusal sentinel`);
      },
    );
  }
});

test('preserves successful empty Docker responses', async () => {
  await withDocker(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/volumes') res.end(JSON.stringify({ Volumes: [] }));
      else res.end('[]');
    },
    async (docker) => {
      assert.deepEqual(await docker.listImages(), [], 'no images is a real state');
      assert.deepEqual(await docker.listVolumes(), [], 'no volumes is a real state');
    },
  );
});

test('sets unreadable stack resource counts to null', async () => {
  await withDocker(
    (req, res) => {
      if (req.url === '/containers/json?all=1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{
          Id: 'a'.repeat(64), Names: ['/app'], Image: 'example/app:latest', State: 'running',
          Status: 'Up 2 hours', Ports: [], Labels: { 'com.docker.compose.project': 'media-stack' },
        }]));
        return;
      }
      res.writeHead(500); res.end('{}');
    },
    async (docker) => {
      const stacks = await docker.listStacks();
      const stack = stacks.find((s) => s.name === 'media-stack');
      assert.ok(stack);
      assert.equal(stack.networks, null);
      assert.equal(stack.volumes, null);
    },
  );
});

test('clears cached counts after a Docker read failure', async () => {
  await withDocker(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{
        Id: 'a'.repeat(64), Names: ['/app'], Image: 'example/app:latest', State: 'running',
        Status: 'Up 2 hours (unhealthy)', Ports: [], Labels: {},
      }]));
    },
    async (docker) => {
      const counts = await docker.dockerCounts();
      assert.equal(counts.unhealthy, 1, 'a real unhealthy container is counted');
      assert.equal(docker.cachedCounts().unhealthy, 1, 'and cached for the nav');
    },
  );
  await withDocker(
    (req, res) => { res.socket.destroy(); },
    async (docker) => {
      assert.equal(await docker.dockerCounts(), null);
      assert.equal(docker.cachedCounts(), null);
    },
  );
});
