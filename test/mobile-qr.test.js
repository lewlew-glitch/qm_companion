import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


process.env.SECRET_KEY = 'cd'.repeat(32);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-qr-'));
process.env.QM_HOST = 'nas.local';

const { buildQrPayload, parseQrPayload, QR_PREFIX } = await import('../src/mobile/qr.js');
const { mintToken } = await import('../src/mobile/token-family.js');

const ORIGIN = 'https://nas.local:8788';
const FP = 'ab'.repeat(32);

function encode(obj) {
  return `${QR_PREFIX}${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')}`;
}

test('build then parse round-trips and the text is the canonical RFC 8785 form', () => {
  const key = mintToken('qme');
  const text = buildQrPayload(ORIGIN, key, FP);
  assert.ok(text.startsWith('QMC2:'));
  assert.doesNotMatch(text, /[=+/]/, 'unpadded base64url only');
  const decoded = Buffer.from(text.slice(5), 'base64url').toString('utf8');
  assert.equal(decoded, `{"fingerprint":"${FP}","key":"${key}","origin":"${ORIGIN}","v":2}`);
  assert.deepEqual(parseQrPayload(text), { ok: true, v: 2, origin: ORIGIN, key, fingerprint: FP });
});

test('build refuses a qmp key, a bad origin and a bad fingerprint', () => {
  assert.throws(() => buildQrPayload(ORIGIN, mintToken('qmp'), FP), /qme/);
  assert.throws(() => buildQrPayload('http://nas.local:8788', mintToken('qme'), FP), /origin/);
  assert.throws(() => buildQrPayload('https://nas.local', mintToken('qme'), FP), /origin/);
  assert.throws(() => buildQrPayload(ORIGIN, mintToken('qme'), 'AB'.repeat(32)), /fingerprint/);
});

test('parse refuses every non-canonical or foreign spelling', () => {
  const key = mintToken('qme');
  const good = buildQrPayload(ORIGIN, key, FP);
  const cases = {
    'wrong prefix': `QMC1:${good.slice(5)}`,
    'lowercase prefix': `qmc2:${good.slice(5)}`,
    'empty body': 'QMC2:',
    'padded base64': `${good}=`,
    'standard base64 alphabet': `QMC2:${Buffer.from(good.slice(5), 'base64url').toString('base64')}`,
    'not json': `QMC2:${Buffer.from('nope').toString('base64url')}`,
    'array body': `QMC2:${Buffer.from('[]').toString('base64url')}`,
    'reordered keys': encode({ v: 2, origin: ORIGIN, key, fingerprint: FP }),
    'extra key': encode({ fingerprint: FP, key, name: 'x', origin: ORIGIN, v: 2 }),
    'missing key': encode({ fingerprint: FP, origin: ORIGIN, v: 2 }),
    'wrong version': encode({ fingerprint: FP, key, origin: ORIGIN, v: 1 }),
    'version as string': encode({ fingerprint: FP, key, origin: ORIGIN, v: '2' }),
    'whitespace in json': `QMC2:${Buffer.from(`{"fingerprint":"${FP}", "key":"${key}","origin":"${ORIGIN}","v":2}`).toString('base64url')}`,
    'qmp family': encode({ fingerprint: FP, key: mintToken('qmp'), origin: ORIGIN, v: 2 }),
    'qmd family': encode({ fingerprint: FP, key: mintToken('qmd'), origin: ORIGIN, v: 2 }),
    'non-canonical token tail': encode({ fingerprint: FP, key: `qme_${'A'.repeat(42)}B`, origin: ORIGIN, v: 2 }),
    'http origin': encode({ fingerprint: FP, key, origin: 'http://nas.local:8788', v: 2 }),
    'origin without port': encode({ fingerprint: FP, key, origin: 'https://nas.local', v: 2 }),
    'origin with path': encode({ fingerprint: FP, key, origin: 'https://nas.local:8788/', v: 2 }),
    'uppercase fingerprint': encode({ fingerprint: FP.toUpperCase(), key, origin: ORIGIN, v: 2 }),
    'short fingerprint': encode({ fingerprint: FP.slice(2), key, origin: ORIGIN, v: 2 }),
  };
  for (const [name, text] of Object.entries(cases)) {
    const out = parseQrPayload(text);
    assert.equal(out.ok, false, name);
    assert.equal('key' in out, false, `${name} leaks nothing`);
  }
  assert.equal(parseQrPayload(null).ok, false);
  assert.equal(parseQrPayload(42).ok, false);
});
