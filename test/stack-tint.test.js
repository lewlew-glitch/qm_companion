import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = '192.168.1.20';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-stacktint-'));

const { stackClass, STACK_TINTS } = await import('../src/ui/bits.js');

test('stackClass maps stable names to stable tints', () => {
  assert.equal(stackClass('media-stack'), stackClass('media-stack'));
  assert.equal(stackClass('qm_companion'), stackClass('qm_companion'));
  const first = stackClass('downloads');
  for (let i = 0; i < 100; i += 1) assert.equal(stackClass('downloads'), first);
});

test('every tint is one of the six ramp classes, and an empty name gets none', () => {
  const re = new RegExp(`^sh-[0-${STACK_TINTS - 1}]$`);
  for (const name of ['media-stack', 'qm_companion', 'streamystats', 'infra', 'dns', 'downloads', 'a', 'x'.repeat(64)]) {
    assert.match(stackClass(name), re, `${name} -> a ramp class`);
  }
  assert.equal(stackClass(''), '');
  assert.equal(stackClass(null), '');
  assert.equal(stackClass(undefined), '');
});

test('distinct names span multiple tint classes', () => {
  const names = ['media-stack', 'qm_companion', 'streamystats', 'infra', 'dns', 'downloads', 'monitoring', 'books'];
  const used = new Set(names.map(stackClass));
  assert.ok(used.size >= 4, `expected several tints, got ${used.size}`);
});
