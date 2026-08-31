// Compose linter with stable rule IDs, line-aware findings, and deploy-parser parity.

import { dangerousHostBind, parseCompose, reservedProtectionClaim, reservedProtectionClaims, substituteEnv, stripComment, unquote } from './compose.js';

const MAX_FINDINGS = 200;
// Match the same port forms as the parser and deploy path, including an optional host address.
const PORT_RE = /^(?:((?:\d{1,3}\.){3}\d{1,3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/;
const NAMED_VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;
const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD/i;

// Match substituteEnv's empty-or-missing default rule.
function hasEnvValue(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined && env[key] !== null && env[key] !== '';
}

// Tolerantly mirror parseCompose to collect line-aware fields; QM012 covers parser refusals.
function scanCompose(lines) {
  const services = [];
  const declaredVolumes = new Map();
  const rows = [];
  let section = '';
  let svc = null;
  let sub = '';
  for (let n = 0; n < lines.length; n += 1) {
    const line = stripComment(lines[n]);
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const body = line.trim();
    if (indent === 0) {
      const m = /^([\w-]+):/.exec(body);
      section = m ? m[1] : '';
      svc = null;
      sub = '';
    } else if (indent === 2 && section === 'volumes') {
      const m = /^([\w.-]+):/.exec(body);
      if (m && !declaredVolumes.has(m[1])) declaredVolumes.set(m[1], n + 1);
      svc = null;
      sub = '';
    } else if (indent === 2 && section === 'services') {
      const m = /^([\w.-]+):\s*$/.exec(body);
      svc = null;
      sub = '';
      if (m) {
        svc = { name: m[1], line: n + 1, image: '', imageLine: 0, restart: '', containerName: '', containerNameLine: 0, ports: [], volumes: [], envs: [], labels: [] };
        services.push(svc);
      }
    } else if (svc && section === 'services' && indent === 4) {
      const m = /^([\w-]+):\s*(.*)$/.exec(body);
      sub = '';
      if (m) {
        const k = m[1];
        const v = m[2];
        if (k === 'image') { svc.image = unquote(v); svc.imageLine = n + 1; }
        else if (k === 'restart') svc.restart = unquote(v);
        else if (k === 'container_name') { svc.containerName = unquote(v); svc.containerNameLine = n + 1; }
        else if ((k === 'ports' || k === 'volumes' || k === 'environment' || k === 'labels') && !v) sub = k;
      }
    } else if (svc && section === 'services' && indent === 6 && sub) {
      if (body.startsWith('- ')) {
        const item = unquote(body.slice(1).trim());
        if (!item) continue;
        if (sub === 'ports') svc.ports.push({ value: item, line: n + 1 });
        else if (sub === 'volumes') svc.volumes.push({ value: item, line: n + 1 });
        else if (sub === 'environment') {
          const eq = item.indexOf('=');
          if (eq > 0) svc.envs.push({ key: unquote(item.slice(0, eq)), value: unquote(item.slice(eq + 1)), line: n + 1 });
        } else if (sub === 'labels') {
          const eq = item.indexOf('=');
          const key = unquote(eq === -1 ? item : item.slice(0, eq));
          if (key) svc.labels.push({ key, value: eq === -1 ? '' : unquote(item.slice(eq + 1)), line: n + 1 });
        }
      } else if (sub === 'environment' || sub === 'labels') {
        const m = /^("[^"]+"|'[^']+'|[^\s:]+):\s*(.*)$/.exec(body);
        if (m) {
          const entry = { key: unquote(m[1]), value: unquote(m[2]), line: n + 1 };
          if (sub === 'environment') svc.envs.push(entry);
          else svc.labels.push(entry);
        }
      }
    }
    rows.push({ line: n + 1, body, svc: svc ? svc.name : '' });
  }
  return { services, declaredVolumes, rows };
}

// Detect long hex or mixed-alphanumeric base64-shaped credential literals.
function secretShaped(value) {
  if (/^[A-Fa-f0-9]{32,}$/.test(value)) return true;
  return /^[A-Za-z0-9+/=_-]{32,}$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value) && !value.startsWith('/');
}

export function lintCompose(text, env, context) {
  const source = String(text || '');
  const vars = env && typeof env === 'object' && !Array.isArray(env) ? env : {};
  const ctx = context && typeof context === 'object' ? context : {};
  const liveContainers = Array.isArray(ctx.containers) ? ctx.containers : [];
  const livePorts = Array.isArray(ctx.publishedHostPorts) ? ctx.publishedHostPorts : [];
  const findings = [];
  const add = (id, severity, line, message, service) => {
    if (findings.length >= MAX_FINDINGS) return;
    const f = { id, severity, line: line || 1, message };
    if (service) f.service = service;
    findings.push(f);
  };
  // Per-value substitution preserves line numbers when a supplied value contains a newline.
  const resolve = (v) => substituteEnv(v, vars).replace(/[\r\n]+/g, ' ');

  const lines = source.split(/\r?\n/);
  const { services, declaredVolumes, rows } = scanCompose(lines);

  // QM006 reports unsupported fields on their source lines.
  for (const row of rows) {
    const banned = /^(privileged|cap_add|pid|devices)\s*:/.exec(row.body);
    if (banned) add('QM006', 'error', row.line, `${banned[1]}: is not deployable through Companion`, row.svc);
    const netMode = /^network_mode\s*:\s*(.+)$/.exec(row.body);
    if (netMode && unquote(netMode[1]) === 'host') add('QM006', 'error', row.line, 'network_mode: host is not deployable through Companion', row.svc);
  }

  // QM011 reports unresolved substitutions; secret-shaped names are errors.
  const flaggedVars = new Set();
  for (const row of rows) {
    for (const m of row.body.matchAll(VAR_RE)) {
      if (m[2] !== undefined || hasEnvValue(vars, m[1]) || flaggedVars.has(m[1])) continue;
      const name = m[1];
      flaggedVars.add(name);
      if (SECRET_NAME_RE.test(name)) {
        add('QM011', 'error', row.line, `\${${name}} has no value, so this would deploy with the secret empty. Type it under Values on the deploy panel; a literal here would store it in the file in plain text.`, row.svc);
      } else {
        add('QM011', 'warn', row.line, `\${${name}} has no default and nothing supplies it, so it substitutes to an empty string. Type it under Values on the deploy panel, or give the file a default: \${${name}:-value}.`, row.svc);
      }
    }
  }

  const filePorts = new Map(); // "port/proto" -> { svc, line }
  const fileNames = new Map(); // container_name -> { svc, line }
  for (const svc of services) {
    // QM001: floating image tag.
    const image = resolve(svc.image);
    if (image && !image.includes('@')) {
      const colon = image.lastIndexOf(':');
      const tag = colon > image.lastIndexOf('/') ? image.slice(colon + 1) : '';
      if (!tag || tag === 'latest') add('QM001', 'warn', svc.imageLine || svc.line, `"${image}" uses an unpinned image tag; pin a version for repeatable deployments`, svc.name);
    }

    // QM002: missing restart policy.
    if (!resolve(svc.restart)) add('QM002', 'info', svc.line, 'no restart policy - this container stays down after a daemon restart or reboot', svc.name);

    // QM003: host-port conflict.
    for (const p of svc.ports) {
      const m = PORT_RE.exec(resolve(p.value));
      if (!m) continue;
      const hostIp = m[1];
      const port = Number(m[2]);
      const proto = m[4] || 'tcp';
      const liveOwner = livePorts.find((row) => row && Number(row.port) === port);
      if (liveOwner) add('QM003', 'error', p.line, `host port ${port} is already published by container "${liveOwner.owner}"`, svc.name);
      // Include the host address when identifying in-file port conflicts.
      const key = `${hostIp ?? '*'}:${port}/${proto}`;
      const first = filePorts.get(key);
      if (first) add('QM003', 'error', p.line, `host port ${port}${hostIp ? ` on ${hostIp}` : ''} is also published by "${first.svc}" in this file`, svc.name);
      else filePorts.set(key, { svc: svc.name, line: p.line });
    }

    for (const v of svc.volumes) {
      const bind = resolve(v.value);
      const parts = bind.split(':');
      const src = parts[0] || '';
      const ro = parts[2] === 'ro';
      const unsafe = dangerousHostBind(src);
      if (unsafe && unsafe.kind === 'socket') {
        add('QM005', 'error', v.line, ro
          ? `${unsafe.reason} (ro) - ro does not restrict the api; this will not deploy`
          : `${unsafe.reason}; this will not deploy`, svc.name);
      } else if (unsafe) {
        // Distinguish forbidden paths from valid paths outside the configured allow-list.
        add('QM004', 'error', v.line, unsafe.kind === 'unlisted'
          ? `${unsafe.reason} - use a named volume, or have the server operator add its root to DOCKER_DEPLOY_BIND_ROOTS; this will not deploy`
          : `${unsafe.reason} - mount the narrowest application path that works; this will not deploy`, svc.name);
      } else if (NAMED_VOLUME_RE.test(src) && !declaredVolumes.has(src)) {
        // QM008: rejected host bind.
        add('QM008', 'error', v.line, `named volume "${src}" is not declared under a top-level volumes: block`, svc.name);
      }
    }

    // QM013 reserves control-plane labels and identities.
    const labelMap = Object.create(null);
    for (const label of svc.labels) labelMap[resolve(label.key)] = resolve(label.value);
    const reserved = reservedProtectionClaim(svc.name, { container_name: resolve(svc.containerName), labels: labelMap });
    if (reserved) {
      const line = reserved.field === 'container_name'
        ? svc.containerNameLine
        : reserved.field === 'label'
          ? (svc.labels.find((label) => resolve(label.key) === reserved.key) || {}).line
          : svc.line;
      add('QM013', 'error', line || svc.line, `${reserved.reason}; this will not deploy`, svc.name);
    }

    // QM007: credential-shaped literal; report only the variable name.
    for (const e of svc.envs) {
      const value = String(e.value).trim();
      if (!value || value.includes('${')) continue;
      if (value.startsWith('/') || /^(true|false|\d+)$/i.test(value)) continue;
      if (SECRET_NAME_RE.test(e.key) || secretShaped(value)) {
        add('QM007', 'warn', e.line, `environment variable "${e.key}" holds a literal that looks like a secret. Replace the value with \${${e.key}} and type the secret under Values on the deploy panel, so it never sits in the file.`, svc.name);
      }
    }

    // QM009/QM010: duplicate Docker object names.
    const cname = resolve(svc.containerName);
    if (cname) {
      const first = fileNames.get(cname);
      if (first) add('QM010', 'error', svc.containerNameLine, `container_name "${cname}" is already used by "${first.svc}" in this file`, svc.name);
      else fileNames.set(cname, { svc: svc.name, line: svc.containerNameLine });
      if (liveContainers.some((c) => c && c.name === cname)) {
        add('QM009', 'error', svc.containerNameLine, `container_name "${cname}" is already taken by a container outside this stack`, svc.name);
      }
    }
  }

  // QM012 mirrors authoritative parser refusals not already covered by a specific rule.
  const parsed = parseCompose(substituteEnv(source, vars));
  if (!parsed.ok) {
    const msg = String(parsed.error || 'the parser refused this file');
    const undeclared = /undeclared named volume/.test(msg);
    if (!undeclared || !findings.some((f) => f.id === 'QM008')) {
      const lm = /^line (\d+): (.*)$/.exec(msg);
      let line = lm ? Number(lm[1]) : 1;
      if (!lm) {
        const sm = /service "([^"]+)"/.exec(msg);
        const at = sm && services.find((s) => s.name === sm[1]);
        if (at) line = at.line;
      }
      add(undeclared ? 'QM008' : 'QM012', 'error', line, lm ? lm[2] : msg);
    }
  } else {
    // Recheck parsed identities after substitution for claims the tolerant walk cannot see.
    for (const claim of reservedProtectionClaims(parsed)) {
      if (findings.some((f) => f.id === 'QM013' && f.service === claim.service)) continue;
      const at = services.find((svc) => svc.name === claim.service);
      add('QM013', 'error', at ? at.line : 1, `${claim.reason}; this will not deploy`, claim.service);
    }
  }

  findings.sort((a, b) => a.line - b.line || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return findings;
}
