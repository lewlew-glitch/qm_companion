// Generate the cross-platform X25519 fixture.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { CipherSuite, Aes256Gcm, HkdfSha256, DhkemX25519HkdfSha256 } from '@hpke/core';

const fx = JSON.parse(readFileSync('../fixtures.json', 'utf8'));
const { publicKey, privateKey } = generateKeyPairSync('x25519');
const skRm = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const pkRm = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const recipientPublicKey = await suite.kem.importKey('raw', pkRm, true);
const sender = await suite.createSenderContext({ recipientPublicKey, info: new TextEncoder().encode('qm-grant-v1') });
const pt = Buffer.from(fx.sealedPlaintextHex, 'hex');
const aad = createHash('sha256').update(Buffer.from(fx.transcriptBytesHex, 'hex')).digest(); // derived, never read
const ct = Buffer.from(await sender.seal(pt, aad));
writeFileSync('cross.json', JSON.stringify({
  skRm: Buffer.from(skRm).toString('hex'),
  pkRm: Buffer.from(pkRm).toString('hex'),
  enc: Buffer.from(sender.enc).toString('hex'),
  ct: ct.toString('hex'),
  ptSha256: createHash('sha256').update(pt).digest('hex'),
}));
console.log(JSON.stringify({ sealed: ct.length, aadDerivedFromTranscript: true, ok: true }));
