import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

function invalid(name, detail) {
  throw new Error(`${name} ${detail}`);
}

// Accept a host only; callers add the scheme and port.
export function canonicalHost(value, { name = 'host', required = true } = {}) {
  if (value == null || value === '') {
    if (required) invalid(name, 'is required');
    return '';
  }
  if (typeof value !== 'string') invalid(name, 'must be a host name or IP address');
  if (value !== value.trim() || /\s/u.test(value)) invalid(name, 'must not contain whitespace');
  if (/[\/@?#]/u.test(value)) invalid(name, 'must contain only a host, not a URL or path');

  if (value.startsWith('[') || value.endsWith(']')) {
    if (!/^\[[^\[\]]+\]$/.test(value)) invalid(name, 'has invalid IPv6 brackets');
    const address = value.slice(1, -1);
    if (isIP(address) !== 6) invalid(name, 'must contain a valid IPv6 address inside brackets');
    // URL.hostname returns a compressed, lower-case, bracketed IPv6 host on supported Node 20+.
    return new URL(`http://${value}`).hostname.toLowerCase();
  }

  if (value.includes(':')) invalid(name, 'must not include a port; bracket IPv6 addresses');
  if (isIP(value) === 4) return value;

  const withoutRootDot = value.endsWith('.') ? value.slice(0, -1) : value;
  const ascii = domainToASCII(withoutRootDot).toLowerCase();
  if (!ascii || ascii.length > 253) invalid(name, 'must be a valid host name');
  // Reject legacy numeric IPv4 formats accepted by WHATWG parsing.
  if (isIP(ascii) === 4) invalid(name, 'must use canonical dotted-decimal IPv4');
  const labels = ascii.split('.');
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    invalid(name, 'must be a valid host name');
  }
  return ascii;
}

export function integerSetting(value, { name, fallback, min, max }) {
  const chosen = value == null || value === '' ? String(fallback) : String(value);
  if (!/^\d+$/.test(chosen)) invalid(name, `must be a whole number from ${min} to ${max}`);
  const number = Number(chosen);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    invalid(name, `must be a whole number from ${min} to ${max}`);
  }
  return number;
}

export function numberSetting(value, { name, fallback, min, max }) {
  const chosen = value == null || value === '' ? String(fallback) : String(value);
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(chosen)) invalid(name, `must be a number from ${min} to ${max}`);
  const number = Number(chosen);
  if (!Number.isFinite(number) || number < min || number > max) {
    invalid(name, `must be a number from ${min} to ${max}`);
  }
  return number;
}
