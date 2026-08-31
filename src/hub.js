// Shared live channel with bounded polling and per-topic deduplication.

const PING_MS = 20_000;
// Poll intervals by topic while listeners are present.
const CADENCE = { counts: 2_000, events: 3_000, updates: 30_000 };

export const HUB_TOPICS = Object.keys(CADENCE);
export const HUB_MAX_CLIENTS = 16;
export const HUB_MAX_PER_SESSION = 6;

// Canonicalize object keys so equivalent payloads compare equal.
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function createHub({ fetchers = {}, timers = {} } = {}) {
  const t = { setInterval, clearInterval, ...timers };
  const clients = new Set(); // { topics: Set, sessionDigest, write }
  const topics = new Map(HUB_TOPICS.map((name) => [name, { timer: null, busy: false, hash: '', data: '' }]));
  let ping = null;

  function listeners(name) {
    let n = 0;
    for (const c of clients) if (c.topics.has(name)) n += 1;
    return n;
  }

  function say(client, frame) {
    try { client.write(frame); } catch { /* a dead pipe gets removed by its own close handler */ }
  }

  function emit(name, data) {
    const frame = `event: ${name}\ndata: ${data}\n\n`;
    for (const c of clients) if (c.topics.has(name)) say(c, frame);
  }

  async function poll(name) {
    const s = topics.get(name);
    if (s.busy) return;
    s.busy = true;
    try {
      const fetchFn = fetchers[name];
      const payload = fetchFn ? await fetchFn() : null;
      // A null result does not change the last published state.
      if (payload == null) return;
      const hash = stableJson(payload);
      if (hash === s.hash) return;
      s.hash = hash;
      s.data = JSON.stringify(payload);
      emit(name, s.data);
    } catch {
      /* Keep polling after a failed fetch. */
    } finally {
      s.busy = false;
    }
  }

  function start(name) {
    const s = topics.get(name);
    if (s.timer) return;
    s.timer = t.setInterval(() => poll(name), CADENCE[name]);
    if (s.timer && s.timer.unref) s.timer.unref();
    poll(name); // Poll immediately before starting the interval.
  }

  function stop(name) {
    const s = topics.get(name);
    if (!s.timer) return;
    t.clearInterval(s.timer);
    s.timer = null;
    // Clear cached payload when the last listener leaves.
    s.hash = '';
    s.data = '';
  }

  // Check capacity before sending SSE headers.
  function full(sessionDigest) {
    if (clients.size >= HUB_MAX_CLIENTS) return true;
    let mine = 0;
    for (const c of clients) if (c.sessionDigest === sessionDigest) mine += 1;
    return mine >= HUB_MAX_PER_SESSION;
  }

  // Return an unsubscribe function, or null at capacity.
  function subscribe({ topics: names = HUB_TOPICS, sessionDigest = '', write }) {
    if (full(sessionDigest)) return null;
    const wanted = new Set(names.filter((n) => topics.has(n)));
    if (!wanted.size) return null;
    const client = { topics: wanted, sessionDigest, write };
    clients.add(client);
    if (!ping) {
      ping = t.setInterval(() => { for (const c of clients) say(c, ': ping\n\n'); }, PING_MS);
      if (ping && ping.unref) ping.unref();
    }
    for (const name of wanted) {
      const s = topics.get(name);
      // Replay the current answer to new listeners on an active topic.
      if (s.data) say(client, `event: ${name}\ndata: ${s.data}\n\n`);
      start(name);
    }
    let gone = false;
    return function leave() {
      if (gone) return;
      gone = true;
      clients.delete(client);
      for (const name of wanted) if (!listeners(name)) stop(name);
      if (!clients.size && ping) {
        t.clearInterval(ping);
        ping = null;
      }
    };
  }

  return { subscribe, full, clientCount: () => clients.size, poll };
}
