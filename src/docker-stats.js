// Share bounded, one-shot resource samples across the browser views.

const CACHE_MS = 10_000;
const RESTART_CACHE_MS = 30_000;
const CONCURRENCY = 4;

export function cpuPercent(current, previous) {
  const total = current?.cpu_usage?.total_usage;
  const system = current?.system_cpu_usage;
  const oldTotal = previous?.cpu_usage?.total_usage;
  const oldSystem = previous?.system_cpu_usage;
  if (![total, system, oldTotal, oldSystem].every(Number.isFinite)) return null;
  const delta = total - oldTotal;
  const systemDelta = system - oldSystem;
  if (delta < 0 || systemDelta <= 0) return null;
  const cores = current.online_cpus || current.cpu_usage.percpu_usage?.length || 1;
  return delta / systemDelta * cores * 100;
}

function resourceSample(container, sample, previous) {
  const memory = sample.memory_stats || {};
  const memUsed = Math.max(0, (memory.usage || 0) - (memory.stats?.inactive_file || 0));
  const memLimit = memory.limit || 0;
  const net = { rx: 0, tx: 0 };
  for (const network of Object.values(sample.networks || {})) {
    net.rx += network.rx_bytes || 0;
    net.tx += network.tx_bytes || 0;
  }
  const disk = { read: 0, write: 0 };
  for (const entry of sample.blkio_stats?.io_service_bytes_recursive || []) {
    if (/^read$/i.test(entry.op)) disk.read += entry.value || 0;
    else if (/^write$/i.test(entry.op)) disk.write += entry.value || 0;
  }
  return {
    id: container.id, name: container.name, kind: container.kind,
    cpu: cpuPercent(sample.cpu_stats, previous),
    mem: memLimit ? memUsed / memLimit * 100 : 0,
    memUsed, memLimit, net, disk,
  };
}

export function createContainerStatsReader({ listContainers, request, now = Date.now }) {
  let at = -Infinity, cached = null, inFlight = null;
  let previous = new Map(), restarts = new Map(), restartAt = -Infinity;

  async function collect() {
    const list = await listContainers();
    if (!list) {
      previous.clear();
      return null;
    }
    const running = list.filter((container) => container.state === 'running');
    const refreshRestarts = now() - restartAt >= RESTART_CACHE_MS;
    const nextSamples = new Map(), nextRestarts = new Map(), stats = [];
    let cursor = 0;
    async function worker() {
      while (cursor < running.length) {
        const container = running[cursor++];
        const { status, json } = await request('GET', `/containers/${container.id}/stats?stream=false&one-shot=true`);
        if (refreshRestarts || !restarts.has(container.id)) {
          const inspected = await request('GET', `/containers/${container.id}/json`);
          if (inspected.status >= 200 && inspected.status < 300 && Number.isFinite(inspected.json?.RestartCount)) {
            nextRestarts.set(container.id, inspected.json.RestartCount);
          } else nextRestarts.set(container.id, null);
        } else {
          nextRestarts.set(container.id, restarts.get(container.id));
        }
        if (status < 200 || status >= 300 || !json?.cpu_stats?.cpu_usage) continue;
        const sample = resourceSample(container, json, previous.get(container.id));
        nextSamples.set(container.id, json.cpu_stats);
        stats.push({ ...sample, restarts: nextRestarts.get(container.id) ?? null });
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, running.length) }, worker));
    previous = nextSamples;
    restarts = nextRestarts;
    if (refreshRestarts) restartAt = now();
    stats.sort((a, b) => a.name.localeCompare(b.name));
    return { stats, running: running.length, unavailable: running.length - stats.length };
  }

  return function read() {
    if (inFlight) return inFlight;
    if (now() - at < CACHE_MS) return Promise.resolve(cached);
    inFlight = collect().catch(() => {
      previous.clear();
      return null;
    }).then((value) => {
      cached = value;
      at = now();
      return value;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
}
