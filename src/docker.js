// Docker client for local sockets and authenticated TCP proxies.

import http from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { matchImage } from './kinds.js';
import { isProtectedContainer } from './protect.js';

const SOCK = '/var/run/docker.sock';
// Prefer an authenticated socket proxy configured through DOCKER_HOST.
const HOST = process.env.DOCKER_HOST;
const DOCKER_REQUEST_TIMEOUT_MS = 30_000;
const DOCKER_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const DOCKER_STREAM_TIMEOUT_MS = 15 * 60 * 1000;
const DOCKER_STREAM_MAX_BYTES = 8 * 1024 * 1024;

export function dockerAvailable() {
  return !!HOST || existsSync(SOCK);
}

// Authenticate every TCP proxy request with the deployment key.
const PROXY_KEY = process.env.QM_PROXY_KEY;
/** The floor the proxy itself enforces (Dockerfile.socket-proxy: `length gt 31`). */
const PROXY_KEY_MIN = 32;

/** Return a configuration error when the proxy key is absent or too short. */
export function dockerProxyKeyProblem() {
  if (!HOST) return null;
  if (!PROXY_KEY) return 'missing';
  if (PROXY_KEY.trim().length < PROXY_KEY_MIN) return 'short';
  if (PROXY_KEY !== PROXY_KEY.trim() || /[\r\n,]/.test(PROXY_KEY)) return 'malformed';
  return null;
}

/** True when Companion is talking to a proxy and its key cannot work. */
export function dockerProxyKeyMissing() {
  return dockerProxyKeyProblem() !== null;
}

function opts(method, path) {
  if (HOST) {
    const u = new URL(HOST.replace(/^tcp:/, 'http:'));
    const o = { host: u.hostname, port: u.port || 2375, path, method };
    // Raw Unix sockets rely on filesystem permissions instead.
    if (PROXY_KEY) o.headers = { 'x-qm-proxy-key': PROXY_KEY };
    return o;
  }
  return { socketPath: SOCK, path, method };
}

function req(method, path, raw = false, maxBytes = DOCKER_RESPONSE_MAX_BYTES) {
  return new Promise((resolve) => {
    let settled = false;
    let r;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = () => ({ status: 0, json: null, buf: Buffer.alloc(0), headers: {} });
    const timer = setTimeout(() => {
      r?.destroy();
      finish(failed());
    }, DOCKER_REQUEST_TIMEOUT_MS);
    try {
      r = http.request(opts(method, path), (res) => {
      const chunks = [];
      let bytes = 0;
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        r.destroy();
        finish(failed());
        return;
      }
      res.on('data', (c) => {
        const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
        bytes += chunk.length;
        if (bytes > maxBytes) {
          res.destroy();
          r.destroy();
          finish(failed());
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return finish({ status: res.statusCode, buf, headers: res.headers });
        try {
          finish({ status: res.statusCode, json: JSON.parse(buf.toString('utf8')), headers: res.headers });
        } catch {
          finish({ status: res.statusCode, json: null, headers: res.headers });
        }
      });
      res.on('aborted', () => finish(failed()));
      res.on('error', () => finish(failed()));
      });
      r.on('error', () => finish(failed()));
      r.end();
    } catch {
      finish(failed());
    }
  });
}

// Detection uses the configured Docker transport, including DOCKER_HOST proxies.
export async function dockerGetJson(path) {
  if (!dockerAvailable() || typeof path !== 'string' || !path.startsWith('/') || path.includes('\r') || path.includes('\n')) {
    return null;
  }
  const { status, json } = await req('GET', path);
  return status >= 200 && status < 300 ? json : null;
}

// JSON request helper for Docker write endpoints.
function reqBody(method, path, body, raw = false) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    if (payload.length > 2 * 1024 * 1024) {
      resolve({ status: 0, json: null, buf: Buffer.alloc(0) });
      return;
    }
    const o = opts(method, path);
    // Preserve the proxy key added by opts().
    o.headers = { ...o.headers, 'content-type': 'application/json', 'content-length': payload.length };
    let settled = false;
    let r;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = () => ({ status: 0, json: null, buf: Buffer.alloc(0) });
    const timer = setTimeout(() => {
      r?.destroy();
      finish(failed());
    }, DOCKER_REQUEST_TIMEOUT_MS);
    try {
      r = http.request(o, (res) => {
      const chunks = [];
      let bytes = 0;
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > DOCKER_RESPONSE_MAX_BYTES) {
        res.destroy();
        r.destroy();
        finish(failed());
        return;
      }
      res.on('data', (c) => {
        const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
        bytes += chunk.length;
        if (bytes > DOCKER_RESPONSE_MAX_BYTES) {
          res.destroy();
          r.destroy();
          finish(failed());
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return finish({ status: res.statusCode, buf });
        try {
          finish({ status: res.statusCode, json: JSON.parse(buf.toString('utf8')) });
        } catch {
          finish({ status: res.statusCode, json: null });
        }
      });
      res.on('aborted', () => finish(failed()));
      res.on('error', () => finish(failed()));
      });
      r.on('error', () => finish(failed()));
      r.write(payload);
      r.end();
    } catch {
      finish(failed());
    }
  });
}

// Read Docker's newline-delimited progress stream incrementally.
function reqStream(method, path, onLine) {
  return new Promise((resolve) => {
    let settled = false;
    let r;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = () => ({ status: 0, lines: [] });
    const timer = setTimeout(() => {
      r?.destroy();
      finish(failed());
    }, DOCKER_STREAM_TIMEOUT_MS);
    try {
      r = http.request(opts(method, path), (res) => {
      let buf = '';
      let bytes = 0;
      const lines = [];
      const take = (s) => {
        if (!s.trim()) return;
        let j;
        try { j = JSON.parse(s); } catch { return; }
        lines.push(j);
        if (onLine) { try { onLine(j); } catch { /* ignore listener errors */ } }
      };
      res.setEncoding('utf8');
      res.on('data', (c) => {
        bytes += Buffer.byteLength(c);
        if (bytes > DOCKER_STREAM_MAX_BYTES) {
          res.destroy();
          r.destroy();
          finish(failed());
          return;
        }
        buf += c;
        let i = buf.indexOf('\n');
        while (i >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); i = buf.indexOf('\n'); }
      });
      res.on('end', () => { take(buf); finish({ status: res.statusCode, lines }); });
      res.on('aborted', () => finish(failed()));
      res.on('error', () => finish(failed()));
      });
      r.on('error', () => finish(failed()));
      r.end();
    } catch {
      finish(failed());
    }
  });
}

// Execute as the container's configured user and return combined output and status.
export async function execInContainer(id, cmd) {
  if (!dockerAvailable() || !/^[a-f0-9]{6,64}$/i.test(id)) return { ok: false, output: 'no such container' };
  if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, output: '' };
  if (cmd.length > 4000) return { ok: false, output: 'command too long' };
  const created = await reqBody('POST', `/containers/${id}/exec`, {
    AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ['/bin/sh', '-c', cmd],
  });
  const execId = created.json && created.json.Id;
  if (!execId) return { ok: false, output: 'this container has no shell, or the socket proxy blocks Docker writes (needs POST: 1)' };
  const started = await reqBody('POST', `/exec/${execId}/start`, { Detach: false, Tty: false }, true);
  const output = demux(started.buf || Buffer.alloc(0));
  const inspect = await req('GET', `/exec/${execId}/json`);
  const code = inspect.json && typeof inspect.json.ExitCode === 'number' ? inspect.json.ExitCode : null;
  return { ok: true, output, code };
}

export async function listContainers() {
  if (!dockerAvailable()) return null;
  const { status, json } = await req('GET', '/containers/json?all=1');
  if (status < 200 || status >= 300 || !Array.isArray(json)) return null;
  return json
    .map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '');
      // Keep the public:private port form stable; carry host addresses separately.
      const published = (c.Ports || []).filter((p) => p.PublicPort);
      const ports = published.map((p) => `${p.PublicPort}:${p.PrivatePort}`);
      // Published ports with no host address or a wildcard host address.
      const widePorts = published
        .filter((p) => {
          const ip = typeof p.IP === 'string' ? p.IP.trim() : '';
          return ip === '' || ip === '0.0.0.0' || ip === '::';
        })
        .map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type || 'tcp'}`);
      const s = c.Status || '';
      // null means no health check is configured.
      const hm = /\((healthy|unhealthy|health: starting)\)/i.exec(s);
      const health = !hm ? null : /starting/i.test(hm[1]) ? 'starting' : hm[1].toLowerCase();
      const labels = c.Labels || {};
      const nets = (c.NetworkSettings && c.NetworkSettings.Networks) || {};
      let ip = '';
      for (const k in nets) { if (nets[k] && nets[k].IPAddress) { ip = nets[k].IPAddress; break; } }
      return {
        id: c.Id,
        name,
        image: c.Image,
        imageId: c.ImageID || '',
        kind: matchImage(c.Image, name),
        state: c.State, // running | exited | paused | ...
        status: s, // "Up 3 days (healthy)"
        health, // healthy | unhealthy | starting, or null when the container has no healthcheck
        // RestartCount is available only from inspect; null means unknown.
        restarts: null,
        // "Up 3 days" without the health suffix; the list endpoint has no StartedAt
        uptime: c.State === 'running' ? s.replace(/\s*\((healthy|unhealthy|health: starting)\)/i, '') : '',
        ports: [...new Set(ports)],
        widePorts: [...new Set(widePorts)],
        ip,
        networks: Object.keys(nets),
        stack: labels['com.docker.compose.project'] || '',
        // Advisory UI state only; write routes perform a fresh containerShield check.
        protected: isProtectedContainer(name, labels['com.docker.compose.service'] || '', labels),
        // Preserve labels and named-volume mounts for downstream joins.
        labels,
        mounts: (c.Mounts || []).filter((m) => m && m.Type === 'volume' && m.Name).map((m) => m.Name),
        created: c.Created,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Cache inspect-only restart counts with the lazy stats path.
let restartCache = { at: 0, map: new Map() };
async function restartCounts(ids) {
  if (Date.now() - restartCache.at < 30_000) return restartCache.map;
  const map = new Map();
  await Promise.all(ids.map(async (id) => {
    const { json } = await req('GET', `/containers/${id}/json`);
    if (json && typeof json.RestartCount === 'number') map.set(id, json.RestartCount);
  }));
  restartCache = { at: Date.now(), map };
  return map;
}

// Fetch resource samples lazily for running containers.
export async function allContainerStats() {
  const list = await listContainers();
  if (!list) return null;
  const running = list.filter((x) => x.state === 'running');
  const [counts, stats] = await Promise.all([
    restartCounts(running.map((c) => c.id)),
    Promise.all(running.map(async (c) => {
      const { json } = await req('GET', `/containers/${c.id}/stats?stream=false`);
      if (!json || !json.cpu_stats) return null;
      // Retain bytes and limit alongside the calculated percentage.
      const memCache = (json.memory_stats && json.memory_stats.stats && (json.memory_stats.stats.inactive_file || 0)) || 0;
      const memUsed = Math.max(0, ((json.memory_stats && json.memory_stats.usage) || 0) - memCache);
      const memLimit = (json.memory_stats && json.memory_stats.limit) || 0;
      return { id: c.id, cpu: cpuPct(json), mem: memPct(json), memUsed, memLimit, net: netIO(json), disk: diskIO(json) };
    })),
  ]);
  const available = stats.filter(Boolean);
  return {
    stats: available.map((s) => ({ ...s, restarts: counts.has(s.id) ? counts.get(s.id) : null })),
    unavailable: running.length - available.length,
  };
}

// Sum cumulative network and block I/O counters.
function netIO(s) {
  const n = s.networks || {};
  let rx = 0, tx = 0;
  for (const k in n) { rx += n[k].rx_bytes || 0; tx += n[k].tx_bytes || 0; }
  return { rx, tx };
}
function diskIO(s) {
  const io = (s.blkio_stats && s.blkio_stats.io_service_bytes_recursive) || [];
  let read = 0, write = 0;
  for (const e of io) {
    if (/^read$/i.test(e.op)) read += e.value || 0;
    else if (/^write$/i.test(e.op)) write += e.value || 0;
  }
  return { read, write };
}

// Docker prefixes multiplexed stdout and stderr frames with an 8-byte header unless the container has a TTY.
function demux(buf) {
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const t = buf[i];
    if ((t === 0 || t === 1 || t === 2) && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0) {
      const size = buf.readUInt32BE(i + 4);
      out += buf.subarray(i + 8, i + 8 + size).toString('utf8');
      i += 8 + size;
    } else {
      return out + buf.subarray(i).toString('utf8'); // tty stream, no framing
    }
  }
  return out || buf.toString('utf8');
}

export async function containerLogs(id, tail = 200, timestamps = false) {
  if (!dockerAvailable() || !/^[a-f0-9]{6,64}$/i.test(id)) return null;
  const { buf } = await req('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}${timestamps ? '&timestamps=1' : ''}`, true);
  return demux(buf || Buffer.alloc(0));
}

// Prefer Docker's error text to a bare HTTP status.
function said(status, json, verb) {
  if (!status) return 'could not reach docker';
  const msg = json && json.message;
  return msg ? String(msg) : `docker would not ${verb} (${status})`;
}

// Maintenance prune endpoints. Proxy refusals are returned as blocked operations.
const PRUNES = {
  images: '/images/prune?filters=%7B%22dangling%22%3A%5B%22true%22%5D%7D',
  // dangling=false includes all images unused by containers.
  'images-all': '/images/prune?filters=%7B%22dangling%22%3A%5B%22false%22%5D%7D',
  networks: '/networks/prune',
  volumes: '/volumes/prune',
  build: '/build/prune',
};

export async function prune(kind) {
  // Container pruning must use the guarded implementation below.
  if (kind === 'containers') return { ok: false, note: 'container pruning goes through the guarded path' };
  if (!dockerAvailable()) return { ok: false, note: 'no docker socket' };
  const path = PRUNES[kind];
  if (!path) return { ok: false, note: 'no such prune' };
  const { status, json } = await req('POST', path);
  if (status === 403) return { ok: false, note: 'the socket proxy blocks this (needs POST: 1)' };
  if (status < 200 || status >= 300) return { ok: false, note: said(status, json, 'run that prune') };
  // Network pruning reports a count rather than bytes.
  if (json && Array.isArray(json.NetworksDeleted)) return { ok: true, note: json.NetworksDeleted.length ? `${json.NetworksDeleted.length} removed` : 'nothing to remove' };
  const reclaimed = (json && json.SpaceReclaimed) || 0;
  // Return deleted IDs for incremental UI updates.
  const removed = json && Array.isArray(json.ImagesDeleted)
    ? json.ImagesDeleted.map((e) => e && e.Deleted).filter(Boolean).map((d) => d.replace('sha256:', '').slice(0, 12))
    : [];
  return { ok: true, removed, note: reclaimed ? `${(reclaimed / 1048576).toFixed(1)} MB reclaimed` : 'nothing to remove' };
}

// Image pruning supports dangling-only and all-unused modes.
export async function pruneImages(mode = 'dangling') {
  const r = await prune(mode === 'all' ? 'images-all' : 'images');
  // Replace the generic prune result with the selected scope.
  if (r.ok && mode === 'all') {
    r.note = r.note === 'nothing to remove'
      ? 'nothing to remove - every image has a container on it'
      : `${r.note} - every image no container references is gone`;
  }
  return r;
}

const ACTIONS = new Set(['start', 'stop', 'restart', 'pause', 'unpause']);

export async function containerActionResult(id, action) {
  if (!dockerAvailable()) return { ok: false, note: 'no docker socket' };
  if (!/^[a-f0-9]{6,64}$/i.test(id) || !ACTIONS.has(action)) return { ok: false, note: 'that container action is not allowed' };
  const { status, json } = await req('POST', `/containers/${id}/${action}`);
  if (status === 403) return { ok: false, note: 'the socket proxy blocks this action (needs POST: 1)' };
  if (status !== 204 && status !== 304) return { ok: false, note: said(status, json, action) };
  return { ok: true, note: status === 304 ? 'already in that state' : `${action} accepted` };
}

export async function containerAction(id, action) {
  return (await containerActionResult(id, action)).ok;
}

// Cache counts from the container list for dashboard and sidebar rendering.
let countsCache = null;
export function cachedCounts() {
  return countsCache;
}
export async function dockerCounts() {
  const list = await listContainers();
  if (!list) {
    // Do not retain stale counts after a failed read.
    countsCache = null;
    return null;
  }
  // Containers without health checks do not count as healthy or unhealthy.
  const c = { total: list.length, running: 0, stopped: 0, paused: 0, restarting: 0, unhealthy: 0, healthy: 0, starting: 0 };
  for (const x of list) {
    if (x.state === 'running') c.running += 1;
    else if (x.state === 'paused') c.paused += 1;
    else if (x.state === 'restarting') c.restarting += 1;
    else c.stopped += 1;
    if (/unhealthy/i.test(x.status || '')) c.unhealthy += 1;
    else if (x.health === 'healthy') c.healthy += 1;
    else if (x.health === 'starting') c.starting += 1;
  }
  countsCache = c;
  return c;
}

// Calculate CPU and memory use from a non-streaming Docker stats sample.
function cpuPct(s) {
  const d = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sys = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
  const cpus = s.cpu_stats.online_cpus || (s.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
  return sys > 0 && d > 0 ? (d / sys) * cpus * 100 : 0;
}
function memPct(s) {
  const cache = (s.memory_stats.stats && (s.memory_stats.stats.inactive_file || 0)) || 0;
  const used = (s.memory_stats.usage || 0) - cache;
  const limit = s.memory_stats.limit || 0;
  return limit ? (used / limit) * 100 : 0;
}

async function oneStat(c) {
  const { json } = await req('GET', `/containers/${c.id}/stats?stream=false`);
  if (!json || !json.cpu_stats) return null;
  const cache = (json.memory_stats && json.memory_stats.stats && (json.memory_stats.stats.inactive_file || 0)) || 0;
  const memUsed = Math.max(0, ((json.memory_stats && json.memory_stats.usage) || 0) - cache);
  return { name: c.name, kind: c.kind, cpu: cpuPct(json), memUsed };
}

// Collect one container's live resource sample.
export async function containerStat(id) {
  if (!dockerAvailable() || !/^[a-f0-9]{6,64}$/i.test(id)) return null;
  const { json } = await req('GET', `/containers/${id}/stats?stream=false`);
  if (!json || !json.cpu_stats) return null;
  const cache = (json.memory_stats && json.memory_stats.stats && (json.memory_stats.stats.inactive_file || 0)) || 0;
  const memUsed = Math.max(0, ((json.memory_stats && json.memory_stats.usage) || 0) - cache);
  const memLimit = (json.memory_stats && json.memory_stats.limit) || 0;
  return { cpu: cpuPct(json), memUsed, memLimit };
}

// Cache host facts used by the page header.
let infoCache = null;
export function cachedInfo() {
  return infoCache;
}
async function refreshInfo() {
  try {
    infoCache = await dockerInfo();
  } catch {
    infoCache = null;
  }
}
if (dockerAvailable()) {
  refreshInfo();
  setInterval(refreshInfo, 60_000).unref();
}

// Read host uptime from /proc when available.
function hostUptimeSec() {
  try {
    const s = parseFloat(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    return Number.isFinite(s) && s > 0 ? Math.floor(s) : null;
  } catch {
    return null;
  }
}

// Read host CPU and memory from /proc. CPU requires two samples; missing files return null.
let procCpuPrev = null;
export function hostProcMetrics(statPath = '/proc/stat', memPath = '/proc/meminfo') {
  const out = {};
  try {
    const stat = readFileSync(statPath, 'utf8');
    const first = stat.split('\n', 1)[0];
    const fields = first.trim().split(/\s+/);
    if (fields[0] === 'cpu') {
      const nums = fields.slice(1, 9).map(Number);
      if (nums.length >= 4 && nums.every(Number.isFinite)) {
        const total = nums.reduce((a, b) => a + b, 0);
        const idle = nums[3] + (nums[4] || 0);
        if (procCpuPrev && total > procCpuPrev.total) {
          const dTotal = total - procCpuPrev.total;
          const dIdle = idle - procCpuPrev.idle;
          out.cpuPct = Math.max(0, Math.min(100, (100 * (dTotal - dIdle)) / dTotal));
        }
        procCpuPrev = { total, idle };
      }
    }
    const cores = (stat.match(/^cpu\d+\s/gm) || []).length;
    if (cores > 0) out.cpuCores = cores;
  } catch { /* no /proc here (macOS dev) */ }
  try {
    const mem = readFileSync(memPath, 'utf8');
    const totalKb = Number((/^MemTotal:\s+(\d+)/m.exec(mem) || [])[1]);
    const availKb = Number((/^MemAvailable:\s+(\d+)/m.exec(mem) || [])[1]);
    if (totalKb > 0 && Number.isFinite(availKb)) {
      out.memPct = Math.max(0, Math.min(100, (100 * (totalKb - availKb)) / totalKb));
    }
  } catch { /* absent stays absent */ }
  return Object.keys(out).length ? out : null;
}

export function resetHostProcMetricsForTest() {
  procCpuPrev = null;
}

// Read host temperature sensors from /sys when available.
export function hostTemps(base = '/sys/class/hwmon', thermalBase = '/sys/class/thermal') {
  const cpu = [];
  const drives = [];
  const board = [];
  let dirs;
  try { dirs = readdirSync(base); } catch { dirs = []; }
  for (const d of dirs) {
    const dir = `${base}/${d}`;
    let name = '';
    try { name = readFileSync(`${dir}/name`, 'utf8').trim().toLowerCase(); } catch { name = ''; }
    let files;
    try { files = readdirSync(dir).filter((f) => /^temp\d+_input$/.test(f)); } catch { files = []; }
    // Collapse drive sensors to the hottest value; retain CPU core sensors.
    const vals = [];
    let cpuByLabel = false;
    for (const f of files) {
      let raw;
      try { raw = Number(readFileSync(`${dir}/${f}`, 'utf8').trim()); } catch { continue; }
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const c = raw / 1000;
      if (c < -40 || c > 150) continue; // ignore a sensor reporting nonsense
      let label = '';
      try { label = readFileSync(`${dir}/${f.replace('_input', '_label')}`, 'utf8').trim(); } catch { label = ''; }
      if (/package|tctl|tdie|core\s*\d+/i.test(label)) cpuByLabel = true;
      vals.push(c);
    }
    if (vals.length === 0) continue;
    if (/^(coretemp|k10temp|zenpower|cpu_thermal)$/.test(name) || cpuByLabel) { for (const c of vals) cpu.push(c); }
    else if (/^(nvme|drivetemp)$/.test(name)) drives.push(Math.max(...vals)); // one entry per drive
    else board.push(Math.max(...vals));
  }
  if (cpu.length === 0) {
    let zones;
    try { zones = readdirSync(thermalBase).filter((z) => /^thermal_zone\d+$/.test(z)); } catch { zones = []; }
    for (const z of zones) {
      let type = '';
      try { type = readFileSync(`${thermalBase}/${z}/type`, 'utf8').trim(); } catch { type = ''; }
      if (!/x86_pkg_temp|cpu/i.test(type)) continue;
      try { const c = Number(readFileSync(`${thermalBase}/${z}/temp`, 'utf8').trim()) / 1000; if (c > 0 && c < 150) cpu.push(c); } catch { /* skip */ }
    }
  }
  if (cpu.length === 0 && drives.length === 0 && board.length === 0) return null;
  const hottest = (a) => (a.length ? Math.round(Math.max(...a)) : null);
  return { cpuC: hottest(cpu), driveC: hottest(drives), boardC: hottest(board), driveCount: drives.length };
}

// Return host, engine, and resource summary data.
export async function dockerInfo() {
  if (!dockerAvailable()) return null;
  const [info, nets, vols] = await Promise.all([
    req('GET', '/info'),
    req('GET', '/networks'),
    req('GET', '/volumes'),
  ]);
  if (info.status < 200 || info.status >= 300 || !info.json || typeof info.json !== 'object') return null;
  const i = info.json || {};
  return {
    name: i.Name,
    version: i.ServerVersion,
    os: i.OperatingSystem,
    arch: i.Architecture,
    ncpu: i.NCPU,
    memTotal: i.MemTotal,
    images: i.Images,
    networks: Array.isArray(nets.json) ? nets.json.length : null,
    volumes: vols.json && Array.isArray(vols.json.Volumes) ? vols.json.Volumes.length : null,
    uptimeSec: hostUptimeSec(),
  };
}

// Aggregate per-container stats and Docker disk usage for the dashboard.
export async function dockerStats() {
  const list = await listContainers();
  if (!list) return null;
  const running = list.filter((x) => x.state === 'running');
  const [stats, df, info] = await Promise.all([
    Promise.all(running.map(oneStat)).then((s) => s.filter(Boolean)),
    req('GET', '/system/df'),
    infoCache && Number(infoCache.memTotal) > 0 ? Promise.resolve(infoCache) : dockerInfo(),
  ]);
  if ((!infoCache || !(Number(infoCache.memTotal) > 0)) && info) infoCache = info;
  const metricsUnavailable = running.length - stats.length;
  const cpu = running.length && stats.length === 0 ? null : stats.reduce((n, s) => n + s.cpu, 0);
  const hostMem = Number(info && info.memTotal) > 0 ? Number(info.memTotal) : 0;
  const mem = hostMem ? stats.reduce((n, s) => n + s.memUsed, 0) / hostMem * 100 : null;
  const top = stats
    .map((s) => ({ ...s, mem: hostMem ? s.memUsed / hostMem * 100 : null }))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 6);

  let disk = null;
  if (df.status >= 200 && df.status < 300 && df.json && typeof df.json === 'object') {
    const d = df.json;
    const sz = (arr, key) => (Array.isArray(arr) ? arr : []).reduce((n, x) => n + (x[key] || 0), 0);
    disk = {
      // LayersSize avoids double-counting shared image layers.
      images: Number.isFinite(d.LayersSize) ? d.LayersSize : sz(d.Images, 'Size'),
      containers: sz(d.Containers, 'SizeRw'),
      volumes: (Array.isArray(d.Volumes) ? d.Volumes : []).reduce((n, x) => n + ((x.UsageData && x.UsageData.Size) || 0), 0),
      build: sz(d.BuildCache, 'Size'),
    };
    disk.total = disk.images + disk.containers + disk.volumes + disk.build;
  }
  return { cpu, mem, top, disk, metricsUnavailable, cores: Number(info && info.ncpu) > 0 ? Number(info.ncpu) : null, temps: hostTemps() };
}

// Expand image-list tags without additional Docker requests.
function tagRows(tags, digests) {
  const byRepo = new Map();
  for (const d of digests) {
    const at = String(d).lastIndexOf('@');
    if (at > 0) byRepo.set(String(d).slice(0, at), String(d).slice(at + 1));
  }
  return tags.map((t) => {
    // Split tags only after the final slash so registry ports remain intact.
    const colon = t.lastIndexOf(':');
    const tagged = colon > t.lastIndexOf('/');
    const repo = tagged ? t.slice(0, colon) : t;
    return { ref: t, repo, tag: tagged ? t.slice(colon + 1) : 'latest', digest: byRepo.get(repo) || '' };
  });
}

export async function listImages() {
  if (!dockerAvailable()) return null;
  const { status, json } = await req('GET', '/images/json');
  if (status === 403) return 'blocked';
  // Preserve read failure as null.
  if (status < 200 || status >= 300 || !Array.isArray(json)) return null;
  return json
    .map((i) => {
      const tags = (i.RepoTags || []).filter((t) => t && t !== '<none>:<none>');
      const repoDigests = i.RepoDigests || [];
      return {
        id: (i.Id || '').replace('sha256:', '').slice(0, 12),
        fullId: i.Id || '',
        tags,
        tagList: tagRows(tags, repoDigests), // [{ ref, repo, tag, digest }] for the row expander
        repoDigests,
        size: i.Size,
        created: i.Created,
        containers: i.Containers, // always -1 from /images/json; join imagesInUse() instead
        dangling: !tags.length,
      };
    })
    .sort((a, b) => b.created - a.created);
}

// Derive image usage from the container list.
export async function imagesInUse() {
  const list = await listContainers();
  const set = new Set();
  for (const c of list || []) if (c.imageId) set.add(c.imageId);
  return set;
}

export async function listVolumes() {
  if (!dockerAvailable()) return null;
  const { status, json } = await req('GET', '/volumes');
  if (status === 403) return 'blocked';
  if (status < 200 || status >= 300 || !json || !Array.isArray(json.Volumes)) return null;
  const vols = json.Volumes;
  return vols
    .map((v) => ({
      name: v.Name,
      driver: v.Driver,
      scope: v.Scope || 'local',
      mountpoint: v.Mountpoint,
      created: v.CreatedAt || '',
      stack: (v.Labels && v.Labels['com.docker.compose.project']) || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Read volume usage from /system/df on demand.
export async function systemDf() {
  if (!dockerAvailable()) return null;
  const { status, json } = await req('GET', '/system/df');
  if (status === 403) return 'blocked';
  if (status < 200 || status >= 300 || !json || typeof json !== 'object') return null;
  const volumes = {};
  for (const v of Array.isArray(json.Volumes) ? json.Volumes : []) {
    if (!v || typeof v.Name !== 'string' || !v.Name) continue;
    const usage = v.UsageData || {};
    // Preserve Docker's -1 sentinel for unmeasured size.
    volumes[v.Name] = { size: typeof usage.Size === 'number' ? usage.Size : -1 };
  }
  return { volumes };
}

export async function removeVolume(name) {
  if (!dockerAvailable()) return { ok: false, note: 'no docker socket' };
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(name)) return { ok: false, note: 'no such volume' };
  const { status, json } = await req('DELETE', `/volumes/${encodeURIComponent(name)}`);
  if (status === 403) return { ok: false, note: 'the socket proxy blocks this (needs POST: 1)' };
  if (status === 404) return { ok: false, note: 'no such volume' };
  if (status === 409) return { ok: false, note: 'in use by a container - remove the container first' };
  if (status !== 204) return { ok: false, note: said(status, json, 'remove that volume') };
  return { ok: true, note: '' };
}

// Build network membership from running and paused container rows.
export function groupByNetwork(containers) {
  const map = new Map();
  for (const c of containers || []) {
    if (c.state !== 'running' && c.state !== 'paused') continue;
    for (const net of c.networks || []) {
      if (!map.has(net)) map.set(net, []);
      map.get(net).push(c.name);
    }
  }
  return map;
}

// /containers/json only carries network names per container, so that is what we invert.
export async function networkContainerNames() {
  return groupByNetwork(await listContainers());
}

export async function listNetworks() {
  if (!dockerAvailable()) return null;
  const { status, json } = await req('GET', '/networks');
  if (status === 403) return 'blocked';
  // An empty network response indicates a failed read.
  if (status < 200 || status >= 300 || !Array.isArray(json)) return null;
  const byNet = await networkContainerNames();
  return json
    .map((n) => {
      const names = byNet.get(n.Name) || [];
      // Prefer endpoint data when present; otherwise use the container-list join.
      const live = n.Containers && typeof n.Containers === 'object' ? Object.keys(n.Containers).length : 0;
      return {
        name: n.Name,
        stack: (n.Labels && n.Labels['com.docker.compose.project']) || '',
        driver: n.Driver,
        scope: n.Scope,
        internal: !!n.Internal,
        subnet: (n.IPAM && n.IPAM.Config && n.IPAM.Config[0] && n.IPAM.Config[0].Subnet) || '',
        gateway: (n.IPAM && n.IPAM.Config && n.IPAM.Config[0] && n.IPAM.Config[0].Gateway) || '',
        containers: live > 0 ? live : names.length,
        containerNames: names, // the running ones, same set the count is built from
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createNetwork(name, driver = 'bridge', subnet = '') {
  if (!dockerAvailable()) return { ok: false, note: 'no docker socket' };
  if (!/^[a-z0-9][a-z0-9_.-]{0,40}$/i.test(name || '')) return { ok: false, note: 'network names are letters, digits, dots, dashes and underscores' };
  if (!/^[a-z0-9_-]{1,24}$/i.test(driver || '')) driver = 'bridge';
  const body = { Name: name, Driver: driver };
  if (subnet) {
    if (!/^[0-9a-f.:]+\/\d{1,3}$/i.test(subnet)) return { ok: false, note: 'that subnet does not look like CIDR (10.0.5.0/24)' };
    body.IPAM = { Driver: 'default', Config: [{ Subnet: subnet }] };
  }
  const { status, json } = await reqBody('POST', '/networks/create', body);
  if (status === 403) return { ok: false, note: 'the socket proxy blocks this (needs POST: 1)' };
  if (status === 409) return { ok: false, note: 'a network with that name already exists' };
  if (status < 200 || status >= 300) return { ok: false, note: said(status, json, 'create that network') };
  return { ok: true, note: '', id: (json && json.Id) || '' };
}

export async function removeNetwork(id) {
  if (!dockerAvailable()) return { ok: false, note: 'no docker socket' };
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(id || '')) return { ok: false, note: 'no such network' };
  const { status, json } = await req('DELETE', `/networks/${encodeURIComponent(id)}`);
  if (status === 403) return { ok: false, note: 'the socket proxy blocks this (needs POST: 1)' };
  const msg = (json && json.message) || '';
  // Docker versions use either 409 or 500 for active endpoints.
  if (status === 409 || /active endpoints/i.test(msg)) return { ok: false, note: 'a container is still attached - stop it first' };
  if (status !== 204) return { ok: false, note: said(status, json, 'remove that network') };
  return { ok: true, note: '' };
}

// Group containers by the com.docker.compose.project label.
export async function listStacks() {
  const list = await listContainers();
  if (!list) return null;
  const map = new Map();
  for (const c of list) {
    if (!c.stack) continue;
    if (!map.has(c.stack)) map.set(c.stack, { name: c.stack, services: [], ids: [], running: 0, total: 0, unhealthy: 0, networks: 0, volumes: 0, configFiles: '' });
    const g = map.get(c.stack);
    // Retain the Compose working directory for adoption.
    if (!g.configFiles && c.labels && c.labels['com.docker.compose.project.config_files']) {
      g.configFiles = String(c.labels['com.docker.compose.project.config_files']);
    }
    g.services.push({ id: c.id, name: c.name, kind: c.kind, state: c.state, health: c.health, ports: c.ports, image: c.image, ip: c.ip, uptime: c.uptime, protected: c.protected });
    g.ids.push(c.id);
    g.total += 1;
    if (c.state === 'running') g.running += 1;
    if (c.health === 'unhealthy') g.unhealthy += 1;
  }
  // Join Compose-owned networks and volumes by project label.
  const [netsRaw, volsRaw] = await Promise.all([listNetworks(), listVolumes()]);
  // Preserve unavailable network and volume counts as null.
  const nets = Array.isArray(netsRaw) ? netsRaw : null;
  const vols = Array.isArray(volsRaw) ? volsRaw : null;
  const projects = [...map.keys()].sort((a, b) => b.length - a.length);
  const ownerOf = (resource) => resource.stack || projects.find((project) => resource.name === project || resource.name.startsWith(`${project}_`)) || '';
  for (const g of map.values()) {
    g.networks = nets ? nets.filter((n) => ownerOf(n) === g.name).length : null;
    g.volumes = vols ? vols.filter((v) => ownerOf(v) === g.name).length : null;
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Read a bounded Docker event window.
export async function recentEvents(hours = 24, limit = 60) {
  if (!dockerAvailable()) return null;
  const until = Math.floor(Date.now() / 1000);
  const since = until - hours * 3600;
  const { status, buf } = await req('GET', `/events?since=${since}&until=${until}`, true);
  if (status === 403) return 'blocked';
  // Preserve read failure as null.
  if (status < 200 || status >= 300) return null;
  const lines = (buf ? buf.toString('utf8') : '').trim().split('\n').filter(Boolean);
  const out = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      const attrs = (e.Actor && e.Actor.Attributes) || {};
      out.push({ time: e.time, action: e.Action || e.status, type: e.Type, name: attrs.name || '', image: attrs.image || '', exitCode: attrs.exitCode || '' });
    } catch {
      /* skip a partial line */
    }
  }
  return out.slice(-limit).reverse();
}

// Accept bounded image references with optional tags, registry ports, or digests.
const REF_RE = /^[a-z0-9][a-z0-9._/:@-]{1,200}$/i;

// Escape image references before inserting them into Docker API paths.
function pathSeg(ref) {
  const s = String(ref);
  if (s.startsWith('/') || s.split('/').includes('..')) return null;
  return encodeURIComponent(s);
}

// Pass pull progress to onLine while the request is active.
export async function pullImage(ref, onLine) {
  if (!dockerAvailable()) return { ok: false, note: 'no docker socket' };
  if (typeof ref !== 'string' || !REF_RE.test(ref)) return { ok: false, note: 'that does not look like an image reference' };
  let repo = ref;
  let tag = 'latest';
  const colon = ref.lastIndexOf(':');
  if (colon > ref.lastIndexOf('/')) { repo = ref.slice(0, colon); tag = ref.slice(colon + 1); }
  const { status, lines } = await reqStream('POST', `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`, onLine);
  if (status === 403) return { ok: false, note: 'the socket proxy blocks this (needs POST: 1)' };
  if (status === 404) return { ok: false, note: `the registry has nothing called ${repo}:${tag}` };
  if (status < 200 || status >= 300) return { ok: false, note: said(status, null, 'pull that') };
  // Pull errors may appear in the stream rather than the HTTP status.
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
    const j = lines[i];
    if (j && (j.errorDetail || j.error)) return { ok: false, note: (j.errorDetail && j.errorDetail.message) || j.error };
  }
  return { ok: true, note: `pulled ${repo}:${tag}` };
}

export async function removeImage(id) {
  if (!dockerAvailable()) return { ok: false, note: 'no docker socket' };
  const hex = /^(sha256:)?[a-f0-9]{12,64}$/i.test(id || '');
  if (!hex && !(typeof id === 'string' && REF_RE.test(id))) return { ok: false, note: 'no such image' };
  const seg = pathSeg(id);
  if (!seg) return { ok: false, note: 'no such image' };
  const { status, json } = await req('DELETE', `/images/${seg}`);
  if (status === 403) return { ok: false, note: 'the socket proxy blocks this (needs POST: 1)' };
  if (status === 404) return { ok: false, note: 'no such image' };
  // Preserve the in-use phrase for HTTP 409 mapping.
  if (status === 409) return { ok: false, note: 'in use by a container - remove the container first' };
  if (status < 200 || status >= 300) return { ok: false, note: said(status, json, 'remove that image') };
  return { ok: true, note: 'removed' };
}

export async function inspectContainer(id) {
  if (!dockerAvailable() || !/^[a-f0-9]{6,64}$/i.test(id)) return null;
  const { status, json } = await req('GET', `/containers/${id}/json`);
  return status === 200 && json ? json : null;
}

// All container write paths use a fresh inspection and fail closed when the target cannot be verified.
export async function containerShield(id) {
  const raw = await inspectContainer(String(id || ''));
  if (!raw) {
    return { state: 'unverified', reason: 'that container could not be inspected to confirm it is safe to act on, so the action is refused' };
  }
  const name = String(raw.Name || '').replace(/^\//, '');
  const labels = raw.Config && raw.Config.Labels ? raw.Config.Labels : {};
  if (isProtectedContainer(name, labels['com.docker.compose.service'] || '', labels)) {
    return { state: 'protected', reason: `${name || 'that container'} runs Companion or its socket proxy, so control actions on it are refused here` };
  }
  return { state: 'clear', reason: null };
}

export async function protectedContainerReason(id) {
  return (await containerShield(id)).reason;
}

// Enumerate stopped containers so protected and unverified targets can be retained during pruning.
export async function pruneContainersGuarded() {
  const list = await listContainers();
  if (!list) return { ok: false, note: 'no docker socket' };
  const stopped = list.filter((c) => c.state === 'exited' || c.state === 'created' || c.state === 'dead');
  let removed = 0;
  let kept = 0;
  let unverified = 0;
  let failed = 0;
  for (const c of stopped) {
    const shield = await containerShield(c.id);
    if (shield.state === 'protected') {
      kept += 1;
      continue;
    }
    if (shield.state !== 'clear') {
      unverified += 1;
      continue;
    }
    const r = await removeContainer(c.id);
    if (r.ok) removed += 1;
    else failed += 1;
  }
  const parts = [removed ? `${removed} removed` : 'nothing to remove'];
  if (kept) parts.push(`${kept} protected kept`);
  if (unverified) parts.push(`${unverified} unverified kept`);
  if (failed) parts.push(`${failed} refused`);
  return { ok: failed === 0, note: parts.join(', ') };
}

export const CNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/;

export async function renameContainer(id, name) {
  if (!dockerAvailable() || !/^[a-f0-9]{6,64}$/i.test(id)) return { ok: false, note: 'no such container' };
  if (!CNAME_RE.test(name || '')) return { ok: false, note: 'that name will not work' };
  const { status, json } = await req('POST', `/containers/${id}/rename?name=${encodeURIComponent(name)}`);
  if (status === 403) return { ok: false, note: 'the socket proxy blocks this (needs POST: 1)' };
  if (status === 409) return { ok: false, note: 'a container with that name already exists' };
  if (status !== 204) return { ok: false, note: said(status, json, 'rename it') };
  return { ok: true, note: '' };
}

export async function removeContainer(id, force = false) {
  if (!dockerAvailable() || !/^[a-f0-9]{6,64}$/i.test(id)) return { ok: false, note: 'no such container' };
  const { status, json } = await req('DELETE', `/containers/${id}?force=${force ? 1 : 0}`);
  if (status === 403) return { ok: false, note: 'the socket proxy blocks this (needs POST: 1)' };
  if (status === 404) return { ok: false, note: 'no such container' };
  if (status === 409) return { ok: false, note: 'still running - stop it first' };
  if (status !== 204) return { ok: false, note: said(status, json, 'remove it') };
  return { ok: true, note: '' };
}

export async function createContainer(name, body) {
  if (!dockerAvailable()) return { ok: false, id: '', note: 'no docker socket' };
  if (!CNAME_RE.test(name || '')) return { ok: false, id: '', note: 'that name will not work' };
  const { status, json } = await reqBody('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
  if (status === 403) return { ok: false, id: '', note: 'the socket proxy blocks this (needs POST: 1)' };
  if (status === 409) return { ok: false, id: '', note: 'a container with that name already exists' };
  if (status === 404) return { ok: false, id: '', note: 'the image is not on this host' };
  if (status !== 201) return { ok: false, id: '', note: said(status, json, 'create it') };
  return { ok: true, id: (json && json.Id) || '', note: '' };
}

// Recreate only after the image changes, retaining the old container for rollback.
export async function updateContainer(id, onStep) {
  const step = (o) => { if (onStep) { try { onStep(o); } catch { /* Ignore progress-consumer errors. */ } } };
  if (!dockerAvailable()) return { ok: false, note: 'no docker socket', updated: false };
  const old = await inspectContainer(id);
  if (!old || !old.Config) return { ok: false, note: 'no such container', updated: false };
  const ref = old.Config.Image;
  const name = (old.Name || '').replace(/^\//, '');
  const oldId = old.Id;
  const short = oldId.slice(0, 12);
  const wasRunning = !!(old.State && old.State.Running);

  step({ id: 'pull', label: `Pull ${ref}`, state: 'active' });
  const pulled = await pullImage(ref, (line) => step({ id: 'pull', pull: line }));
  if (!pulled.ok) {
    step({ id: 'pull', state: 'fail', note: pulled.note });
    return { ok: false, note: `pull failed - ${pulled.note}`, updated: false, failed: 'pull' };
  }
  step({ id: 'pull', state: 'ok', note: 'image downloaded' });

  step({ id: 'compare', label: 'Compare image IDs', state: 'active' });
  const img = await req('GET', `/images/${ref}/json`);
  const latest = img.json && img.json.Id;
  if (!latest) {
    step({ id: 'compare', state: 'fail', note: 'image ID unavailable' });
    return { ok: false, note: 'pulled image ID unavailable', updated: false, failed: 'compare' };
  }
  if (latest === old.Image) {
    step({ id: 'compare', state: 'ok', note: 'already current' });
    return { ok: true, note: 'already current', updated: false };
  }
  step({ id: 'compare', label: 'New image available', state: 'ok', note: String(latest).replace('sha256:', '').slice(0, 12), mono: true });

  if (wasRunning) {
    step({ id: 'stop', label: `Stop ${name}`, state: 'active' });
    const stopped = await containerAction(oldId, 'stop');
    if (!stopped) {
      step({ id: 'stop', state: 'fail', note: 'stop failed' });
      return { ok: false, note: 'could not stop the old container', updated: false, failed: 'stop' };
    }
    step({ id: 'stop', state: 'ok', note: 'stopped' });
  }
  step({ id: 'park', label: `Park the old container as ${name}__old`, state: 'active' });
  const parked = await renameContainer(oldId, `${name}__old`);
  if (!parked.ok) {
    step({ id: 'park', state: 'fail', note: parked.note });
    step({ id: 'rollback', label: 'Put the old container back', state: 'active' });
    if (wasRunning) await containerAction(oldId, 'start');
    step({ id: 'rollback', state: 'ok', note: 'nothing was changed' });
    return { ok: false, note: `rename failed - ${parked.note}`, updated: false, failed: 'park', rolledBack: true };
  }
  step({ id: 'park', state: 'ok', note: 'parked' });
  const rollback = async (createdId) => {
    step({ id: 'rollback', label: 'Put the old container back', state: 'active' });
    if (createdId) await removeContainer(createdId, true);
    const back = await renameContainer(oldId, name);
    const up = wasRunning ? await containerAction(oldId, 'start') : true;
    const ok = back.ok && up;
    step({ id: 'rollback', state: ok ? 'ok' : 'fail', note: ok ? 'previous container restored' : 'restore incomplete; check the container list' });
    return ok;
  };

  // Drop Docker-generated aliases while preserving configured network identity.
  const eps = Object.create(null);
  const nets = (old.NetworkSettings && old.NetworkSettings.Networks) || {};
  for (const netName of Object.keys(nets)) {
    const net = nets[netName] || {};
    const ep = {};
    if (net.IPAMConfig) ep.IPAMConfig = net.IPAMConfig;
    const aliases = (net.Aliases || []).filter((a) => a && a !== short && a !== name);
    if (aliases.length) ep.Aliases = aliases;
    eps[netName] = ep;
  }
  const cfg = { ...old.Config, Image: ref };
  if (cfg.Hostname === short) delete cfg.Hostname;
  step({ id: 'create', label: `Create ${name} on the new image`, state: 'active' });
  const created = await createContainer(name, { ...cfg, HostConfig: old.HostConfig, NetworkingConfig: { EndpointsConfig: eps } });
  if (!created.ok) {
    step({ id: 'create', state: 'fail', note: created.note });
    const back = await rollback('');
    return { ok: false, note: `create failed - ${created.note} - rolled back`, updated: false, failed: 'create', rolledBack: back };
  }
  step({ id: 'create', state: 'ok', note: String(created.id).slice(0, 12), mono: true });
  if (wasRunning) {
    step({ id: 'start', label: `Start ${name}`, state: 'active' });
    const started = await containerAction(created.id, 'start');
    if (!started) {
      step({ id: 'start', state: 'fail', note: 'it would not start' });
      const back = await rollback(created.id);
      return { ok: false, note: 'the new container would not start - rolled back', updated: false, failed: 'start', rolledBack: back };
    }
    step({ id: 'start', state: 'ok', note: 'running' });
  }
  step({ id: 'remove', label: 'Remove the old container', state: 'active' });
  const gone = await removeContainer(oldId, true);
  step({ id: 'remove', state: gone.ok ? 'ok' : 'fail', note: gone.ok ? 'removed' : gone.note });
  return {
    ok: true,
    note: gone.ok ? `updated ${name}` : `updated ${name}, but ${name}__old would not remove - ${gone.note}`,
    updated: true,
    id: created.id,
  };
}
