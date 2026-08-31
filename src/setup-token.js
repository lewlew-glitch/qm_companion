// Shared first-run bootstrap token for the plaintext and HTTPS browser planes.

import { writeSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { hasOwner } from './store.js';

// Write configuration faults synchronously without a stack trace.
function die(lines) {
  writeSync(2, `\n${lines.map((line) => (line ? `  ${line}` : '')).join('\n')}\n\n`);
  process.exit(1);
}

const configured = process.env.SETUP_TOKEN;
const WHERE = 'SETUP_TOKEN is read from the environment: block of your docker-compose file, or';
if (configured === '') {
  die([
    'QM Companion did not start: SETUP_TOKEN is empty.',
    '',
    'Delete the SETUP_TOKEN line entirely and restart.',
    'An empty value is not a short token, it is no token. Companion will generate a one-time token.',
    '',
    `${WHERE} the .env file beside it.`,
    '',
    'code SETUP_TOKEN_EMPTY, label boot-setup-token-empty',
  ]);
}
if (configured !== undefined && !/^[A-Za-z0-9_-]{32,256}$/u.test(configured)) {
  const faults = [];
  if (configured.length < 32) faults.push(`is ${configured.length} characters long, under the 32 minimum`);
  if (configured.length > 256) faults.push(`is ${configured.length} characters long, over the 256 maximum`);
  if (/[^A-Za-z0-9_-]/u.test(configured)) faults.push('contains characters outside A-Z, a-z, 0-9, - and _');
  die([
    'QM Companion did not start: SETUP_TOKEN is invalid.',
    '',
    'The value supplied was rejected because it:',
    ...faults.map((fault) => `  - ${fault}`),
    '',
    'Use 32 to 256 characters from A-Z, a-z, 0-9, - and _. Generate one with:',
    '',
    '    openssl rand -hex 32',
    '',
    'Alternatively, remove SETUP_TOKEN and restart to generate a one-time token.',
    '',
    `${WHERE} the .env file beside it.`,
    '',
    'code SETUP_TOKEN_INVALID, label boot-setup-token-invalid',
  ]);
}

let token = hasOwner() ? null : configured || randomBytes(32).toString('base64url');

/** Report whether boot generated the token. */
export const setupTokenWasGenerated = !configured;

// Remove the token from process.env after reading it.
delete process.env.SETUP_TOKEN;

/** The token to print at boot while the installation is still ownerless; null once it is spent. */
export function bootstrapSetupToken() {
  return token;
}

/** Constant-time compare. False once the token has been spent or the owner already exists. */
export function setupTokenMatches(candidate) {
  if (!token) return false;
  const supplied = createHash('sha256').update(String(candidate ?? '')).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(supplied, expected);
}

/** Consume the token after any completed or duplicate setup. */
export function clearSetupToken() {
  token = null;
}
