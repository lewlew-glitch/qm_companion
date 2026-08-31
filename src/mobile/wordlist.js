// Vendored EFF SAS wordlist, loaded once and verified by SHA-256.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EFF_LARGE_WORDLIST_SHA256 =
  'addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e';
export const WORDLIST_SIZE = 7776;

let cached = null;

export function wordlist() {
  if (cached) return cached;
  const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'eff_large_wordlist.txt'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== EFF_LARGE_WORDLIST_SHA256) {
    throw new Error('The vendored EFF wordlist does not match its recorded hash; SAS rendering is disabled.');
  }
  const words = bytes.toString('utf8').trimEnd().split('\n').map((line) => line.split('\t')[1]);
  if (words.length !== WORDLIST_SIZE || words.some((w) => !w)) {
    throw new Error('The vendored EFF wordlist is malformed; SAS rendering is disabled.');
  }
  cached = Object.freeze(words);
  return cached;
}
