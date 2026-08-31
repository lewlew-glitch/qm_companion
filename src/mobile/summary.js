// Allow-listed Observer DTOs without sensitive Docker configuration.

import { containerStat, dockerAvailable, dockerCounts, hostProcMetrics, hostTemps, inspectContainer, listContainers, listImages, listStacks, recentEvents, systemDf } from '../docker.js';
import { runUpdateCheck, updatesState } from '../updates.js';

export const MAX_EVENTS = 200;
const MAX_NAME = 128;

function shortId(id) {
  return String(id || '').slice(0, 12);
}

function name(value) {
  return String(value || '').slice(0, MAX_NAME);
}

function containerDto(c) {
  return {
    id: shortId(c.id),
    name: name(c.name),
    image: name(c.image),
    state: String(c.state || ''),
    health: c.health ?? null,
    uptime: String(c.uptime || ''),
    stack: name(c.stack),
    protected: c.protected === true,
  };
}

// Host-global CPU, memory, and sensor metrics; the first CPU sample may be absent.
function hostMetrics() {
  const proc = hostProcMetrics();
  const temps = hostTemps();
  const value = { ...(proc || {}) };
  if (temps && Number.isFinite(temps.cpuC)) {
    value.tempC = temps.cpuC;
    if (Number.isFinite(temps.driveC)) {
      value.driveTempC = temps.driveC;
      value.driveCount = temps.driveCount || 0;
    }
  }
  return Object.keys(value).length ? value : null;
}

export async function summaryDto() {
  if (!dockerAvailable()) return { v: 1, docker: 'unavailable' };
  const [counts, stacks, df] = await Promise.all([dockerCounts(), listStacks(), systemDf().catch(() => null)]);
  const metrics = hostMetrics();
  // Distinguish daemon failure from an empty result.
  if (!counts) return { v: 1, docker: 'unavailable' };
  const out = { v: 1, docker: 'available', generatedAt: Date.now() };
  out.containers = { total: counts.total, running: counts.running, stopped: counts.stopped, paused: counts.paused, restarting: counts.restarting, unhealthy: counts.unhealthy, healthy: counts.healthy };
  if (Array.isArray(stacks)) {
    out.stacks = { total: stacks.length, healthy: stacks.filter((s) => s.running === s.total && s.unhealthy === 0).length, unhealthy: stacks.filter((s) => s.unhealthy > 0).length, partial: stacks.filter((s) => s.running !== s.total).length };
  }
  if (metrics) out.metrics = metrics;
  if (df && typeof df === 'object' && df.volumes && typeof df.volumes === 'object') {
    // Count unsized Docker volumes but exclude them from the byte total.
    const sizes = Object.values(df.volumes).map((v) => v.size);
    const measured = sizes.filter((n) => Number.isFinite(n) && n >= 0);
    out.dockerStorage = { volumesTotal: sizes.length, volumesMeasured: measured.length, volumesBytes: measured.reduce((a, b) => a + b, 0) };
  }
  return out;
}

export async function containersDto() {
  const list = await listContainers();
  if (!Array.isArray(list)) return { v: 1, docker: 'unavailable' };
  return { v: 1, docker: 'available', containers: list.map(containerDto) };
}

export async function stacksDto() {
  const stacks = await listStacks();
  if (!Array.isArray(stacks)) return { v: 1, docker: 'unavailable' };
  return {
    v: 1,
    docker: 'available',
    stacks: stacks.map((s) => ({
      name: name(s.name),
      total: s.total,
      running: s.running,
      unhealthy: s.unhealthy,
      services: s.services.map((x) => ({ id: shortId(x.id), name: name(x.name), state: String(x.state || ''), health: x.health ?? null })),
    })),
  };
}

/** Return cached update state and debounce stale background refreshes. */
const WARM_STALE_MS = 30 * 60 * 1000;
const WARM_DEBOUNCE_MS = 5 * 60 * 1000;
let warmInFlight = false;
let lastWarmStartedAt = 0;
let lastWarmFailed = false;
export async function updatesDto(warm = runUpdateCheck) {
  const [containers, images] = await Promise.all([listContainers(), listImages()]);
  if (!Array.isArray(containers)) return { v: 1, docker: 'unavailable' };
  const state = updatesState(containers, Array.isArray(images) ? images : []);
  const stale = !state.checkedAt || Date.now() - state.checkedAt > WARM_STALE_MS;
  if (stale && !warmInFlight && Date.now() - lastWarmStartedAt > WARM_DEBOUNCE_MS) {
    warmInFlight = true;
    lastWarmStartedAt = Date.now();
    Promise.resolve()
      .then(() => warm())
      .then((outcome) => { lastWarmFailed = !outcome || outcome.ok === false; })
      .catch(() => { lastWarmFailed = true; })
      .finally(() => { warmInFlight = false; });
  }
  return {
    v: 1,
    docker: 'available',
    checkedAt: state.checkedAt,
    updateCount: state.updateCount,
    checking: warmInFlight,
    // Distinguish failed refresh from absent update history.
    checkFailed: !warmInFlight && !state.checkedAt && lastWarmFailed,
    results: (state.results || []).map((r) => ({ image: name(r.image), status: String(r.status || 'unknown'), dismissed: r.dismissed === true })),
  };
}

/** Return allow-listed lifecycle and resource details for one listed container. */
export async function containerDetailDto(shortIdWanted, statFn = containerStat, inspectFn = inspectContainer) {
  const list = await listContainers();
  if (!Array.isArray(list)) return { v: 1, docker: 'unavailable' };
  const found = list.find((c) => shortId(c.id) === String(shortIdWanted || ''));
  if (!found) return { v: 1, docker: 'available', container: null };
  const out = containerDto(found);
  const running = found.state === 'running';
  const [inspected, stat] = await Promise.all([
    inspectFn(found.id).catch(() => null),
    running ? statFn(found.id).catch(() => null) : Promise.resolve(null),
  ]);
  if (inspected && typeof inspected === 'object') {
    const st = inspected.State && typeof inspected.State === 'object' ? inspected.State : {};
    const startedAt = Date.parse(st.StartedAt || '');
    const finishedAt = Date.parse(st.FinishedAt || '');
    if (running && Number.isFinite(startedAt) && startedAt > 0) out.startedAt = startedAt;
    if (!running && Number.isFinite(finishedAt) && finishedAt > 0) out.finishedAt = finishedAt;
    if (!running && Number.isFinite(Number(st.ExitCode))) out.exitCode = Number(st.ExitCode);
    if (Number.isFinite(Number(inspected.RestartCount))) out.restarts = Number(inspected.RestartCount);
    const created = Date.parse(inspected.Created || '');
    if (Number.isFinite(created) && created > 0) out.createdAt = created;
  }
  if (stat) {
    out.cpuPct = Math.max(0, stat.cpu);
    out.memBytes = stat.memUsed;
    if (Number(stat.memLimit) > 0) out.memLimitBytes = stat.memLimit;
  }
  return { v: 1, docker: 'available', container: out };
}

/** Bounded safe event summaries. `after` is a unix-second cursor; `limit` is capped. */
export async function eventsDto(afterSeconds, limit) {
  // Use a container-list check to distinguish daemon failure from an empty event history.
  if (!Array.isArray(await listContainers())) return { v: 1, docker: 'unavailable' };
  const events = await recentEvents(24, MAX_EVENTS);
  if (events === 'blocked' || !Array.isArray(events)) return { v: 1, docker: 'unavailable' };
  const after = Number.isSafeInteger(afterSeconds) && afterSeconds > 0 ? afterSeconds : 0;
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_EVENTS) : 50;
  const rows = events
    .filter((e) => Number(e.time) > after)
    .slice(0, cap)
    .map((e) => ({ time: Number(e.time), type: String(e.type || ''), action: String(e.action || '').slice(0, 64), name: name(e.name), exitCode: e.exitCode === '' ? null : String(e.exitCode).slice(0, 8) }));
  return { v: 1, docker: 'available', events: rows, cursor: rows.length ? rows[0].time : after };
}
