import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { getJson } from '../src/live.js';
import { fetchTextBounded } from '../src/net.js';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('credentialed live requests refuse cross-origin redirects', async (t) => {
  let targetHits = 0;
  let leakedKey = null;
  const target = await listen((req, res) => {
    targetHits += 1;
    leakedKey = req.headers['x-api-key'] || null;
    res.end('{"ok":true}');
  });
  const source = await listen((_req, res) => {
    res.writeHead(302, { location: `${target.origin}/steal` });
    res.end();
  });
  t.after(() => source.server.close());
  t.after(() => target.server.close());

  const result = await getJson(`${source.origin}/status`, { 'X-Api-Key': 'do-not-leak' }, 1000);
  assert.equal(result, null);
  assert.equal(targetHits, 0);
  assert.equal(leakedKey, null);
});

test('chunked responses are stopped at the byte limit before full buffering', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(700));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = async (_url, init) => {
    assert.equal(init.redirect, 'error');
    return new Response(body, { status: 200 });
  };

  await assert.rejects(
    fetchTextBounded('http://service.invalid', {}, { maxBytes: 1024, fetchImpl }),
    /too large/,
  );
  assert.equal(cancelled, true);
});

test('a truncating read keeps the first bytes and stops the stream', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(700).fill(0x61));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = async () => new Response(body, { status: 200 });

  const { text, truncated } = await fetchTextBounded('http://service.invalid', {}, { maxBytes: 1024, fetchImpl, overflow: 'truncate' });
  assert.equal(text, 'a'.repeat(1024));
  assert.equal(truncated, true);
  assert.equal(cancelled, true);
});

test('a declared length over the limit is refused by default and cut short when truncating', async () => {
  const page = 'b'.repeat(4096);
  const fetchImpl = async () => new Response(page, { status: 200, headers: { 'content-length': String(page.length) } });

  await assert.rejects(fetchTextBounded('http://service.invalid', {}, { maxBytes: 1024, fetchImpl }), /too large/);
  const cut = await fetchTextBounded('http://service.invalid', {}, { maxBytes: 1024, fetchImpl, overflow: 'truncate' });
  assert.equal(cut.text, 'b'.repeat(1024));
  assert.equal(cut.truncated, true);
  const whole = await fetchTextBounded('http://service.invalid', {}, { maxBytes: 8192, fetchImpl, overflow: 'truncate' });
  assert.equal(whole.text, page);
  assert.equal(whole.truncated, false);
});

test('the deadline remains active while a response body is stalled', async () => {
  const body = new ReadableStream({ start() {} });
  const fetchImpl = async () => new Response(body, { status: 200 });
  const started = Date.now();

  await assert.rejects(
    fetchTextBounded('http://service.invalid', {}, { timeoutMs: 25, fetchImpl }),
    { name: 'AbortError' },
  );
  assert.ok(Date.now() - started < 1000);
});

test('the header deadline is handled even when fetch ignores AbortSignal', async () => {
  let signal;
  let unhandled = null;
  const onUnhandled = (error) => { unhandled = error; };
  process.on('unhandledRejection', onUnhandled);
  const started = Date.now();
  try {
    await assert.rejects(
      fetchTextBounded('http://service.invalid', {}, {
        timeoutMs: 25,
        fetchImpl: async (_url, init) => {
          signal = init.signal;
          return new Promise(() => {});
        },
      }),
      { name: 'AbortError' },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(unhandled, null);
    assert.ok(Date.now() - started < 1000);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
