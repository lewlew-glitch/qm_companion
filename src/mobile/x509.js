// Minimal self-signed X.509 v3 builder for one P-256 server leaf and SAN.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isIP } from 'node:net';
import { unusableHostReason } from './origin.js';

const OID = {
  commonName: '2.5.4.3',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyIdentifier: '2.5.29.14',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, body) {
  const content = Buffer.isBuffer(body) ? body : Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const sequence = (...parts) => tlv(0x30, parts);
const set = (...parts) => tlv(0x31, parts);
const octetString = (body) => tlv(0x04, body);
const utf8String = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const explicit = (n, body) => tlv(0xa0 | n, body);
const boolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));

function integer(bytes) {
  // Positive, minimal two's-complement encoding.
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0 && (bytes[i + 1] & 0x80) === 0) i += 1;
  const trimmed = bytes.subarray(i);
  return tlv(0x02, trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(text) {
  const arcs = text.split('.').map(Number);
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [];
    let v = arc;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let j = 0; j < chunk.length - 1; j += 1) chunk[j] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function bitString(body, unusedBits = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), body]));
}

function time(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const year = date.getUTCFullYear();
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  // UTCTime covers 1950..2049; anything later must be GeneralizedTime (RFC 5280 4.1.2.5).
  if (year >= 1950 && year <= 2049) return tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}`, 'ascii'));
  return tlv(0x18, Buffer.from(`${pad(year, 4)}${rest}`, 'ascii'));
}

function name(commonName) {
  return sequence(set(sequence(oid(OID.commonName), utf8String(commonName))));
}

function extension(id, critical, body) {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(body));
}

function ipBytes(host) {
  if (isIP(host) === 4) return Buffer.from(host.split('.').map(Number));
  // Expand IPv6 to eight groups and reject IPv4-mapped tails.
  if (host.includes('.')) throw new Error('IPv4-mapped IPv6 addresses are not supported in the SAN');
  const [head, tail = ''] = host.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...new Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) throw new Error('malformed IPv6 address');
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

/** Encode an advertised host as an IP or DNS SAN. */
export function generalName(host) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // Reject bind-only identities before SAN encoding.
  const unusable = unusableHostReason(bare);
  if (unusable) throw new Error(`host ${unusable}`);
  if (isIP(bare)) return { kind: 'ip', host: bare, der: tlv(0x87, ipBytes(bare)) };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(bare)) throw new Error('host is not a DNS name or IP literal');
  return { kind: 'dns', host: bare, der: tlv(0x82, Buffer.from(bare, 'ascii')) };
}

/** Build a self-signed P-256 leaf for one host. Returns PEM strings plus the SAN kind. */
export function buildSelfSignedCertificate({ host, days = 825, now = new Date() }) {
  if (!Number.isInteger(days) || days < 1 || days > 825) throw new Error('validity must be 1..825 days');
  const san = generalName(host);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // The subjectPublicKey bit string is the last 65 bytes of a P-256 SPKI (uncompressed point).
  const keyId = createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  const notBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + days * 24 * 60 * 60 * 1000);
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name(san.host),
    sequence(time(notBefore), time(notAfter)),
    name(san.host),
    spki,
    explicit(3, sequence(
      extension(OID.basicConstraints, true, sequence()),
      extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)),
      extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, sequence(san.der)),
      extension(OID.subjectKeyIdentifier, false, octetString(keyId)),
    )),
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = sequence(tbs, algorithm, bitString(signature));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { certPem, keyPem, sanKind: san.kind, host: san.host, notBefore, notAfter };
}
