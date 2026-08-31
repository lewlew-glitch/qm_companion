import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { blockedRegistryAddress, registryRequest } from '../src/registry.js';

function fakeHttps({ status = 200, headers = {}, chunks = [], neverEnd = false } = {}, seen = []) {
  return (options, callback) => {
    seen.push(options);
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = headers;
      callback(response);
      queueMicrotask(() => {
        if (response.destroyed) return;
        for (const chunk of chunks) response.write(chunk);
        if (!neverEnd) response.end();
      });
    };
    return request;
  };
}

test('address policy blocks non-public ranges', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.20',
    '[::1]', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe',
  ]) assert.equal(blockedRegistryAddress(address), true, address);
  assert.equal(blockedRegistryAddress('1.1.1.1'), false);
  assert.equal(blockedRegistryAddress('2606:4700:4700::1111'), false);
});

test('registry requests pin DNS while preserving request identity', async () => {
  const seen = [];
  const result = await registryRequest('GET', 'https://registry.example:5443/token?service=one', {
    accept: 'application/json',
    Host: 'attacker.invalid',
  }, {
    lookup: async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
    request: fakeHttps({ chunks: ['{"token":"ok"}'] }, seen),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, '{"token":"ok"}');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].hostname, '1.1.1.1');
  assert.equal(seen[0].family, 4);
  assert.equal(seen[0].servername, 'registry.example');
  assert.equal(seen[0].headers.host, 'registry.example:5443');
  assert.equal(seen[0].headers.Host, undefined);
  assert.equal(seen[0].path, '/token?service=one');
  assert.equal(seen[0].agent, false);
});

test('mixed public/private DNS answers fail closed before a socket is opened', async () => {
  let requests = 0;
  const result = await registryRequest('HEAD', 'https://registry.example/v2/x/manifests/latest', {}, {
    lookup: async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
    request: () => { requests += 1; throw new Error('must not connect'); },
  });
  assert.equal(result, null);
  assert.equal(requests, 0);
});

test('bracketed IPv6 loopback is refused without consulting DNS', async () => {
  let lookups = 0;
  let requests = 0;
  const result = await registryRequest('GET', 'https://[::1]/token', {}, {
    lookup: async () => { lookups += 1; return []; },
    request: () => { requests += 1; throw new Error('must not connect'); },
  });
  assert.equal(result, null);
  assert.equal(lookups, 0);
  assert.equal(requests, 0);
});

test('registry responses are bounded and redirects are denied', async () => {
  const lookup = async () => [{ address: '1.1.1.1', family: 4 }];
  const tooLarge = await registryRequest('GET', 'https://registry.example/token', {}, {
    lookup,
    maxBodyBytes: 8,
    request: fakeHttps({ chunks: ['12345', '67890'] }),
  });
  assert.equal(tooLarge, null);

  const calls = [];
  const redirected = await registryRequest('GET', 'https://registry.example/token', {}, {
    lookup,
    request: fakeHttps({ status: 302, headers: { location: 'https://elsewhere.example/' } }, calls),
  });
  assert.equal(redirected, null);
  assert.equal(calls.length, 1);
});

test('one deadline covers DNS, headers and the complete response body', async () => {
  const started = Date.now();
  const dnsTimeout = await registryRequest('GET', 'https://registry.example/token', {}, {
    timeoutMs: 50,
    lookup: () => new Promise(() => {}),
    request: () => { throw new Error('must not connect'); },
  });
  assert.equal(dnsTimeout, null);
  assert.ok(Date.now() - started < 500);

  const bodyTimeout = await registryRequest('GET', 'https://registry.example/token', {}, {
    timeoutMs: 50,
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
    request: fakeHttps({ chunks: ['partial'], neverEnd: true }),
  });
  assert.equal(bodyTimeout, null);
});
