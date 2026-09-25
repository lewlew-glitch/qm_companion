// Secret webhook intake on the plain listener.

import { config } from '../config.js';
import { json } from '../http.js';
import { createLimiter } from '../mobile/ratelimit.js';
import { findAlertSource } from './store.js';
import { readAlertBody, parseWebhookBody } from './body.js';
import { parseAlert } from './parsers.js';
import { prepareAlert, dispatchAlert } from './runtime.js';

const limiter = createLimiter({ windowMs: 60_000, max: 60 });
const requestLimiter = createLimiter({ windowMs: 60_000, max: 8192 });

function limited(res, verdict) {
  return json(res, 429, { error: 'too many requests' }, { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) });
}

export async function handleAlertIntake(req, res, path) {
  const match = /^\/hooks\/([A-Za-z0-9_-]{43})$/.exec(path);
  if (!config.alertsEnabled || !match) return json(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
  // Leave room for every source's full allowance across window boundaries.
  const requests = requestLimiter.hit('hooks');
  if (requests.limited) return limited(res, requests);
  try {
    const source = findAlertSource(match[1]);
    if (!source) return json(res, 404, { error: 'not found' });
    const verdict = limiter.hit(source.id);
    if (verdict.limited) return limited(res, verdict);
    const body = await readAlertBody(req, 1024 * 1024);
    if (!body.ok) return json(res, body.status, { error: body.status === 413 ? 'body too large' : 'invalid request' });
    const parsed = parseAlert(source.kind, await parseWebhookBody(body.body, req.headers['content-type'], source.kind), source.label);
    // Rotation or removal while reading invalidates the old address.
    if (!findAlertSource(match[1])) return json(res, 404, { error: 'not found' });
    const pending = prepareAlert(source.id, parsed);
    json(res, 200, { ok: true });
    if (pending) dispatchAlert(pending).catch(() => {});
  } catch {
    if (!res.headersSent) json(res, 503, { error: 'alerts unavailable' });
  }
}

export function resetAlertIntakeLimiterForTest() {
  limiter.reset();
  requestLimiter.reset();
}
