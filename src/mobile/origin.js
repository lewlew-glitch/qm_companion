// Configuration-independent canonical origin parser for the mobile plane.

import { isIP } from 'node:net';

// Canonical HTTPS origin with explicit port and no extra URL components.
const ORIGIN_RE = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\]|(\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/;

const MAX_DNS_NAME = 253;
const MAX_DNS_LABEL = 63;

/** Strip the brackets an IPv6 literal carries in an origin. */
export function bareHost(host) {
  return typeof host === 'string' && host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** 'ipv4' | 'ipv6' | 'dns' for a host with or without brackets. */
export function hostKind(host) {
  const bare = bareHost(host);
  const version = isIP(bare);
  if (version === 4) return 'ipv4';
  if (version === 6) return 'ipv6';
  return 'dns';
}

function ipv4Reason(bare) {
  const parts = bare.split('.');
  if (parts.length !== 4) return 'is not a valid IPv4 address';
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'is not a valid IPv4 address';
  if (parts.some((part) => part.length > 1 && part.startsWith('0'))) return 'must not spell an IPv4 address with leading zeros';
  // Wildcard binds are not valid advertised host identities.
  if (octets[0] === 0) return 'must not be the unspecified (wildcard) address; bind to 0.0.0.0 with MOBILE_BIND_ADDRESS and advertise the address phones actually reach';
  if (octets[0] >= 224 && octets[0] <= 239) return 'must not be a multicast address';
  if (octets[0] >= 240) return 'must not be a reserved or broadcast address';
  return null;
}

/** Expand an IPv6 literal to eight groups, folding a dotted IPv4 tail when present. */
function ipv6Groups(bare) {
  let text = bare.toLowerCase();
  const dotted = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${dotted[1]}${(((octets[0] << 8) | octets[1]) >>> 0).toString(16)}:${(((octets[2] << 8) | octets[3]) >>> 0).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const values = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return values.some((value) => Number.isNaN(value)) ? null : values;
}

function ipv6Reason(bare) {
  const groups = ipv6Groups(bare);
  if (!groups) return 'is not a valid IPv6 address';
  // Apply IPv4 rules only to mapped IPv6 addresses.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const dotted = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    const reason = ipv4Reason(dotted);
    if (reason) return reason;
  }
  if (groups.every((group) => group === 0)) {
    return 'must not be the unspecified (wildcard) address; bind to :: with MOBILE_BIND_ADDRESS and advertise the address phones actually reach';
  }
  if ((groups[0] & 0xff00) === 0xff00) return 'must not be a multicast address';
  return null;
}

const DNS_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function dnsReason(bare) {
  // A colon-bearing value rejected by isIP() is malformed IPv6, not DNS.
  if (bare.includes(':')) return 'is not a valid IPv6 address';
  // A numeric dotted value rejected by isIP() is malformed IPv4, not DNS.
  if (/^[0-9.]+$/.test(bare)) return 'is not a valid IPv4 address';
  if (bare.length > MAX_DNS_NAME) return 'host name is too long';
  if (bare.split('.').some((label) => label.length === 0 || label.length > MAX_DNS_LABEL)) return 'host name has an invalid label';
  if (!DNS_NAME_RE.test(bare.toLowerCase())) return 'is not a DNS name or IP literal';
  return null;
}

/** Return why a host cannot be advertised; loopback remains valid for same-host clients. */
export function unusableHostReason(host) {
  const bare = bareHost(host);
  if (typeof bare !== 'string' || bare.length === 0) return 'is not a host';
  const kind = hostKind(bare);
  if (kind === 'ipv4') return ipv4Reason(bare);
  if (kind === 'ipv6') return ipv6Reason(bare);
  return dnsReason(bare);
}

/** Parse the explicit canonical origin shared by SAN, QR, transcript, and pages. */
export function parseAdvertisedOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, error: 'QM_ADVERTISED_ORIGIN is not set' };
  if (value.length > 255) return { ok: false, error: 'QM_ADVERTISED_ORIGIN is too long' };
  const match = ORIGIN_RE.exec(value);
  if (!match) return { ok: false, error: 'QM_ADVERTISED_ORIGIN must be an exact https origin with an explicit port, like https://nas.local:8788' };
  const port = Number(match[match.length - 1]);
  if (port < 1 || port > 65535) return { ok: false, error: 'QM_ADVERTISED_ORIGIN port is out of range' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'QM_ADVERTISED_ORIGIN is not a valid URL' };
  }
  // Rebuild the origin to preserve an explicit default port.
  if (`https://${parsed.hostname}:${port}` !== value) {
    return { ok: false, error: 'QM_ADVERTISED_ORIGIN must be exactly an origin' };
  }
  const unusable = unusableHostReason(parsed.hostname);
  if (unusable) return { ok: false, error: `QM_ADVERTISED_ORIGIN ${unusable}` };
  return { ok: true, origin: value, host: parsed.hostname, port };
}
