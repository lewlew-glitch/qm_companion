// Discover service instances from Docker and mounted configuration files.

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { availabilityFor } from './availability.js';
import { dockerGetJson } from './docker.js';
import { PORTS, matchImage } from './kinds.js';
import { probeHostAll, probeInstances } from './probe.js';

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_KEY_CHARS = 16_384;

const HOMEPAGE_SCALAR_KEY_KINDS = new Set([
  'radarr', 'sonarr', 'lidarr', 'prowlarr', 'bazarr', 'sabnzbd', 'jackett', 'nzbhydra2', 'qui',
  'jellyfin', 'emby', 'plex', 'jellyseerr', 'wizarr', 'tautulli', 'jellystat', 'tracearr',
  'portainer', 'arcane', 'coolify', 'technitium', 'homeassistant', 'truenas', 'unraid', 'kavita',
  'audiobookshelf', 'readmeabook', 'shelfarr', 'immich',
]);

const CONFIG_CREDENTIAL_FILES = {
  radarr: { sourcePath: '/config/config.xml', mountedName: 'config.xml', maxBytes: 256 * 1024, format: 'xml' },
  sonarr: { sourcePath: '/config/config.xml', mountedName: 'config.xml', maxBytes: 256 * 1024, format: 'xml' },
  lidarr: { sourcePath: '/config/config.xml', mountedName: 'config.xml', maxBytes: 256 * 1024, format: 'xml' },
  prowlarr: { sourcePath: '/config/config.xml', mountedName: 'config.xml', maxBytes: 256 * 1024, format: 'xml' },
  bazarr: { sourcePath: '/config/config/config.yaml', mountedName: 'config.yaml', maxBytes: 512 * 1024, format: 'bazarr-yaml' },
  sabnzbd: { sourcePath: '/config/sabnzbd.ini', mountedName: 'sabnzbd.ini', maxBytes: 512 * 1024, format: 'sab-ini' },
  jellyseerr: { sourcePath: '/app/config/settings.json', mountedName: 'settings.json', maxBytes: 512 * 1024, format: 'jellyseerr-json' },
  // Tautulli keeps its key in the [general] block of config.ini, mount /config to /stack/tautulli.
  tautulli: { sourcePath: '/config/config.ini', mountedName: 'config.ini', maxBytes: 512 * 1024, format: 'tautulli-ini' },
  // Jackett's APIKey sits in ServerConfig.json, mount /config/Jackett to /stack/jackett.
  jackett: { sourcePath: '/config/Jackett/ServerConfig.json', mountedName: 'ServerConfig.json', maxBytes: 512 * 1024, format: 'jackett-json' },
  // NZBHydra2 exposes apiKey in the single main block of nzbhydra.yml, mount /config to /stack/nzbhydra2.
  nzbhydra2: { sourcePath: '/config/nzbhydra.yml', mountedName: 'nzbhydra.yml', maxBytes: 512 * 1024, format: 'nzbhydra-yaml' },
};

// Shared with keyladder so supported file sources stay aligned.
export function configFileRule(kind) {
  const rule = CONFIG_CREDENTIAL_FILES[kind];
  return rule ? { ...rule } : undefined;
}

const HOMEPAGE_TYPE_ALIASES = new Map([
  ['overseerr', 'jellyseerr'],
]);

const CONFIG_MOUNT_KIND_ALIASES = new Map([
  ['overseerr', 'jellyseerr'],
]);

function credentialValue(value) {
  if (value === undefined || value === null || value === '') return { absent: true };
  if (typeof value !== 'string') return { invalid: true };
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || value.length > MAX_KEY_CHARS || CONTROL.test(value)) return { invalid: true };
  return { value };
}

function resolveCredentials(...candidates) {
  const values = new Set();
  for (const candidate of candidates) {
    const checked = credentialValue(candidate);
    if (checked.invalid) return { apiKey: undefined, credentialConflict: true };
    if (checked.value) values.add(checked.value);
  }
  if (values.size > 1) return { apiKey: undefined, credentialConflict: true };
  return { apiKey: values.values().next().value, credentialConflict: false };
}

function homepageWidgets(labels) {
  const widgets = new Map();
  const take = (slot, field, value) => {
    if (!widgets.has(slot)) widgets.set(slot, {});
    widgets.get(slot)[field] = value;
  };
  if (Object.hasOwn(labels, 'homepage.widget.type')) take('single', 'type', labels['homepage.widget.type']);
  if (Object.hasOwn(labels, 'homepage.widget.key')) take('single', 'key', labels['homepage.widget.key']);
  for (const [name, value] of Object.entries(labels)) {
    const match = /^homepage\.widgets\[(\d+)\]\.(type|key)$/u.exec(name);
    if (match) take(`indexed-${match[1]}`, match[2], value);
  }
  return [...widgets.values()];
}

export function homepageCredential(kind, labels = {}) {
  if (!HOMEPAGE_SCALAR_KEY_KINDS.has(kind) || !labels || typeof labels !== 'object') {
    return { apiKey: undefined, credentialConflict: false };
  }
  const keys = homepageWidgets(labels)
    .filter((widget) => {
      if (typeof widget.type !== 'string' || !/^[a-z0-9-]+$/u.test(widget.type)) return false;
      const widgetKind = HOMEPAGE_TYPE_ALIASES.get(widget.type) || widget.type;
      return Object.hasOwn(PORTS, widgetKind) && widgetKind === kind;
    })
    .map((widget) => widget.key)
    .filter((value) => value !== undefined && value !== '');
  return resolveCredentials(...keys);
}

function yamlScalar(value) {
  const raw = value.trim();
  if (!raw || raw === '|' || raw === '>') return undefined;
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/gu, "'");
  const withoutComment = raw.replace(/\s+#.*$/u, '').trim();
  return /^[A-Za-z0-9._~+\/-]+$/u.test(withoutComment) ? withoutComment : undefined;
}

// Read one direct scalar from one top-level YAML block without accepting duplicates.
function yamlBlockScalar(text, blockName, keyName) {
  const blockRe = new RegExp(`^${blockName}\\s*:\\s*(?:#.*)?$`, 'iu');
  const keyRe = new RegExp(`^\\s*${keyName}\\s*:\\s*(.+)$`, 'iu');
  const lines = text.split(/\r?\n/u);
  let blockIndent = null;
  let childIndent = null;
  let blocks = 0;
  const candidates = [];
  for (const line of lines) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const indent = /^\s*/u.exec(line)[0].length;
    if (blockIndent === null) {
      if (indent === 0 && blockRe.test(line)) {
        blockIndent = 0;
        childIndent = null;
        blocks += 1;
      }
      continue;
    }
    if (indent <= blockIndent) {
      if (indent === 0 && blockRe.test(line)) {
        blockIndent = 0;
        childIndent = null;
        blocks += 1;
      } else {
        blockIndent = null;
        childIndent = null;
      }
      continue;
    }
    if (/^\s*\t/u.test(line)) return undefined;
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;
    const key = keyRe.exec(line);
    if (key) candidates.push(yamlScalar(key[1]));
  }
  return blocks === 1 && candidates.length === 1 ? candidates[0] : undefined;
}

function iniValue(text, wantedSection, wantedKey) {
  let section = '';
  let wantedSectionCount = 0;
  const candidates = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const heading = /^\[([^\]]+)\]$/u.exec(trimmed);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      if (section === wantedSection) wantedSectionCount += 1;
      continue;
    }
    if (section !== wantedSection) continue;
    const entry = /^([^=:#]+)\s*[=:]\s*(.*)$/u.exec(line);
    if (entry && entry[1].trim().toLowerCase() === wantedKey) candidates.push(entry[2].trim());
  }
  return wantedSectionCount === 1 && candidates.length === 1 ? candidates[0] : undefined;
}

function jsonPropertyCount(text, wantedKey) {
  let count = 0;
  const properties = /"(?:\\[\s\S]|[^"\\])*"\s*:/gu;
  for (const match of text.matchAll(properties)) {
    const raw = match[0].replace(/\s*:$/u, '');
    try {
      if (JSON.parse(raw) === wantedKey) count += 1;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  return count;
}

/** Read one unique object-valued property without parsing duplicate JSON keys. */
function jsonObjectSpan(text, wantedKey) {
  const properties = /"(?:\\[\s\S]|[^"\\])*"\s*:/gu;
  let start = -1;
  for (const match of text.matchAll(properties)) {
    const raw = match[0].replace(/\s*:$/u, '');
    let name;
    try {
      name = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (name !== wantedKey) continue;
    if (start !== -1) return undefined; // the same property twice, anywhere, stays a refusal
    start = match.index + match[0].length;
  }
  if (start === -1) return undefined;
  let at = start;
  while (at < text.length && /\s/u.test(text[at])) at += 1;
  if (text[at] !== '{') return undefined;
  let depth = 0;
  let inString = false;
  for (let i = at; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  return undefined;
}

export function extractContainerApiKey(kind, path, bytes) {
  const rule = CONFIG_CREDENTIAL_FILES[kind];
  if (!rule || rule.sourcePath !== path || !Buffer.isBuffer(bytes) || bytes.length > rule.maxBytes) return undefined;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (CONTROL.test(text.replace(/[\r\n\t]/gu, ''))) return undefined;
  let candidate;
  if (rule.format === 'xml') candidate = uniqueConfigXmlField(text, 'ApiKey');
  else if (rule.format === 'bazarr-yaml') candidate = yamlBlockScalar(text, 'auth', 'apikey');
  else if (rule.format === 'nzbhydra-yaml') candidate = yamlBlockScalar(text, 'main', 'apikey');
  else if (rule.format === 'sab-ini') candidate = iniValue(text, 'misc', 'api_key');
  else if (rule.format === 'tautulli-ini') candidate = iniValue(text, 'general', 'api_key');
  else if (rule.format === 'jackett-json') {
    try {
      if (jsonPropertyCount(text, 'APIKey') !== 1) return undefined;
      const parsed = JSON.parse(text);
      candidate = parsed?.APIKey;
    } catch {
      return undefined;
    }
  } else if (rule.format === 'jellyseerr-json') {
    try {
      // Reject duplicate main or apiKey properties before JSON.parse discards them.
      const main = jsonObjectSpan(text, 'main');
      if (main === undefined || jsonPropertyCount(main, 'apiKey') !== 1) return undefined;
      const parsed = JSON.parse(text);
      candidate = parsed?.main?.apiKey;
    } catch {
      return undefined;
    }
  }
  const checked = credentialValue(candidate);
  return checked.value;
}

function validPort(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : undefined;
}

function identityPart(value) {
  return String(value || '').trim().toLowerCase();
}

export function mountedConfigKind(instanceName) {
  const name = String(instanceName || '').toLowerCase();
  for (const [alias, kind] of CONFIG_MOUNT_KIND_ALIASES) {
    if (
      name === alias || name.startsWith(`${alias}-`) ||
      name.startsWith(`${alias}_`) || name.startsWith(`${alias}.`)
    ) return kind;
  }
  return Object.keys(CONFIG_CREDENTIAL_FILES).find((kind) => (
    name === kind || name.startsWith(`${kind}-`) || name.startsWith(`${kind}_`) || name.startsWith(`${kind}.`)
  ));
}

function instanceId(kind, identity) {
  const safeKind = String(kind).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'service';
  const hash = createHash('sha256').update(`${kind}\0${identity}`).digest('hex').slice(0, 16);
  return `${safeKind}-${hash}`;
}

function publicRow(row) {
  const id = instanceId(row.kind, row.identity);
  const publishedPort = validPort(row.publishedPort);
  const containerPort = validPort(row.containerPort);
  const configPort = validPort(row.configPort);
  const port = publishedPort || configPort || PORTS[row.kind];
  const out = {
    instanceId: id,
    instanceKey: id,
    kind: row.kind,
    name: row.name || row.kind,
    port,
    apiKey: row.apiKey,
    credentialConflict: row.credentialConflict === true,
    sources: [...new Set(row.sources || [])],
  };
  if (publishedPort) out.publishedPort = publishedPort;
  // Retain alternate host routes to the same container port.
  const alternates = [...new Set((row.publishedPortAlternates || []).map(validPort).filter(Boolean))]
    .filter((value) => value !== publishedPort).sort((a, b) => a - b);
  if (publishedPort && alternates.length > 0) out.publishedPortAlternates = alternates;
  // Container ports determine protocol; host ports determine the dial target.
  if (containerPort) out.containerPort = containerPort;
  if (configPort) out.configPort = configPort;
  if (typeof row.dockerState === 'string' && row.dockerState) out.dockerState = row.dockerState;
  if (row.up !== undefined) out.up = row.up;
  if (row.url !== undefined) out.url = row.url;
  out.availability = availabilityFor(out);
  return out;
}

// Preserve Docker's lifecycle state, or an empty string when absent.
function containerState(container) {
  return typeof container.State === 'string' ? container.State.trim().toLowerCase() : '';
}

// Running containers remain unclassified until probed.
function containerUp(container) {
  const state = containerState(container);
  return state && state !== 'running' ? false : undefined;
}

/** Return a deterministic TCP mapping, or undefined for ambiguous container ports. */
export function publishedMappingOf(containerPorts, kind) {
  const seen = new Set();
  const ports = [];
  for (const port of containerPorts || []) {
    if (port.Type !== 'tcp' || !validPort(port.PublicPort)) continue;
    const mapping = { privatePort: validPort(port.PrivatePort), publicPort: validPort(port.PublicPort) };
    const key = `${mapping.privatePort}:${mapping.publicPort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push(mapping);
  }
  const exact = ports.filter((port) => port.privatePort === PORTS[kind]);
  const candidates = exact.length > 0 ? exact : ports;
  // Different container ports are ambiguous unless one matches the service's known default.
  const privatePorts = new Set(candidates.map((port) => port.privatePort));
  if (candidates.length === 0 || privatePorts.size !== 1) return undefined;
  // Choose the lowest host port and retain the alternatives.
  const publicPorts = [...new Set(candidates.map((port) => port.publicPort))].sort((a, b) => a - b);
  const mapping = { privatePort: candidates[0].privatePort, publicPort: publicPorts[0] };
  if (publicPorts.length > 1) mapping.alternatePublicPorts = publicPorts.slice(1);
  return mapping;
}

// The public half on its own, for callers that only need somewhere to dial.
export function publishedPortOf(containerPorts, kind) {
  const mapping = publishedMappingOf(containerPorts, kind);
  return mapping ? mapping.publicPort : undefined;
}

async function fromDocker() {
  const containers = await dockerGetJson('/containers/json?all=1');
  if (!Array.isArray(containers)) return [];

  const found = [];
  for (const container of containers) {
    const name = (container.Names && container.Names[0] ? container.Names[0] : '').replace(/^\//, '');
    const kind = matchImage(container.Image, name);
    if (!kind) continue;

    const mapping = publishedMappingOf(container.Ports, kind);
    const labels = container.Labels || {};
    const composeService = labels['com.docker.compose.service'] || '';
    const displayName = name || composeService || kind;
    const identity = `docker:${name || composeService || container.Id || displayName}`;
    const homepage = homepageCredential(kind, labels);
    found.push({
      kind,
      name: displayName,
      identity,
      aliases: [name, composeService].map(identityPart).filter(Boolean),
      publishedPort: mapping ? mapping.publicPort : undefined,
      // Alternate published routes to the same container port.
      publishedPortAlternates: mapping ? mapping.alternatePublicPorts : undefined,
      // Preserve the container port for protocol selection.
      containerPort: mapping ? mapping.privatePort : undefined,
      apiKey: homepage.apiKey,
      credentialConflict: homepage.credentialConflict,
      sources: ['docker'],
      dockerState: containerState(container),
      // Probe running containers; classify other states as unreachable.
      up: containerUp(container),
    });
  }
  return found;
}

function xmlText(value) {
  if (value.includes(']]>') || value.includes('&')) return undefined;
  return value;
}

function parseConfigXml(xml) {
  let source = xml.startsWith('\uFEFF') ? xml.slice(1) : xml;
  const declaration = /^<\?xml\s+version\s*=\s*(?:"1\.[01]"|'1\.[01]')(?:\s+encoding\s*=\s*(?:"utf-8"|'utf-8'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/iu.exec(source);
  if (/^<\?xml\b/iu.test(source)) {
    if (!declaration) return undefined;
    source = source.slice(declaration[0].length);
  }
  if (source.includes('<?')) return undefined;

  const tagName = '[A-Za-z_][A-Za-z0-9_.-]*';
  const opening = new RegExp(`^<(${tagName})>$`, 'u');
  const closing = new RegExp(`^</(${tagName})>$`, 'u');
  const empty = new RegExp(`^<(${tagName})\\s*/>$`, 'u');
  const stack = [];
  const fields = new Map();
  const counts = new Map();
  let directChild;
  let cursor = 0;
  let rootSeen = false;
  let rootClosed = false;

  const countTag = (name) => counts.set(name, (counts.get(name) || 0) + 1);
  const saveDirectChild = () => {
    if (!directChild) return;
    if (!fields.has(directChild.name)) fields.set(directChild.name, []);
    if (!directChild.complex) fields.get(directChild.name).push(directChild.text.trim());
    directChild = undefined;
  };

  while (cursor < source.length) {
    const nextTag = source.indexOf('<', cursor);
    const endOfText = nextTag === -1 ? source.length : nextTag;
    const rawText = source.slice(cursor, endOfText);
    const decoded = xmlText(rawText);
    if (decoded === undefined) return undefined;
    if (stack.length === 0 && decoded.trim()) return undefined;
    if (stack.length === 1 && decoded.trim()) return undefined;
    if (stack.length === 2 && directChild) directChild.text += decoded;
    if (nextTag === -1) {
      cursor = source.length;
      break;
    }

    if (source.startsWith('<!--', nextTag)) {
      const commentEnd = source.indexOf('-->', nextTag + 4);
      if (commentEnd === -1 || source.slice(nextTag + 4, commentEnd).includes('--')) return undefined;
      if (directChild) directChild.complex = true;
      cursor = commentEnd + 3;
      continue;
    }
    if (source.startsWith('<!', nextTag)) return undefined;

    const tagEnd = source.indexOf('>', nextTag + 1);
    if (tagEnd === -1) return undefined;
    const token = source.slice(nextTag, tagEnd + 1);
    const closeMatch = closing.exec(token);
    const emptyMatch = empty.exec(token);
    const openMatch = opening.exec(token);

    if (closeMatch) {
      if (!stack.length || stack.at(-1) !== closeMatch[1]) return undefined;
      if (stack.length === 2) saveDirectChild();
      stack.pop();
      if (!stack.length) rootClosed = true;
    } else if (emptyMatch) {
      const name = emptyMatch[1];
      countTag(name);
      if (!stack.length) {
        if (rootSeen || rootClosed || name !== 'Config') return undefined;
        rootSeen = true;
        rootClosed = true;
      } else if (stack.length === 1) {
        directChild = { name, text: '', complex: false };
        saveDirectChild();
      } else if (directChild) {
        directChild.complex = true;
      }
    } else if (openMatch) {
      const name = openMatch[1];
      countTag(name);
      if (!stack.length) {
        if (rootSeen || rootClosed || name !== 'Config') return undefined;
        rootSeen = true;
      } else if (stack.length === 1) {
        directChild = { name, text: '', complex: false };
      } else if (directChild) {
        directChild.complex = true;
      }
      stack.push(name);
    } else {
      return undefined;
    }
    cursor = tagEnd + 1;
  }

  if (!rootSeen || !rootClosed || stack.length || directChild) return undefined;
  return { fields, counts };
}

function uniqueConfigXmlField(xml, name) {
  const parsed = parseConfigXml(xml);
  const values = parsed?.fields.get(name) || [];
  return parsed?.counts.get(name) === 1 && values.length === 1 ? values[0] : undefined;
}

// Shared bounded file reader for discovery and stack adoption.
export function readMountedConfigFile(stackDir, instanceName, fileName, maxBytes) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) return undefined;
  const root = resolve(stackDir);
  const instanceDir = resolve(root, instanceName);
  const file = resolve(instanceDir, fileName);
  if (!instanceDir.startsWith(`${root}/`) || !file.startsWith(`${instanceDir}/`)) return undefined;
  let descriptor;
  try {
    const rootStats = lstatSync(root);
    const instanceStats = lstatSync(instanceDir);
    const fileStats = lstatSync(file);
    if (
      rootStats.isSymbolicLink() || !rootStats.isDirectory() ||
      instanceStats.isSymbolicLink() || !instanceStats.isDirectory() ||
      fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.size > maxBytes
    ) return undefined;
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size < 1 || opened.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(descriptor, buffer, total, buffer.length - total, null);
      if (!count) break;
      total += count;
    }
    return total > maxBytes ? undefined : buffer.subarray(0, total);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* the read already failed closed */ }
    }
  }
}

function fromConfigDir(stackDir) {
  if (!stackDir || !existsSync(stackDir)) return [];
  let entries;
  try {
    entries = readdirSync(stackDir);
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const kind = mountedConfigKind(entry);
    if (!kind) continue;
    const rule = CONFIG_CREDENTIAL_FILES[kind];
    if (!rule) continue;
    const bytes = readMountedConfigFile(stackDir, entry, rule.mountedName, rule.maxBytes);
    const apiKey = bytes ? extractContainerApiKey(kind, rule.sourcePath, bytes) : undefined;
    if (!apiKey) continue;
    const text = bytes.toString('utf8');
    const nameCandidate = rule.format === 'xml' ? uniqueConfigXmlField(text, 'InstanceName') : undefined;
    const configuredName = nameCandidate && nameCandidate.length <= 128 && !CONTROL.test(nameCandidate)
      ? nameCandidate
      : undefined;
    const name = configuredName || entry;
    const file = join(resolve(stackDir), entry, rule.mountedName);
    found.push({
      kind,
      name,
      identity: `config:${resolve(file)}`,
      aliases: [entry].map(identityPart).filter(Boolean),
      configPort: rule.format === 'xml' ? validPort(uniqueConfigXmlField(text, 'Port')) : undefined,
      apiKey,
      sources: ['config'],
    });
  }
  return found;
}

function aliasesMeet(left, right) {
  const rightAliases = new Set(right.aliases || []);
  return (left.aliases || []).some((alias) => rightAliases.has(alias));
}

export function mergeDetectedServices(dockerRows, configRows) {
  const docker = dockerRows.map((row) => ({ ...row }));
  const files = configRows.map((row) => ({ ...row }));
  const dockerMatches = docker.map((row) => files
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.kind === row.kind && aliasesMeet(row, candidate))
    .map(({ index }) => index));
  const fileMatches = files.map((row) => docker
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.kind === row.kind && aliasesMeet(row, candidate))
    .map(({ index }) => index));
  const usedDocker = new Set();
  const usedFiles = new Set();
  const merged = [];

  for (let dockerIndex = 0; dockerIndex < docker.length; dockerIndex += 1) {
    const matches = dockerMatches[dockerIndex];
    if (matches.length !== 1) continue;
    const fileIndex = matches[0];
    if (fileMatches[fileIndex].length !== 1) continue;
    const container = docker[dockerIndex];
    const file = files[fileIndex];
    usedDocker.add(dockerIndex);
    usedFiles.add(fileIndex);
    const credential = resolveCredentials(container.apiKey, file.apiKey);
    merged.push(publicRow({
      kind: container.kind,
      name: container.name || file.name,
      identity: container.identity,
      publishedPort: container.publishedPort,
      containerPort: container.containerPort,
      configPort: file.configPort,
      // Merge configuration sources only after a unique instance match.
      apiKey: credential.apiKey,
      credentialConflict: container.credentialConflict || file.credentialConflict || credential.credentialConflict,
      sources: [...(container.sources || []), ...(file.sources || [])],
      dockerState: container.dockerState,
      up: container.up,
    }));
  }

  docker.forEach((row, index) => {
    if (!usedDocker.has(index)) merged.push(publicRow(row));
  });
  files.forEach((row, index) => {
    if (!usedFiles.has(index)) merged.push(publicRow(row));
  });
  return merged.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.instanceId.localeCompare(b.instanceId));
}

export { availabilityFor };

export async function detectServices(stackDir) {
  return mergeDetectedServices(await fromDocker(), fromConfigDir(stackDir));
}

// File and label credentials take precedence over minted keys.
export function applyMintedKeys(services, mintedKeys) {
  const minted = mintedKeys && typeof mintedKeys === 'object' ? mintedKeys : {};
  const stale = [];
  const rows = (services || []).map((row) => {
    const record = minted[row.instanceId];
    if (!record || typeof record.apiKey !== 'string' || !record.apiKey) return row;
    if (row.credentialConflict === true) return row; // preserve the existing conflict decision
    const existing = typeof row.apiKey === 'string' ? row.apiKey : '';
    if (existing) {
      // Mark conflicting minted keys as stale.
      if (existing !== record.apiKey) stale.push(row.instanceId);
      return row;
    }
    return { ...row, apiKey: record.apiKey };
  });
  return { services: rows, stale };
}

// Apply confirmed probe results by instance; instance probes override default-port probes.
export function mergeLiveProbes(local, live, host) {
  const rows = local.map((row) => ({ ...row, up: row.up === undefined ? null : row.up, url: row.url || null }));
  const settle = (row) => ({ ...row, availability: availabilityFor(row) });
  // Do not attach probe results to non-running Docker containers.
  const exactRows = (probe) => rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.kind === probe.kind && row.port === probe.port && availabilityFor(row) !== 'not-running');
  for (const probe of live || []) {
    if (probe.instanceId) {
      const at = rows.findIndex((row) => row.instanceId === probe.instanceId && availabilityFor(row) !== 'not-running');
      if (at === -1) continue;
      if (probe.up === false) rows[at] = { ...rows[at], up: false, url: rows[at].url || probe.url || null };
      else if (probe.up === true && probe.confirmed === true) rows[at] = { ...rows[at], up: true, url: probe.url };
      // Leave unconfirmed responses unclassified.
      continue;
    }
    const exact = exactRows(probe);
    if (probe.up === false) {
      if (exact.length === 1) {
        const at = exact[0].index;
        rows[at] = { ...rows[at], up: false, url: rows[at].url || probe.url || null };
      }
      continue;
    }
    if (probe.up !== true || probe.confirmed === false) continue;
    if (exact.length === 1) {
      const at = exact[0].index;
      rows[at] = { ...rows[at], up: true, url: probe.url };
      continue;
    }
    rows.push(publicRow({
      kind: probe.kind,
      name: `${probe.kind} at ${host}:${probe.port}`,
      identity: `probe:${host}:${probe.kind}:${probe.port}`,
      configPort: probe.port,
      sources: ['probe'],
      up: true,
      url: probe.url,
    }));
  }
  return rows.map(settle).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.instanceId.localeCompare(b.instanceId));
}

export async function gatherStack(stackDir, host) {
  const local = await detectServices(stackDir);
  // Apply instance probes after the default-port sweep.
  const [defaults, instances] = host
    ? await Promise.all([probeHostAll(host), probeInstances(host, local)])
    : [[], []];
  return mergeLiveProbes(local, [...defaults, ...instances], host);
}

// Resolve detected instances through fixed per-kind source rules.
export async function resolveContainerForInstance(wantedId) {
  if (typeof wantedId !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(wantedId)) return null;
  const containers = await dockerGetJson('/containers/json?all=1');
  if (!Array.isArray(containers)) return null;
  for (const container of containers) {
    const name = (container.Names && container.Names[0] ? container.Names[0] : '').replace(/^\//, '');
    const kind = matchImage(container.Image, name);
    if (!kind) continue;
    const labels = container.Labels || {};
    const composeService = labels['com.docker.compose.service'] || '';
    const displayName = name || composeService || kind;
    const identity = `docker:${name || composeService || container.Id || displayName}`;
    if (instanceId(kind, identity) !== wantedId) continue;
    const id = typeof container.Id === 'string' ? container.Id : '';
    if (!/^[a-f0-9]{6,64}$/iu.test(id)) return null;
    return { id, kind, name: displayName, rule: CONFIG_CREDENTIAL_FILES[kind] };
  }
  return null;
}
