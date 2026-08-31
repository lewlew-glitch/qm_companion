import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFixtures } from '../fixtures/mobile-protocol/generate.mjs';
import { EFF_LARGE_WORDLIST_SHA256, wordlist } from '../src/mobile/wordlist.js';


const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mobile-protocol');
const EFF_SHA256 = 'addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e';

test('matches regenerated protocol fixtures byte for byte', () => {
  const vendored = readFileSync(join(root, 'fixtures.json'), 'utf8');
  const { checks, fixtures } = buildFixtures();
  assert.ok(Object.values(checks).every((v) => v === true), JSON.stringify(checks));
  assert.equal(vendored, JSON.stringify(fixtures, null, 2));
});

test('matches the vendored wordlist hash', () => {
  const bytes = readFileSync(join(root, '..', '..', 'src', 'mobile', 'eff_large_wordlist.txt'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), EFF_SHA256);
  assert.equal(bytes.toString('utf8').trimEnd().split('\n').length, 7776);
  assert.equal(EFF_LARGE_WORDLIST_SHA256, EFF_SHA256);
  assert.equal(wordlist().length, 7776);
});
