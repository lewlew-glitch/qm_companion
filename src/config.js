// Environment and startup configuration.

import { randomBytes, hkdfSync } from 'node:crypto';
import { resolve } from 'node:path';

import { canonicalHost, integerSetting, numberSetting } from './config-values.js';

function die(msg) {
  process.stderr.write(`\n  ${msg}\n\n`);
  process.exit(1);
}

const raw = process.env.SECRET_KEY;
if (!raw) {
  const suggested = randomBytes(32).toString('hex');
  die(
    'SECRET_KEY is required and must be 64 hex characters. It encrypts stored credentials.\n' +
      '  Keep it with your backups; losing it means re-entering every credential. Generate one:\n\n' +
      `    SECRET_KEY=${suggested}`,
  );
}
if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
  die('SECRET_KEY must be exactly 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
}

const master = Buffer.from(raw, 'hex');
// Derive separate keys for encryption, request signing, and state authentication.
const dataKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'qm-companion:data', 32));
const signKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'qm-companion:sign', 32));
const stateKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'qm-companion:state', 32));

const trustProxy = process.env.TRUST_PROXY === 'true';

let port;
let sessionTtlHours;
let qmHost;
let qmRemoteHost;
try {
  port = integerSetting(process.env.PORT, { name: 'PORT', fallback: 8787, min: 1, max: 65535 });
  sessionTtlHours = numberSetting(process.env.SESSION_TTL_HOURS, {
    name: 'SESSION_TTL_HOURS', fallback: 24, min: 1 / 60, max: 24 * 365,
  });
  qmHost = canonicalHost(process.env.QM_HOST, { name: 'QM_HOST' });
  qmRemoteHost = canonicalHost(process.env.QM_REMOTE_HOST, { name: 'QM_REMOTE_HOST', required: false });
} catch (error) {
  die(error.message);
}

export const config = {
  bind: process.env.BIND_ADDRESS || '127.0.0.1', // Loopback by default.
  port,
  dataDir: resolve(process.env.DATA_DIR || './data'),
  trustProxy,
  // Secure cookies are enabled automatically behind HTTPS unless overridden.
  cookieSecure:
    process.env.COOKIE_SECURE != null ? process.env.COOKIE_SECURE === 'true' : trustProxy,
  sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
  // Docker writes require an explicit opt-in.
  dockerControl: process.env.DOCKER_CONTROL === 'true',
  // Displayed in the dashboard header.
  dockerHost: process.env.DOCKER_HOST || '/var/run/docker.sock',
  // Unauthenticated legacy v1 state is accepted only during an explicit one-boot migration.
  migrateV1State: process.env.MIGRATE_V1_STATE === 'true',
  // Phone-facing addresses for detected services.
  qmHost,
  qmRemoteHost,
  qmTitle: process.env.QM_TITLE || 'Home',
  stackDir: process.env.QM_STACK || '/stack',
  dataKey,
  signKey,
  stateKey,
};
