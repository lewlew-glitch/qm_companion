// Refresh storage on demand and return cached values while Docker is measuring.
// Docker walks every container layer and volume to size them, so only the first read and an explicit
// refresh ask for those. Later background reads ask for images and build cache alone.

const CACHE_MS = 10 * 60_000;
const FORCE_MIN_MS = 30_000;
const FULL = '/system/df';
const LIGHT = '/system/df?type=image&type=build-cache';
const bytes = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
const sum = (rows, pick) => (Array.isArray(rows) ? rows : []).reduce((total, row) => total + bytes(pick(row)), 0);

export function createDiskUsageCache({ request, now = Date.now }) {
  let at = -Infinity, fullAt = -Infinity, cached = null, measured = null, inFlight = null, full = false, typed = true;

  async function collect(light) {
    const { status, json } = await request('GET', light ? LIGHT : FULL);
    if (status === 403) return 'blocked';
    if (status < 200 || status >= 300 || !json || typeof json !== 'object' || Array.isArray(json)) return null;
    const images = Number.isFinite(json.LayersSize) ? bytes(json.LayersSize) : sum(json.Images, (image) => image?.Size);
    const build = sum(json.BuildCache, (entry) => entry?.Size);
    // Docker before API 1.42 ignores the type filter and answers in full.
    if (light && !Array.isArray(json.Containers) && !Array.isArray(json.Volumes)) {
      const disk = { ...measured.disk, images, build };
      disk.total = disk.images + disk.containers + disk.volumes + disk.build;
      return { volumes: measured.volumes, disk, measuredAt: measured.measuredAt };
    }
    if (light) typed = false;
    const volumes = Object.create(null);
    for (const volume of Array.isArray(json.Volumes) ? json.Volumes : []) {
      if (!volume || typeof volume.Name !== 'string' || !volume.Name) continue;
      const size = volume.UsageData?.Size;
      volumes[volume.Name] = { size: Number.isFinite(size) ? size : -1 };
    }
    const disk = {
      images,
      containers: sum(json.Containers, (container) => container?.SizeRw),
      volumes: sum(json.Volumes, (volume) => volume?.UsageData?.Size),
      build,
    };
    disk.total = disk.images + disk.containers + disk.volumes + disk.build;
    measured = { volumes, disk, measuredAt: now() };
    return measured;
  }

  function start(light) {
    full = !light;
    inFlight = collect(light).catch(() => null).then((value) => {
      cached = value;
      at = now();
      if (!light) fullAt = at;
      return value;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function refresh(force = false) {
    if (inFlight && full) return inFlight;
    if (now() - fullAt < (force ? FORCE_MIN_MS : CACHE_MS)) return Promise.resolve(cached);
    return inFlight ? inFlight.then(() => refresh(force)) : start(false);
  }

  return {
    read() {
      if (!inFlight && now() - at >= CACHE_MS && (!measured || typed)) start(!!measured);
      return cached;
    },
    refresh,
  };
}
