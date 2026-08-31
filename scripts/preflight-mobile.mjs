#!/usr/bin/env node
// Validate the mobile bind IP and advertised origin before starting Compose:
//
//   QM_MOBILE_BIND_IP=192.168.1.20 QM_ADVERTISED_ORIGIN=https://192.168.1.20:8788 \
//     node scripts/preflight-mobile.mjs
// This command does not write files, contact Docker, or print secrets.

import { networkInterfaces } from 'node:os';

import { parseAdvertisedOrigin, unusableHostReason } from '../src/mobile/origin.js';

const out = (line) => process.stdout.write(`${line}\n`);
const problems = [];

const bind = process.env.QM_MOBILE_BIND_IP || '';
const advertised = process.env.QM_ADVERTISED_ORIGIN || '';

out(`Docker host bind IP    ${bind || 'not set'}`);
out(`Advertised origin      ${advertised || 'not set'}`);
out('');

if (!bind) {
  problems.push('QM_MOBILE_BIND_IP is not set: the Docker host IP to publish 8788 on');
} else {
  const local = Object.values(networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((entry) => entry.address);
  if (unusableHostReason(bind)) {
    problems.push(`QM_MOBILE_BIND_IP ${unusableHostReason(bind)}; publish on one exact address this host owns`);
  } else if (!local.includes(bind)) {
    problems.push(`QM_MOBILE_BIND_IP ${bind} is not an address on this host. Docker would refuse the publish and the container would not start, taking the 8787 panel with it. Addresses found: ${local.join(', ')}`);
  } else {
    out(`ok  ${bind} is assigned to this host, so Docker can publish 8788 on it`);
  }
}

if (!advertised) {
  problems.push('QM_ADVERTISED_ORIGIN is not set: the exact https origin the phone connects to');
} else {
  const parsed = parseAdvertisedOrigin(advertised);
  if (!parsed.ok) {
    problems.push(parsed.error);
  } else {
    out(`ok  ${parsed.origin} is a usable advertised identity (host ${parsed.host}, port ${parsed.port})`);
    const port = Number(process.env.MOBILE_PORT || 8788);
    if (parsed.port !== port) {
      problems.push(`QM_ADVERTISED_ORIGIN port ${parsed.port} does not match MOBILE_PORT ${port}; the advertised origin must be the address phones reach`);
    }
    if (parsed.host !== bind) {
      out(`note ${parsed.host} differs from the bind address ${bind || 'not set'}. That is correct for a Tailscale MagicDNS install; make sure the phone really reaches it.`);
    }
  }
}

out('');
if (problems.length > 0) {
  out(`Not safe to deploy: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
  for (const reason of problems) out(`  - ${reason}`);
  process.exit(1);
}
out('Safe to deploy: apply docker-compose.mobile.yml after files that change ports, then verify 8787 and 8788 from another machine.');
process.exit(0);
