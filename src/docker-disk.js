// Refresh storage on demand and return cached values while Docker is measuring.

const CACHE_MS = 10 * 60_000;
const FORCE_MIN_MS = 30_000;
const bytes = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
const sum = (rows, pick) => (Array.isArray(rows) ? rows : []).reduce((total, row) => total + bytes(pick(row)), 0);

export function createDiskUsageCache({ request, now = Date.now }) {
  let at = -Infinity, cached = null, inFlight = null;

  async function collect() {
    const { status, json } = await request('GET', '/system/df');
    if (status === 403) return 'blocked';
    if (status < 200 || status >= 300 || !json || typeof json !== 'object' || Array.isArray(json)) return null;
    const volumes = Object.create(null);
    for (const volume of Array.isArray(json.Volumes) ? json.Volumes : []) {
      if (!volume || typeof volume.Name !== 'string' || !volume.Name) continue;
      const size = volume.UsageData?.Size;
      volumes[volume.Name] = { size: Number.isFinite(size) ? size : -1 };
    }
    const disk = {
      images: Number.isFinite(json.LayersSize) ? bytes(json.LayersSize) : sum(json.Images, (image) => image?.Size),
      containers: sum(json.Containers, (container) => container?.SizeRw),
      volumes: sum(json.Volumes, (volume) => volume?.UsageData?.Size),
      build: sum(json.BuildCache, (entry) => entry?.Size),
    };
    disk.total = disk.images + disk.containers + disk.volumes + disk.build;
    return { volumes, disk };
  }

  function refresh(force = false) {
    if (inFlight) return inFlight;
    if (now() - at < (force ? FORCE_MIN_MS : CACHE_MS)) return Promise.resolve(cached);
    inFlight = collect().catch(() => null).then((value) => {
      cached = value;
      at = now();
      return value;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    read() {
      if (now() - at >= CACHE_MS) refresh();
      return cached;
    },
    refresh,
  };
}
