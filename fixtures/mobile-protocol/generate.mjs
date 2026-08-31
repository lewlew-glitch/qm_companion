// Generate deterministic protocol fixtures.
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildGrant, buildTranscript, deriveSas, grantBytes as grantBytesOf, identitySignedBytes,
  sealedPlaintext as sealedPlaintextOf, signGrant, signIdentity, signTranscript, transcriptBytes as transcriptBytesOf,
  transcriptHash as transcriptHashOf, verifyGrant, verifyTranscript,
} from '../../src/mobile/protocol.js';
import { canonicalMobilePayload } from '../../src/mobile/schema.js';

const here = dirname(fileURLToPath(import.meta.url));


/** Build the normative fixtures deterministically. Pure apart from reading the vendored wordlist. */
export function buildFixtures() {
  // Fixed Ed25519 test key: PKCS8 = fixed DER prefix + 32-byte seed, so the fixtures are stable.
  const SEED = Buffer.alloc(32, 0x42);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pubRaw = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12);
  const fingerprint = createHash('sha256').update(pubRaw).digest('hex');

  const pubB64 = Buffer.from(pubRaw).toString('base64url');
  const transcript = buildTranscript(
    {
      origin: 'https://nas.local:8788',
      mobileInstallationId: '11111111-2222-4333-8444-555555555555',
      legacyInstallationId: '99999999-8888-4777-a666-555555555555',
      serverSigningPublicKey: pubB64,
      serverSigningFingerprint: fingerprint,
      tlsLeafFingerprint: 'aa'.repeat(32),
    },
    {
      enrolmentId: 'AAAAAAAAAAAAAAAAAAAAAA',
      claimEncryptionPublicKey: Buffer.alloc(32, 7).toString('base64url'),
      clientNonce: Buffer.alloc(16, 3).toString('base64url'),
      requestedScopes: ['containers.read', 'events.read', 'stacks.read', 'summary.read', 'updates.read'],
      deviceName: 'Fixture iPhone',
      expiresAt: 1787300000000,
    },
  );
  const transcriptBytes = transcriptBytesOf(transcript);
  const transcriptHash = transcriptHashOf(transcriptBytes);
  const transcriptSig = signTranscript(priv, transcriptBytes);
  const { digits, words: sasWords } = deriveSas(transcriptHash);

  const grant = buildGrant({
    mobileInstallationId: transcript.mobileInstallationId,
    legacyInstallationId: transcript.legacyInstallationId,
    deviceId: Buffer.alloc(16, 9).toString('base64url'),
    accessToken: `qmd_${Buffer.alloc(32, 1).toString('base64url')}`,
    accessTokenExpiresAt: 1787300900000,
    refreshGrant: `qmr_${Buffer.alloc(32, 2).toString('base64url')}`,
    refreshAbsoluteDeadlineAt: 1795076000000,
    refreshIdleDeadlineAt: 1789892000000,
    tokenFamilyGeneration: 1,
    scopes: transcript.requestedScopes,
    ackSecret: Buffer.alloc(32, 5).toString('base64url'),
    transcriptHash: transcriptHash.toString('hex'),
  });
  const grantBytes = grantBytesOf(grant);
  const grantSig = signGrant(priv, grantBytes);
  const sealedPlaintext = sealedPlaintextOf(grant, grantSig).toString('utf8');

  // Identity-challenge signed bytes sample: the NUL-delimited byte string with apiMajor inside.
  const identityBytes = identitySignedBytes({
    mobileInstallationId: transcript.mobileInstallationId,
    publicKeyRaw: Buffer.from(pubRaw),
    challenge: Buffer.alloc(32, 6),
    issuedAt: 1787300000000,
  });
  const identitySig = signIdentity(priv, identityBytes);

  // Self-verification before writing anything.
  const checks = {
    transcriptSigOk: verifyTranscript(pubB64, transcriptBytes, transcriptSig),
    grantSigOk: verifyGrant(pubB64, grantBytes, grantSig),
    identitySigOk: verify(null, identityBytes, createPublicKey(priv), identitySig),
    wrongKeyRejected: !verify(null, identityBytes, createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x24)]), format: 'der', type: 'pkcs8' })), identitySig),
    canonicalStable: canonicalMobilePayload(JSON.parse(transcriptBytes.toString('utf8'))) === transcriptBytes.toString('utf8'),
    reorderedInputSameBytes: canonicalMobilePayload(Object.fromEntries(Object.entries(transcript).reverse())) === transcriptBytes.toString('utf8'),
  };
  if (Object.values(checks).some((v) => v !== true)) throw new Error(`self-check failed: ${JSON.stringify(checks)}`);
  // JCS vectors cover escaping, sorting, and Unicode handling.
  const jcsInputs = [
    { b: 'quote " backslash \\ newline \n tab \t ctrl \u0001', a: [1, true, null, false] },
    { z: { y: { x: 1, a: 2 }, b: [] }, A: 'upper sorts before lower', '0': 0, ' ': 'space key' },
    { name: 'Fixture iPhone \u00fc\u2028\u{1F512}', id: 9007199254740991 },
  ];
  const jcsVectors = jcsInputs.map((input) => ({
    inputJson: JSON.stringify(input),
    canonicalHex: Buffer.from(canonicalMobilePayload(input), 'utf8').toString('hex'),
  }));

  return {
    checks,
    fixtures: {
      ed25519Seed: SEED.toString('hex'),
      jcsVectors,
      publicKey: Buffer.from(pubRaw).toString('base64url'),
      fingerprint,
      transcriptBytesHex: transcriptBytes.toString('hex'),
      transcriptHashHex: transcriptHash.toString('hex'),
      transcriptSignature: Buffer.from(transcriptSig).toString('base64url'),
      sasDigits: digits,
      sasWords,
      grantBytesHex: grantBytes.toString('hex'),
      grantSignature: Buffer.from(grantSig).toString('base64url'),
      sealedPlaintextHex: Buffer.from(sealedPlaintext, 'utf8').toString('hex'),
      identityBytesHex: identityBytes.toString('hex'),
      identitySignature: Buffer.from(identitySig).toString('base64url'),
    },
  };
}

// Run directly: write fixtures.json beside this file and print the self-checks.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { checks, fixtures } = buildFixtures();
  writeFileSync(join(here, 'fixtures.json'), `${JSON.stringify(fixtures, null, 2)}`);
  console.log(JSON.stringify({ ...checks, sasWords: fixtures.sasWords, ok: true }));
}
