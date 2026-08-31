// Verify @hpke/core against the selected RFC 9180 vector.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { CipherSuite, Aes256Gcm, HkdfSha256, DhkemX25519HkdfSha256 } from '@hpke/core';

export const VECTORS_COMMIT = '5f503c564da00b0687b3de75f1dfbdfc4079ad31';
export const VECTORS_URL = `https://raw.githubusercontent.com/cfrg/draft-irtf-cfrg-hpke/${VECTORS_COMMIT}/test-vectors.json`;
export const VECTORS_SHA256 = '61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6';

const raw = readFileSync('vectors-full.json');
const digest = createHash('sha256').update(raw).digest('hex');
if (digest !== VECTORS_SHA256) throw new Error(`vectors-full.json hash ${digest} does not match the pinned ${VECTORS_SHA256}`);

const vectors = JSON.parse(raw.toString('utf8'));
const match = vectors.filter(
  (v) => v.mode === 0 && v.kem_id === 0x0020 && v.kdf_id === 0x0001 && v.aead_id === 0x0002,
);
if (match.length === 0) throw new Error('no official vector for the selected suite');

const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
let opened = 0;
for (const v of match) {
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const recipientKey = await suite.kem.importKey('raw', hex(v.skRm), false);
  const ctx = await suite.createRecipientContext({ recipientKey, enc: hex(v.enc), info: hex(v.info) });
  for (const enc of v.encryptions) {
    const pt = await ctx.open(hex(enc.ct), hex(enc.aad));
    if (Buffer.from(pt).toString('hex') !== enc.pt) throw new Error('plaintext mismatch');
    opened += 1;
  }
}
console.log(JSON.stringify({ suiteVectors: match.length, encryptionsOpened: opened, hashEnforced: true, ok: true }));

const v = match[0];
writeFileSync('vector-for-swift.json', JSON.stringify({
  skRm: v.skRm, enc: v.enc, info: v.info,
  encryptions: v.encryptions.slice(0, 3).map((e) => ({ ct: e.ct, aad: e.aad, pt: e.pt })),
}));
