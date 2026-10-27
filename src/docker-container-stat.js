// Single-container detail reads use one-shot samples and a bounded CPU baseline cache.

import { cpuPercent } from './docker-stats.js';

const SAMPLE_TTL_MS = 60_000;
const MAX_SAMPLES = 256;

export function createContainerStatReader({ request, now = Date.now }) {
  const previous = new Map(), inFlight = new Map();

  function prune(at) {
    for (const [id, sample] of previous) {
      if (at - sample.at >= SAMPLE_TTL_MS) previous.delete(id);
    }
  }

  async function collect(id) {
    try {
      const { status, json } = await request('GET', `/containers/${id}/stats?stream=false&one-shot=true`);
      if (status < 200 || status >= 300 || !json?.cpu_stats?.cpu_usage) {
        previous.delete(id);
        return null;
      }
      const at = now();
      prune(at);
      const cpu = cpuPercent(json.cpu_stats, previous.get(id)?.cpu);
      previous.delete(id);
      previous.set(id, { cpu: json.cpu_stats, at });
      while (previous.size > MAX_SAMPLES) previous.delete(previous.keys().next().value);
      const memory = json.memory_stats || {};
      const memUsed = Math.max(0, (memory.usage || 0) - (memory.stats?.inactive_file || 0));
      return { cpu: Number.isFinite(cpu) ? cpu : null, memUsed, memLimit: memory.limit || 0 };
    } catch {
      previous.delete(id);
      return null;
    }
  }

  return function read(id) {
    if (!/^[a-f0-9]{6,64}$/i.test(id)) return Promise.resolve(null);
    if (inFlight.has(id)) return inFlight.get(id);
    prune(now());
    const pending = collect(id).finally(() => { inFlight.delete(id); });
    inFlight.set(id, pending);
    return pending;
  };
}
