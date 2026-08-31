// Portainer v2 templates fetched through the public-only transport.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from './config.js';
import { registryRequest } from './registry.js';
import { getTemplateSources } from './store.js';

const MAX_ENTRIES = 200;
const MAX_DOC_BYTES = 1024 * 1024;
const MAX_STACKFILE_BYTES = 128 * 1024;
const MAX_STACKFILE_FETCHES = 30;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PORT_LINE_RE = /^\d{1,5}:\d{1,5}(\/(tcp|udp))?$/;

const str = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : '');
// Reduce text to one YAML-safe line.
const clean = (v) => String(v || '').replace(/[\s"'#]+/g, ' ').trim();

function httpsProjectUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  if (url.hostname === 'github.com') url.pathname = url.pathname.replace(/\.git\/?$/, '');
  return url.href.replace(/\/$/, '');
}

// Prefer explicit project metadata and fall back to a stack's repository.
export function templateProjectUrl(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const candidates = [
    entry.projectUrl,
    entry.project_url,
    entry.homepage,
    entry.maintainer,
    entry.repository && entry.repository.url,
  ];
  for (const candidate of candidates) {
    const url = httpsProjectUrl(candidate);
    if (url) return url;
  }
  return null;
}

// Normalize bounded Portainer v2 container and Compose templates.
export function parsePortainerTemplates(text) {
  let doc;
  try {
    doc = JSON.parse(String(text || ''));
  } catch {
    return { ok: false, error: 'that is not JSON', entries: [] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'that is not a template document', entries: [] };
  if (String(doc.version) !== '2') return { ok: false, error: 'only Portainer v2 template files are supported', entries: [] };
  if (!Array.isArray(doc.templates)) return { ok: false, error: 'the document has no templates array', entries: [] };
  const entries = [];
  for (const t of doc.templates.slice(0, 1000)) {
    if (entries.length >= MAX_ENTRIES) break;
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    const type = Number(t.type);
    if (type !== 1 && type !== 3) continue;
    const title = str(t.title, 80).trim();
    if (!title) continue;
    const entry = {
      type,
      title,
      name: str(t.name, 60).trim(),
      description: str(t.description, 300).trim(),
      categories: (Array.isArray(t.categories) ? t.categories : []).slice(0, 5).map((c) => str(c, 40).trim()).filter(Boolean),
    };
    if (type === 1) {
      entry.image = str(t.image, 300).trim();
      if (!entry.image) continue;
      entry.ports = (Array.isArray(t.ports) ? t.ports : []).slice(0, 20).map((p) => str(p, 40).trim()).filter(Boolean);
      entry.volumes = (Array.isArray(t.volumes) ? t.volumes : []).slice(0, 20)
        .map((v) => (v && typeof v === 'object' && str(v.container, 300)
          ? { container: str(v.container, 300), bind: str(v.bind, 300), readonly: v.readonly === true }
          : null))
        .filter(Boolean);
      entry.env = (Array.isArray(t.env) ? t.env : []).slice(0, 40)
        .map((e) => (e && typeof e === 'object' && ENV_NAME_RE.test(str(e.name, 60))
          ? { name: str(e.name, 60), default: str(e.default, 300) }
          : null))
        .filter(Boolean);
      entry.restartPolicy = str(t.restart_policy, 20).trim();
    } else {
      const repo = t.repository && typeof t.repository === 'object' ? t.repository : {};
      entry.repository = { url: str(repo.url, 300).trim(), stackfile: str(repo.stackfile, 300).trim() };
    }
    const projectUrl = templateProjectUrl({
      projectUrl: str(t.projectUrl, 500),
      project_url: str(t.project_url, 500),
      homepage: str(t.homepage, 500),
      maintainer: str(t.maintainer, 500),
      repository: entry.repository,
    });
    if (projectUrl) entry.projectUrl = projectUrl;
    entries.push(entry);
  }
  return { ok: true, error: null, entries };
}

// Derive raw Compose URLs only from GitHub repository links and stack-file paths.
export function stackfileUrl(repository) {
  if (!repository || typeof repository !== 'object') return null;
  const file = String(repository.stackfile || '');
  if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  let repo;
  try {
    repo = new URL(String(repository.url || ''));
  } catch {
    return null;
  }
  if (repo.protocol !== 'https:' || repo.hostname !== 'github.com' || repo.username || repo.password) return null;
  const parts = repo.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part))) return null;
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/HEAD/${path}`;
}

// Convert type-1 templates to bounded single-service previews.
export function templateCompose(entry) {
  if (!entry || entry.type !== 1 || !entry.image) return null;
  const svcRaw = String(entry.name || entry.title || 'app').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const svc = /^[a-z0-9]/.test(svcRaw) ? svcRaw.slice(0, 40) : `app-${svcRaw}`.slice(0, 40) || 'app';
  const lines = [
    '# Imported from a Portainer template.',
    '# Only image, ports, volumes, environment, and restart policy are included. Review before deployment.',
    'services:',
    `  ${svc}:`,
    `    image: ${clean(entry.image)}`,
  ];
  if (/^(no|always|unless-stopped|on-failure)$/.test(entry.restartPolicy || '')) lines.push(`    restart: ${entry.restartPolicy}`);
  const ports = (entry.ports || []).map(clean).filter((p) => PORT_LINE_RE.test(p));
  if (ports.length) {
    lines.push('    ports:');
    for (const p of ports) lines.push(`      - "${p}"`);
  }
  const named = [];
  const binds = [];
  for (const v of entry.volumes || []) {
    const target = clean(v.container);
    if (!target.startsWith('/')) continue;
    const ro = v.readonly ? ':ro' : '';
    const bind = clean(v.bind);
    if (bind.startsWith('/')) {
      binds.push(`${bind}:${target}${ro}`);
    } else {
      const leaf = target.split('/').filter(Boolean).pop() || 'data';
      const base = `${svc}-${leaf.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}`.slice(0, 58);
      let name = base;
      for (let i = 2; named.includes(name); i += 1) name = `${base}-${i}`;
      named.push(name);
      binds.push(`${name}:${target}${ro}`);
    }
  }
  if (binds.length) {
    lines.push('    volumes:');
    for (const b of binds) lines.push(`      - ${b}`);
  }
  const envs = (entry.env || []).filter((e) => ENV_NAME_RE.test(e.name));
  if (envs.length) {
    lines.push('    environment:');
    for (const e of envs) {
      lines.push(e.default ? `      ${e.name}: "${clean(e.default)}"` : `      ${e.name}: \${${e.name}}`);
    }
  }
  if (named.length) {
    lines.push('volumes:');
    for (const n of named) lines.push(`  ${n}:`);
  }
  return `${lines.join('\n')}\n`;
}

// Fetch the template document and derivable Compose files through the same pinned transport.
export async function fetchTemplateSource(url, options = {}) {
  const wire = { timeoutMs: 10_000, request: options.request, lookup: options.lookup };
  const res = await registryRequest('GET', url, { accept: 'application/json' }, { ...wire, maxBodyBytes: MAX_DOC_BYTES });
  if (!res) return { ok: false, error: 'could not fetch it - private addresses, redirects and plain http are refused', entries: [] };
  if (res.status !== 200) return { ok: false, error: `the server answered ${res.status}`, entries: [] };
  const parsed = parsePortainerTemplates(res.body);
  if (!parsed.ok) return { ok: false, error: parsed.error, entries: [] };
  let fetches = 0;
  for (const entry of parsed.entries) {
    if (entry.type !== 3 || fetches >= MAX_STACKFILE_FETCHES) continue;
    const raw = stackfileUrl(entry.repository);
    if (!raw) continue;
    fetches += 1;
    const file = await registryRequest('GET', raw, {}, { ...wire, maxBodyBytes: MAX_STACKFILE_BYTES });
    if (file && file.status === 200 && file.body.length > 0 && file.body.length <= 20000) entry.yaml = file.body;
  }
  return { ok: true, error: null, entries: parsed.entries };
}

// Hash source URLs into cache filenames.
function cachePath(url) {
  return join(config.dataDir, `templates-${createHash('sha256').update(String(url)).digest('hex').slice(0, 16)}.json`);
}

export function writeTemplateCache(url, record) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(cachePath(url), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function readTemplateCache(url) {
  let raw;
  try {
    raw = readFileSync(cachePath(url), 'utf8');
  } catch {
    return null;
  }
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || !Number.isFinite(record.fetchedAt)) return null;
    return { fetchedAt: record.fetchedAt, error: typeof record.error === 'string' ? record.error : null, entries: Array.isArray(record.entries) ? record.entries : [] };
  } catch {
    return null;
  }
}

export function dropTemplateCache(url) {
  try {
    unlinkSync(cachePath(url));
  } catch {
    /* The cache file is already absent. */
  }
}

// Join stored sources with cached entries without network access.
export function templateSourcesView() {
  return getTemplateSources().map((row) => {
    const cache = readTemplateCache(row.url);
    return {
      ...row,
      fetchedAt: cache ? cache.fetchedAt : null,
      fetchError: cache ? cache.error : null,
      entries: cache ? cache.entries : [],
    };
  });
}
