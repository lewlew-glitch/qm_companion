// Open cross-platform fixtures and verify rejection cases.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CipherSuite, Aes256Gcm, HkdfSha256, DhkemX25519HkdfSha256 } from '@hpke/core';
import { parseSealedEnvelope } from '../../../src/mobile/envelope.js';

const fx = JSON.parse(readFileSync('../fixtures.json', 'utf8'));
const cross = JSON.parse(readFileSync('cross.json', 'utf8'));
const appleText = readFileSync(process.argv[2] ?? 'apple-sealed.json', 'utf8');
const envelope = parseSealedEnvelope(appleText);
if (!envelope.ok) throw new Error(`apple envelope refused: ${envelope.error}`);

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const aad = createHash('sha256').update(Buffer.from(fx.transcriptBytesHex, 'hex')).digest();
const open = async (skHex, aadBytes) => {
  const recipientKey = await suite.kem.importKey('raw', Buffer.from(skHex, 'hex'), false);
  const ctx = await suite.createRecipientContext({ recipientKey, enc: envelope.enc, info: new TextEncoder().encode('qm-grant-v1') });
  return Buffer.from(await ctx.open(envelope.ct, aadBytes));
};
const pt = await open(cross.skRm, aad);
const plaintextHashOk = createHash('sha256').update(pt).digest('hex') === cross.ptSha256;
let wrongAadRejected = false;
try { await open(cross.skRm, Buffer.alloc(32, 9)); } catch { wrongAadRejected = true; }
let wrongKeyRejected = false;
const other = generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
try { await open(Buffer.from(other).toString('hex'), aad); } catch { wrongKeyRejected = true; }
console.log(JSON.stringify({ opened: pt.length, plaintextHashOk, wrongAadRejected, wrongKeyRejected, strictEnvelopeParsed: true }));
