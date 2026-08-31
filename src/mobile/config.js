// Strict environment validation for the mobile HTTPS listener.

import { join } from 'node:path';

import { isIP } from 'node:net';

import { config } from '../config.js';
import { mobileFeatures } from './features.js';
import { parseAdvertisedOrigin } from './origin.js';

export { parseAdvertisedOrigin };

export const DEFAULT_MOBILE_PORT = 8788;
export const DEFAULT_MOBILE_BIND = '0.0.0.0';

/** Accept an IP literal or wildcard listener address. */
function parseBind(value) {
  if (value == null || value === '') return DEFAULT_MOBILE_BIND;
  const bind = String(value).trim();
  if (bind === '0.0.0.0' || bind === '::') return bind;
  const bare = bind.startsWith('[') && bind.endsWith(']') ? bind.slice(1, -1) : bind;
  if (!isIP(bare)) throw new Error('MOBILE_BIND_ADDRESS must be an IP address, 0.0.0.0 or ::');
  return bare;
}
function parsePort(value) {
  if (value == null || value === '') return DEFAULT_MOBILE_PORT;
  if (!/^\d{1,5}$/.test(value)) throw new Error('MOBILE_PORT must be an integer');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('MOBILE_PORT is out of range');
  return port;
}

/** Build a validated mobile listener plan. */
export function mobileListenerPlan(env = process.env) {
  const features = mobileFeatures();
  if (!features.api) return { ok: false, reason: 'MOBILE_API_ENABLED is not true; the mobile plane is off.' };
  const origin = parseAdvertisedOrigin(env.QM_ADVERTISED_ORIGIN);
  if (!origin.ok) return { ok: false, reason: origin.error };
  let port;
  let bind;
  try {
    port = parsePort(env.MOBILE_PORT);
    bind = parseBind(env.MOBILE_BIND_ADDRESS);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (port !== origin.port) {
    return { ok: false, reason: `QM_ADVERTISED_ORIGIN port ${origin.port} does not match the listener port ${port}; the advertised origin must be the address phones reach.` };
  }
  const tlsDir = join(config.dataDir, 'tls');
  const certPath = join(tlsDir, 'mobile.crt');
  const keyPath = join(tlsDir, 'mobile.key');
  return {
    ok: true,
    origin: origin.origin,
    host: origin.host,
    port,
    bind,
    certPath,
    keyPath,
    enrolment: features.enrolment,
  };
}
