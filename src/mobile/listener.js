// TLS 1.2+ listener for device routes and the secure owner surface.
// Listener failures do not stop the main HTTP server.

import { createHash, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';

import { config } from '../config.js';
import { mobileListenerPlan } from './config.js';
import { bindAdvertisedOrigin, ensureMobileCertificate } from './cert.js';
import { readEpoch } from './epoch.js';
import { raiseMobileEpoch } from './store.js';
import { bootMobileClone } from './clone.js';
import { bindDeviceOriginCut, bindDeviceTlsLeaf } from './devices.js';
import { mobileFeatures } from './features.js';
import { createOwnerSurface } from './owner-plane.js';
import { createMobileRouter } from './routes.js';
import { loadMobileState } from './store.js';
import { send } from '../http.js';

export function leafFingerprint(certPem) {
  const leaf = new X509Certificate(certPem);
  return createHash('sha256').update(leaf.raw).digest('hex');
}

// Result of the latest listener start attempt.
let status = null;

function off(reason, extra = {}) {
  status = { ok: false, reason, ...extra };
  return status;
}

/** Return the configured plan plus the latest runtime outcome. */
export function mobileListenerStatus() {
  const plan = mobileListenerPlan();
  if (!plan.ok) return plan;
  if (status) return { ...plan, ...status };
  return plan;
}

/** Return the secure owner configuration, or null when HTTPS mode is disabled. */
export function secureOwnerConfiguration() {
  if (!mobileFeatures().api) return null;
  const plan = mobileListenerPlan();
  // Keep HTTPS mode active even when the listener fails.
  const live = mobileListenerStatus();
  return {
    origin: plan.ok === true && typeof plan.origin === 'string' ? plan.origin : null,
    reason: plan.ok === true ? null : plan.reason,
    failure: plan.ok === true && live && live.ok === false ? live.reason : null,
  };
}

/** Clear the recorded runtime outcome. */
export function resetMobileListenerStatus() {
  status = null;
}

// Null until server boot preparation runs.
let bootVerdict = null;

/** Complete or recover clone-as-new state before either listener starts. */
export function prepareMobilePlane({ log = (line) => process.stdout.write(line) } = {}) {
  bootVerdict = bootMobileClone({ log });
  return bootVerdict;
}

/** Clear the recorded boot verdict. */
export function resetMobilePlaneBoot() {
  bootVerdict = null;
}

const describe = (error) => error?.code || error?.message || 'error';

/** Start the HTTPS listener, returning null on a contained startup failure. */
export async function startMobileListener({ log = (line) => process.stdout.write(line) } = {}) {
  const plan = mobileListenerPlan();
  if (!plan.ok) {
    log(`  mobile api: off (${plan.reason})\n`);
    return null;
  }
  const refuse = (reason, extra) => {
    off(reason, extra);
    log(`  mobile api: off (${reason})\n`);
    return null;
  };
  if (bootVerdict && !bootVerdict.listenerAllowed) return refuse(bootVerdict.reason);
  let material;
  try {
    material = ensureMobileCertificate({ dataDir: config.dataDir, host: plan.host });
  } catch (error) {
    return refuse(`TLS material could not be resolved (${describe(error)})`);
  }
  if (!material.ok) return refuse(material.reason, { tlsCode: material.code });
  // Bind grants to the certificate leaf before serving requests.
  bindDeviceTlsLeaf(material.fingerprint);
  let state;
  try {
    state = loadMobileState();
  } catch (error) {
    return refuse(error.message);
  }
  if (state.tlsResetPending) return refuse('tlsResetPending; finish the clone-as-new TLS regeneration first');
  // Bind grants to the advertised origin.
  const pairedDevices = state.devices.filter((device) => device.revokedAt === null).length;
  // Epoch state distinguishes first boot from deleted authority state.
  const epoch = readEpoch();
  const everBound = epoch.state === 'ok' && epoch.epoch.originBound;
  // Preserve origin protection after sidecar loss.
  const everPaired = epoch.state === 'ok' && epoch.epoch.devicesSeen;
  const bound = bindAdvertisedOrigin({
    dataDir: config.dataDir,
    origin: plan.origin,
    fingerprint: material.fingerprint,
    pairedDevices,
    grantsExist: pairedDevices > 0 || everPaired,
    everBound,
  });
  if (!bound.ok) return refuse(bound.reason, { tlsCode: bound.code });
  // The binding file is authoritative; epoch persistence is best-effort here.
  try {
    raiseMobileEpoch({ originBound: true, devicesSeen: pairedDevices > 0 });
  } catch {
    // Binding has already been persisted.
  }
  // Apply the approved-origin cutoff before serving requests.
  bindDeviceOriginCut(bound.boundAt);
  const server = { origin: plan.origin, tlsLeafFingerprint: material.fingerprint };
  let https;
  try {
    // Do not send HSTS from a hostname shared with the plaintext panel.
    const owner = createOwnerSurface();
    const route = createMobileRouter(server, { enrolment: plan.enrolment }, owner);
    https = createServer({ cert: material.cert, key: material.key, minVersion: 'TLSv1.2', honorCipherOrder: true }, (req, res) => {
      route(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, '{"v":1,"error":{"code":"internal","message":"Request failed."}}', { 'content-type': 'application/json', 'cache-control': 'no-store' });
      });
    });
  } catch (error) {
    return refuse(`the HTTPS server refused the TLS material (${describe(error)})`);
  }
  https.headersTimeout = 10_000;
  https.requestTimeout = 30_000;
  https.keepAliveTimeout = 5_000;
  https.maxHeadersCount = 60;
  const tls = { source: material.source, fingerprint: material.fingerprint, certificateHost: material.record?.host || plan.host, createdAt: material.record?.createdAt || null, notAfter: material.notAfter || material.record?.notAfter || null };
  if (material.created) log(`  mobile api: generated a self-signed certificate for ${plan.host} (sha256 ${material.fingerprint.slice(0, 16)}...), kept under ${config.dataDir}/tls\n`);
  if (material.expiresSoon) log(`  mobile api: the ${material.source} certificate expires on ${tls.notAfter}; rotate or replace it and re-pair every phone before then\n`);
  return new Promise((resolve) => {
    let settled = false;
    https.once('error', (error) => {
      // Contain both bind and post-start listener failures.
      const reason = `the listener on ${plan.bind}:${plan.port} failed (${describe(error)})`;
      off(reason);
      log(`  mobile api: off (${reason})\n`);
      try { https.close(); } catch { /* already down */ }
      if (!settled) { settled = true; resolve(null); }
    });
    https.listen(plan.port, plan.bind, () => {
      status = { ok: true, tls };
      log(`  mobile api: ${plan.origin} (listening on ${plan.bind}:${plan.port}, pairing ${plan.enrolment ? 'on' : 'off'}, tls ${material.source} leaf ${material.fingerprint.slice(0, 16)}...)\n`);
      if (!settled) { settled = true; resolve({ server: https, origin: plan.origin, tlsLeafFingerprint: material.fingerprint, tls }); }
    });
  });
}
