#!/usr/bin/env node
// Rotate managed TLS material and approve advertised-origin changes.
// Usage: docker exec qm-companion node src/mobile/rotate-cert.js --confirm

import { config } from '../config.js';
import { parseAdvertisedOrigin } from './origin.js';
import { RESTART_COMMAND, approveAdvertisedOrigin, readMobileCertificateFacts, rotateMobileCertificate } from './cert.js';
import { revokeAllDevices } from './devices.js';
import { raiseMobileEpoch } from './store.js';

const out = (line) => process.stdout.write(`${line}\n`);

const confirmed = process.argv.includes('--confirm');
const origin = parseAdvertisedOrigin(process.env.QM_ADVERTISED_ORIGIN);
if (!origin.ok) {
  out(`Cannot rotate: ${origin.error}`);
  process.exit(1);
}
// Mutating operations revalidate this snapshot under their locks.
const facts = readMobileCertificateFacts(config.dataDir);
// Preserve the previous origin across certificate rotation.
const previousOrigin = facts.bindingState === 'bound' ? facts.boundOrigin : null;
const originChanged = previousOrigin !== null && previousOrigin !== origin.origin;
// Settle pending TLS transactions before classifying certificate ownership.
const settled = facts.pending === 'none';
const originOnly = facts.present && facts.source === 'owner' && originChanged && settled;

// Classify the requested origin and certificate changes.
if (!confirmed) {
  if (originOnly) {
    out(`This binds the advertised origin ${origin.origin} in place of ${facts.boundOrigin} and revokes every paired device; each phone must pair again afterwards.`);
    out('The certificate is owner-supplied, so it is left exactly as found: Companion never regenerates owner material.');
  } else {
    out('This replaces the mobile listener certificate and revokes every paired device; each phone must pair again afterwards.');
  }
  out('Re-run with --confirm to proceed.');
  process.exit(2);
}

let incomplete = false;
if (originOnly) {
  out(`The advertised origin changed from ${facts.boundOrigin} to ${origin.origin}.`);
  out('The certificate is owner-supplied, so it is left exactly as found: Companion never regenerates owner material.');
} else {
  const result = rotateMobileCertificate({ dataDir: config.dataDir, host: origin.host });
  if (!result.ok) {
    out(`Cannot rotate: ${result.reason}`);
    process.exit(1);
  }
  out(`Rotated the mobile certificate for ${origin.host}.`);
  if (result.previousFingerprint) out(`Previous fingerprint: ${result.previousFingerprint}`);
  out(`New fingerprint:      ${result.fingerprint}`);
}

// Bind before revocation so the cutoff still rejects older grants after a sidecar failure.
const bound = approveAdvertisedOrigin({ dataDir: config.dataDir, origin: origin.origin, host: origin.host });
if (bound.ok) {
  // Raise the high-water mark now; the listener may not restart immediately.
  try {
    raiseMobileEpoch({ originBound: true });
  } catch {
    // Binding persistence succeeded; epoch metadata did not.
  }
}
if (!bound.ok && originOnly) {
  out(`Cannot approve: ${bound.reason}`);
  out('Nothing was changed: the certificate is untouched and no device was revoked.');
  process.exit(1);
}
if (!bound.ok) {
  out(`The certificate was replaced, but the advertised origin could not be recorded (${bound.reason}).`);
  out('Paired devices will be revoked because they pin the previous certificate.');
  incomplete = true;
} else {
  out(`Bound the advertised origin to ${bound.origin}.`);
  const was = bound.previousOrigin || previousOrigin;
  if (was && was !== bound.origin) {
    out(`It was ${was}: every phone that paired at that address must pair again.`);
  }
}

// Revoke only after the certificate or origin change succeeds.
const revoked = revokeAllDevices();
if (!revoked.ok) {
  // Report the completed change before revocation failure.
  if (originOnly) {
    out(`The advertised origin was updated, but paired-device revocation failed (${revoked.reason}).`);
    out('Existing devices remain refused because their approved origin changed.');
    out('After restart, revoke them individually from the Devices page.');
  } else {
    out(`The certificate was replaced, but paired-device revocation failed (${revoked.reason}).`);
    out('Existing devices remain refused because they pin the previous certificate.');
    out('After restart, revoke them individually from the Devices page.');
  }
  out(`Restart Companion (${RESTART_COMMAND}), then re-pair every phone from the Devices page.`);
  process.exit(1);
}
out(`Revoked ${revoked.revoked} of ${revoked.total} paired device families: each pinned the ${originOnly ? 'address' : 'certificate'} that has just been replaced.`);
out(`Restart Companion (${RESTART_COMMAND}), then re-pair every phone from the Devices page.`);
if (incomplete) process.exit(1);
