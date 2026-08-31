// Purpose-separated mobile keys derived from the validated SECRET_KEY master.

import { hkdfSync } from 'node:crypto';

import { config } from '../config.js';

const master = Buffer.from(process.env.SECRET_KEY, 'hex');

export const mobileStateKey = Buffer.from(
  hkdfSync('sha256', master, Buffer.alloc(0), 'qm-companion:mobile-state', 32),
);
export const mobileSealKey = Buffer.from(
  hkdfSync('sha256', master, Buffer.alloc(0), 'qm-companion:mobile-seal', 32),
);
// The anti-rollback record uses a distinct authentication label from the sidecar it guards.
export const mobileEpochKey = Buffer.from(
  hkdfSync('sha256', master, Buffer.alloc(0), 'qm-companion:mobile-epoch', 32),
);

// Export purpose keys for HKDF separation checks.
export function allPurposeKeys() {
  return {
    data: config.dataKey,
    sign: config.signKey,
    state: config.stateKey,
    mobileState: mobileStateKey,
    mobileSeal: mobileSealKey,
    mobileEpoch: mobileEpochKey,
  };
}
