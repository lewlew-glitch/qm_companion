// Supported Marketplace Compose subset. Unsupported content is recorded in `ignored` and blocks deployment.

import { pullImage, createNetwork, createContainer, containerAction, listNetworks, CNAME_RE } from './docker.js';
import { PROTECT_LABEL, PROTECTED_CONTAINER_NAMES, PROTECTED_SERVICE_NAMES } from './protect.js';

const SCALARS = new Set(['image', 'container_name', 'restart', 'user']);
const LISTS = new Set(['ports', 'volumes']);
const MAPS = new Set(['environment', 'labels']); // both also accept the "- K=V" list form
const BAD_KEY = /^(__proto__|constructor|prototype)$/;

// Shared parser input normalization for the linter.
export function unquote(v) {
  const s = String(v).trim();
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) return s.slice(1, -1);
  return s;
}

// Remove full-line and trailing comments while preserving hashes inside quotes.
export function stripComment(line) {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i);
  }
  return line;
}

export function parseCompose(text) {
  const bad = (n, msg) => ({ ok: false, services: null, volumes: [], ignored: [], error: `line ${n + 1}: ${msg}` });
  const services = Object.create(null);
  const volumes = new Set();
    // Record every unsupported key except the non-operative top-level version.
  const ignored = new Set();
  const lines = String(text || '').split(/\r?\n/);
  let section = ''; // current top-level key
  let svc = ''; // current service name
  let sub = ''; // current service key collecting children (ports, environment, ...)
  let skipFrom = -1; // skipping an unknown block: ignore anything deeper than this indent

  for (let n = 0; n < lines.length; n++) {
    const line = stripComment(lines[n]);
    if (!line.trim()) continue;
    if (/^ *\t/.test(lines[n])) return bad(n, 'tabs are not supported - indent with 2 spaces');
    const indent = line.match(/^ */)[0].length;
    const body = line.trim();

    if (skipFrom >= 0 && indent > skipFrom) continue;
    skipFrom = -1;

    if (indent === 0) {
      if (!/^[\w-]+:/.test(body)) return bad(n, 'expected a top-level "key:" here');
      section = body.split(':')[0];
      svc = '';
      sub = '';
      if (section !== 'services' && section !== 'volumes') {
        skipFrom = 0;
        if (section !== 'version') ignored.add(section);
      }
      continue;
    }
    if (indent % 2) return bad(n, 'odd indentation - use 2 spaces per level');
    if (indent === 2) {
      if (section === 'volumes') {
        const m = body.match(/^([\w.-]+):\s*(?:\{\s*\})?\s*$/);
        if (!m) return bad(n, 'named volumes must use an empty declaration like "  app-data:"');
        if (BAD_KEY.test(m[1])) return bad(n, 'that volume name is not allowed');
        volumes.add(m[1]);
        svc = '';
        sub = '';
        continue;
      }
      if (section !== 'services') continue;
      const m = body.match(/^([\w.-]+):\s*$/);
      if (!m) return bad(n, 'expected a service name like "  radarr:"');
      if (BAD_KEY.test(m[1])) return bad(n, 'that service name is not allowed');
      svc = m[1];
      services[svc] = {
        image: '', container_name: '', restart: '', user: '', command: '',
        ports: [], volumes: [], networks: [],
        environment: Object.create(null), labels: Object.create(null),
      };
      sub = '';
      continue;
    }
    if (section === 'volumes') {
      skipFrom = indent;
      ignored.add('volume options');
      continue;
    }
    if (!svc) return bad(n, 'indented content before any service');
    if (indent === 4) {
      const m = body.match(/^([\w-]+):\s*(.*)$/);
      if (!m) return bad(n, `expected a "key: value" under ${svc}`);
      const k = m[1];
      sub = '';
      if (SCALARS.has(k)) {
        if (m[2]) services[svc][k] = unquote(m[2]);
        continue;
      }
      if (LISTS.has(k) || MAPS.has(k)) {
        if (m[2]) {
          ignored.add(`${k} inline syntax`);
          continue;
        }
        sub = k;
        continue;
      }
      skipFrom = 4; // Skip unknown keys and their nested values.
      ignored.add(k);
      continue;
    }
    // Parse list items and map entries nested under the current key.
    if (!sub) {
      ignored.add('nested syntax');
      skipFrom = indent - 2;
      continue;
    }
    if (indent !== 6) {
      ignored.add(`${sub} nested syntax`);
      skipFrom = indent - 2;
      continue;
    }
    if (body.startsWith('- ') || body === '-') {
      const item = unquote(body.slice(1).trim());
      if (!item) continue;
      if (MAPS.has(sub)) {
        const eq = item.indexOf('=');
        if (sub === 'environment' && eq === -1) {
          ignored.add('environment host lookup');
          continue;
        }
        const k = unquote(eq === -1 ? item : item.slice(0, eq));
        if (BAD_KEY.test(k)) return bad(n, `"${k}" is not an allowed key`);
        services[svc][sub][k] = eq === -1 ? '' : unquote(item.slice(eq + 1));
      } else {
        services[svc][sub].push(item);
      }
      continue;
    }
    const m = body.match(/^("[^"]+"|'[^']+'|[^\s:]+):\s*(.*)$/);
    if (!m) return bad(n, `expected "- item" or "KEY: value" under ${sub}`);
    if (!MAPS.has(sub)) return bad(n, `${sub} takes a list of "- item" lines`);
    const k = unquote(m[1]);
    if (BAD_KEY.test(k)) return bad(n, `"${k}" is not an allowed key`);
    services[svc][sub][k] = unquote(m[2]);
  }

  const names = Object.keys(services);
  if (!names.length) return { ok: false, services: null, volumes: [], ignored: [], error: 'no services found - the file needs a top-level services: block' };
  for (const s of names) {
    if (!services[s].image) return { ok: false, services: null, volumes: [], ignored: [], error: `service "${s}" has no image` };
    if (services[s].restart && !/^(no|always|unless-stopped|on-failure)$/.test(services[s].restart)) {
      return { ok: false, services: null, volumes: [], ignored: [], error: `service "${s}" has an unsupported restart policy` };
    }
    for (const port of services[s].ports) {
      // An optional host address selects the published interface.
      const match = /^(?:((?:\d{1,3}\.){3}\d{1,3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/.exec(port);
      const inRange = (v) => Number(v) >= 1 && Number(v) <= 65535;
      // Apply the deploy path's IPv4 validation at parse time.
      const octetsOk = !match?.[1] || isIpv4(match[1]);
      if (!match || !inRange(match[2]) || !inRange(match[3]) || !octetsOk) {
        return { ok: false, services: null, volumes: [], ignored: [], error: `service "${s}" has an unsupported port mapping "${port}"` };
      }
    }
    for (const bind of services[s].volumes) {
      const parts = String(bind).split(':');
      const source = parts[0];
      const target = parts[1];
      const mode = parts[2] || '';
      const named = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source);
      const absolute = source.startsWith('/');
      if ((parts.length !== 2 && parts.length !== 3) || (!named && !absolute) || !target || !target.startsWith('/') || (mode && mode !== 'ro' && mode !== 'rw')) {
        return { ok: false, services: null, volumes: [], ignored: [], error: `service "${s}" has an unsupported volume mapping "${bind}"` };
      }
      if (named && !volumes.has(source)) {
        return { ok: false, services: null, volumes: [], ignored: [], error: `service "${s}" uses undeclared named volume "${source}"` };
      }
    }
  }
  return { ok: true, services, volumes: [...volumes], ignored: [...ignored], error: null };
}

// Build partial Compose text from observable container fields.
export async function composeSkeleton(stack, inspect) {
  const clean = (v) => String(v || '').replace(/[\s"']+/g, ' ').trim();
  const lines = [
    '# generated by Companion from the running containers.',
    '# environment and mounts are not recoverable this way - add them by hand before deploying.',
    'services:',
  ];
  for (const svc of (stack.services || []).slice(0, 40)) {
    const info = inspect ? await inspect(svc.id) : null;
    const labels = (info && info.Config && info.Config.Labels) || {};
    const rawKey = labels['com.docker.compose.service'] || svc.name;
    const key = /^[\w.-]{1,63}$/.test(rawKey) ? rawKey : String(svc.name).replace(/[^\w.-]/g, '-').slice(0, 63);
    const restart = info && info.HostConfig && info.HostConfig.RestartPolicy && info.HostConfig.RestartPolicy.Name;
    lines.push(`  ${key}:`);
    lines.push(`    image: ${clean(svc.image)}`);
    lines.push(`    container_name: ${clean(svc.name)}`);
    if (restart && restart !== 'no' && /^[a-z-]+$/.test(restart)) lines.push(`    restart: ${restart}`);
    const ports = (svc.ports || []).filter((p) => /^[\d:./a-z-]+$/i.test(p));
    if (ports.length) {
      lines.push('    ports:');
      for (const p of ports) lines.push(`      - "${p}"`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// Expand ${key} and shell-style ${key:-default} expressions.
export function substituteEnv(text, env) {
  const vars = env && typeof env === 'object' ? env : {};
  return String(text || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (whole, key, hasDef, def) => {
    const has = Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null && vars[key] !== '';
    return has ? String(vars[key]) : (hasDef ? def : '');
  });
}

function projectVolumeBind(project, bind, declaredVolumes) {
  const parts = String(bind).split(':');
  if (parts.length < 2 || !declaredVolumes.has(parts[0])) return bind;
  parts[0] = `${project}_${parts[0]}`;
  return parts.join(':');
}

// Normalize Linux host paths lexically before applying bind boundaries.
function normalHostPath(source) {
  const raw = String(source || '');
  if (!raw.startsWith('/')) return '';
  const parts = [];
  for (const bit of raw.split('/')) {
    if (!bit || bit === '.') continue;
    if (bit === '..') parts.pop();
    else parts.push(bit);
  }
  return `/${parts.join('/')}`;
}

function atOrBelow(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

const SENSITIVE_HOST_ROOTS = Object.freeze([
  // Reject kernel and device trees as application bind roots.
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/root/.ssh',
  '/var/lib/containerd',
  '/var/lib/docker',
  '/var/run',
  '/run/containerd',
  '/run/docker',
]);

const SENSITIVE_HOST_FILES = new Set([
  '/etc/shadow',
]);

// Allow conventional application-data roots but reject broad roots.
const DECLARABLE_TOP_LEVEL_ROOTS = new Set([
  '/srv', '/opt', '/mnt', '/media', '/data', '/export', '/share', '/tank', '/pool', '/storage',
]);
const VOLUME_ROOT_RE = /^\/volume\d+$/;

// DOCKER_DEPLOY_BIND_ROOTS allows host binds; an empty value permits named volumes only.
// Bind validation is lexical; symlinks under an allowed root can escape it.

/** Rejected DOCKER_DEPLOY_BIND_ROOTS entries and reasons. */
export const REJECTED_BIND_ROOTS = [];

/** Parse comma- or colon-separated bind roots and record rejections. */
function parseBindRoots(raw) {
  const roots = [];
  for (const piece of String(raw || '').split(/[:,]/)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const path = normalHostPath(trimmed);
    if (!path) {
      REJECTED_BIND_ROOTS.push(`${trimmed}: not an absolute path`);
      continue;
    }
    const refused = alwaysRefusedBind(path, { asRoot: true });
    if (refused) {
      REJECTED_BIND_ROOTS.push(`${trimmed}: ${refused.reason}`);
      continue;
    }
    roots.push(path);
  }
  return Object.freeze(roots);
}

/** Validate a bind path or an allow-list root; broad data roots are valid only as declarations. */
function alwaysRefusedBind(path, { asRoot = false } = {}) {
  if (/(?:^|\/)(?:docker|containerd)\.sock$/iu.test(path)) {
    return { kind: 'socket', path, reason: `mounts the host runtime socket (${path}), which grants control of the host` };
  }
  if (path === '/') {
    return { kind: 'host', path, reason: asRoot ? 'is the whole host filesystem' : 'binds the whole host filesystem into the container' };
  }
  if (path.split('/').filter(Boolean).length < 2) {
    if (!asRoot) return { kind: 'host', path, reason: `binds "${path}" into the container` };
    if (!DECLARABLE_TOP_LEVEL_ROOTS.has(path) && !VOLUME_ROOT_RE.test(path)) {
      return { kind: 'host', path, reason: `is a system tree, not an application-data root (declarable top-level roots are ${[...DECLARABLE_TOP_LEVEL_ROOTS].join(', ')} and /volumeN)` };
    }
  }
  if (SENSITIVE_HOST_FILES.has(path) || SENSITIVE_HOST_ROOTS.some((root) => atOrBelow(path, root))) {
    return { kind: 'host', path, reason: `binds the sensitive host path "${path}" into the container` };
  }
  return null;
}

export const DEPLOY_BIND_ROOTS = parseBindRoots(process.env.DOCKER_DEPLOY_BIND_ROOTS);
if (REJECTED_BIND_ROOTS.length) {
  process.stdout.write(`  deploy: ignoring DOCKER_DEPLOY_BIND_ROOTS entries - ${REJECTED_BIND_ROOTS.join('; ')}\n`);
}

/** Return accepted configured bind roots. */
export const parseDeployBindRoots = parseBindRoots;

/** Shared bind verdict for lint and deployment. */
export function dangerousHostBind(source, roots = DEPLOY_BIND_ROOTS) {
  const path = normalHostPath(source);
  if (!path) return null;
  const refused = alwaysRefusedBind(path);
  if (refused) return refused;
  if (roots.some((root) => atOrBelow(path, root))) return null;
  return {
    kind: 'unlisted',
    path,
    reason: roots.length
      ? `binds the host path "${path}", which is not under any root this server allows (${roots.join(', ')})`
      : `binds the host path "${path}", and this server allows no host paths at all (named volumes only)`,
  };
}

// Reject host-control, daemon-data, and credential binds.
export function dangerousBinds(parsed, roots = DEPLOY_BIND_ROOTS) {
  const out = [];
  const services = (parsed && parsed.services) || {};
  for (const svcName of Object.keys(services)) {
    for (const bind of services[svcName].volumes || []) {
      const src = String(bind).split(':')[0] || '';
      // Named volumes do not use the host-path allow-list.
      if (!src.startsWith('/')) continue;
      const verdict = dangerousHostBind(src, roots);
      if (verdict) out.push({ service: svcName, bind, kind: verdict.kind, reason: `${svcName} ${verdict.reason}` });
    }
  }
  return out;
}

const RESERVED_SERVICE_SET = new Set(PROTECTED_SERVICE_NAMES.map((name) => name.toLowerCase()));
const RESERVED_CONTAINER_SET = new Set(PROTECTED_CONTAINER_NAMES.map((name) => name.toLowerCase()));

// Reserve control-plane labels and identities from in-app Compose deployments.
export function reservedProtectionClaim(serviceName, spec = {}) {
  const service = String(serviceName || '');
  if (RESERVED_SERVICE_SET.has(service.toLowerCase())) {
    return { field: 'service', reason: `service name "${service}" is reserved for the Companion control plane` };
  }
  const containerName = String(spec.container_name || '');
  if (RESERVED_CONTAINER_SET.has(containerName.toLowerCase())) {
    return { field: 'container_name', reason: `container name "${containerName}" is reserved for the Companion control plane` };
  }
  const labels = spec.labels && typeof spec.labels === 'object' ? spec.labels : {};
  if (Object.hasOwn(labels, PROTECT_LABEL)) {
    return { field: 'label', key: PROTECT_LABEL, reason: `label "${PROTECT_LABEL}" is reserved for the Companion control plane` };
  }
  return null;
}

export function reservedProtectionClaims(parsed) {
  const services = (parsed && parsed.services) || {};
  const out = [];
  for (const [service, spec] of Object.entries(services)) {
    const claim = reservedProtectionClaim(service, spec);
    if (claim) out.push({ service, ...claim });
  }
  return out;
}

/**
 * A real dotted quad: four octets in range with no leading zeros.
 */
const IPV4_RE = /^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/;

/** True only for a well-formed IPv4 literal. */
export function isIpv4(value) {
  if (typeof value !== 'string' || !IPV4_RE.test(value)) return false;
  return value.split('.').every((octet) => Number(octet) <= 255);
}

/** Choose HostIp from deployment config, QM_HOST, or loopback. */
export function deployBindAddress() {
  // Invalid configured addresses fall back to loopback and are reported.
  const explicit = String(process.env.DOCKER_DEPLOY_BIND_ADDRESS || '').trim();
  if (explicit) {
    if (isIpv4(explicit)) return explicit;
    process.stdout.write(`  deploy: ignoring DOCKER_DEPLOY_BIND_ADDRESS "${explicit}" - not an IPv4 address; publishing on 127.0.0.1\n`);
    return '127.0.0.1';
  }
  const host = String(process.env.QM_HOST || '').trim();
  return isIpv4(host) ? host : '127.0.0.1';
}

function buildCreateBody(project, svcName, spec, netName, declaredVolumes) {
  const labels = Object.assign(Object.create(null), spec.labels, {
    'com.docker.compose.project': project,
    'com.docker.compose.service': svcName,
  });
  const exposed = {};
  const bindings = {};
  for (const p of spec.ports) {
    const [addr, proto = 'tcp'] = p.split('/');
    const parts = addr.split(':');
    // "H:C" or "IP:H:C". Anything else was already refused by the parser.
    if (parts.length !== 2 && parts.length !== 3) continue;
    const [hostIp, hostPort, containerPort] = parts.length === 3
      ? parts
      : [deployBindAddress(), parts[0], parts[1]];
    const key = `${containerPort}/${proto}`;
    exposed[key] = {};
    // Docker publishes on every interface when HostIp is omitted.
    bindings[key] = [{ HostIp: hostIp, HostPort: String(hostPort) }];
  }
  const body = {
    Image: spec.image,
    Labels: labels,
    Env: Object.keys(spec.environment).map((k) => `${k}=${spec.environment[k]}`),
    HostConfig: {
      Binds: spec.volumes.map((bind) => projectVolumeBind(project, bind, declaredVolumes)),
      PortBindings: bindings,
      NetworkMode: netName,
    },
    NetworkingConfig: { EndpointsConfig: { [netName]: {} } },
  };
  if (Object.keys(exposed).length) body.ExposedPorts = exposed;
  if (spec.restart) body.HostConfig.RestartPolicy = { Name: spec.restart };
  if (spec.user) body.User = spec.user;
  if (spec.command) body.Cmd = /["']/.test(spec.command) ? ['/bin/sh', '-c', spec.command] : spec.command.split(/\s+/).filter(Boolean);
  return body;
}

// Substitute, validate, create networking, then pull and start services.
export async function deployStack(name, text, env, start, onStep) {
  const steps = [];
  const push = (s) => {
    steps.push(s);
    if (onStep) { try { onStep(s); } catch { /* ignore subscriber errors */ } }
  };
  const fail = (step, note) => {
    push({ step, ok: false, note });
    return { ok: false, partial: false, created: 0, steps };
  };
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name || '')) return fail('validate', 'stack names are letters, digits, dashes and underscores');
  const parsed = parseCompose(substituteEnv(text, env));
  if (!parsed.ok) return fail('parse', parsed.error);
  push({ step: 'parse', ok: true, note: `${Object.keys(parsed.services).length} service(s)` });
  // Unsupported security, device, or storage fields stop before Docker is touched.
  if (parsed.ignored.length) {
    return fail('unsupported', `${parsed.ignored.join(', ')} - direct deployment does not support these fields`);
  }
  // Enforce host-bind boundaries server-side before pull or create.
  const unsafe = dangerousBinds(parsed);
  if (unsafe.length) {
    return fail('unsafe', `${unsafe.map((u) => u.reason).join('; ')} - Companion does not deploy a host-control mount`);
  }
  const reserved = reservedProtectionClaims(parsed);
  if (reserved.length) {
    return fail('reserved', `${reserved.map((claim) => claim.reason).join('; ')} - user-deployed Compose cannot claim Companion's protection identity`);
  }

  const netName = `${name}_default`;
  const declaredVolumes = new Set(parsed.volumes);
  const nets = await listNetworks();
  if (Array.isArray(nets) && nets.some((x) => x.name === netName)) {
    push({ step: `network ${netName}`, ok: true, note: 'already there' });
  } else {
    const made = await createNetwork(netName);
    // Treat a concurrently created network as success.
    if (!made.ok && !/already exists/.test(made.note)) return fail(`network ${netName}`, made.note);
    push({ step: `network ${netName}`, ok: true, note: made.ok ? 'created' : 'already there' });
  }

  let created = 0;
  for (const svcName of Object.keys(parsed.services)) {
    const spec = parsed.services[svcName];
    const pulled = await pullImage(spec.image);
    push({ step: `pull ${spec.image}`, ok: pulled.ok, note: pulled.note });
    // Creation may still succeed from a locally cached image.

    const cname = spec.container_name || `${name}-${svcName}-1`;
    if (!CNAME_RE.test(cname)) {
      push({ step: `create ${cname}`, ok: false, note: 'that container name will not work' });
      continue;
    }
    const made = await createContainer(cname, buildCreateBody(name, svcName, spec, netName, declaredVolumes));
    push({ step: `create ${cname}`, ok: made.ok, note: made.note });
    if (!made.ok) continue;
    created += 1;

    if (start) {
      const up = await containerAction(made.id, 'start');
      push({ step: `start ${cname}`, ok: up, note: up ? '' : 'docker would not start it' });
    }
  }
  const ok = steps.every((s) => s.ok);
  return { ok, partial: !ok && created > 0, created, steps };
}
