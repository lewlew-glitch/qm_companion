// Discovery dials every default service port on the server, so pages share one sweep a minute.
// Set up and its live poll, and a transfer about to be built, ask for a fresh sweep. Requests that
// arrive together always share one sweep. A failed sweep is never kept.

const FRESH_MS = 60_000;

export function createDiscoveryCache({ gather, now = Date.now }) {
  let at = -Infinity, cached = null, inFlight = null;
  return function discover({ fresh = false } = {}) {
    if (inFlight) return inFlight;
    if (!fresh && cached && now() - at < FRESH_MS) return Promise.resolve(cached);
    inFlight = new Promise((resolve) => resolve(gather())).then((rows) => {
      cached = rows;
      at = now();
      return rows;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
}
