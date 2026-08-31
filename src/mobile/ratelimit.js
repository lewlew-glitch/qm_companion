// Bounded fixed-window counters keyed by source, enrolment, or token digest.

const MAX_KEYS = 20_000;

export function createLimiter({ windowMs, max }) {
  const hits = new Map();
  return {
    hit(key, at = Date.now()) {
      const k = String(key || 'unknown').slice(0, 160);
      const rec = hits.get(k);
      if (!rec || at >= rec.resetAt) {
        if (hits.size >= MAX_KEYS) {
          for (const [candidate, value] of hits) if (at >= value.resetAt) hits.delete(candidate);
          if (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value);
        }
        hits.set(k, { count: 1, resetAt: at + windowMs });
        return { limited: false, retryAfterMs: 0 };
      }
      rec.count += 1;
      return { limited: rec.count > max, retryAfterMs: rec.resetAt - at };
    },
    reset() {
      hits.clear();
    },
  };
}
