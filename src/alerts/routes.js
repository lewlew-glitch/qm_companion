// Bearer-authenticated alert settings, sources and history.

import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { json } from '../http.js';
import { addAudit } from '../store.js';
import { authenticateAccess } from '../mobile/devices.js';
import { createLimiter } from '../mobile/ratelimit.js';
import { alertIntakeAddress } from './address.js';
import { readAlertBody } from './body.js';
import { deliverAlert } from './delivery.js';
import { ALERT_KINDS, defaultEventRules, validateEventRules } from './schema.js';
import { loadAlertsState, updateAlertsState, removeAlertsDevice } from './store.js';

const PREFIX = '/api/mobile/v1/alerts';
const SOURCE_ID = /^src_[A-Za-z0-9_-]{22}$/;
const HISTORY_ID = /^al_[A-Za-z0-9_-]{16}$/;
const TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$/;
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SOURCE_NAMES = Object.freeze({ sonarr: 'Sonarr', radarr: 'Radarr', seerr: 'Seerr', tracearr: 'Tracearr', uptimekuma: 'Uptime Kuma', custom: 'a custom source' });
const limiter = createLimiter({ windowMs: 60_000, max: 60 });

function fail(res, status, code, message) {
  return json(res, status, { v: 1, error: { code, message } });
}

function invalid(res) {
  return fail(res, 400, 'invalid_request', 'Check the request fields and try again.');
}

function exact(body, keys, required = []) {
  return body && Object.getPrototypeOf(body) === Object.prototype && body.v === 1 &&
    Object.keys(body).every((key) => key === 'v' || keys.includes(key)) && required.every((key) => Object.hasOwn(body, key));
}

function labelValid(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 64;
}

function sourceView(source, baseUrl) {
  const { secret, ...view } = source;
  return { ...view, intakeUrl: baseUrl ? `${baseUrl}/hooks/${secret}` : null };
}

export function createAlertsRouter({ address = alertIntakeAddress, deliver = deliverAlert } = {}) {
  return async function handle(req, res, url) {
    const auth = authenticateAccess(req.headers.authorization, 'events.read');
    if (!auth.ok) return fail(res, auth.status, auth.code, auth.message);
    function authorised() {
      const current = authenticateAccess(req.headers.authorization, 'events.read');
      if (!current.ok) fail(res, current.status, current.code, current.message);
      return current.ok;
    }
    const verdict = limiter.hit(auth.device.deviceId);
    if (verdict.limited) return json(res, 429, { v: 1, error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' } }, { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) });
    const path = url.pathname.slice(PREFIX.length);
    const overview = path === '' && req.method === 'GET';
    if (!config.alertsEnabled && !overview) return fail(res, 403, 'alerts_disabled', 'Alerts are switched off on this Companion.');
    try {
      const state = loadAlertsState();
      const deviceId = auth.device.deviceId;
      if (overview) {
        const intake = await address();
        if (!authorised()) return;
        const current = loadAlertsState();
        const device = current.devices.find((item) => item.deviceId === deviceId);
        return json(res, 200, {
          v: 1, enabled: config.alertsEnabled, intake,
          device: { registered: Boolean(device), lastSentAt: device?.lastSentAt ?? null, lastResult: device?.lastResult ?? null },
          sources: current.sources.map((source) => sourceView(source, intake.baseUrl)),
        });
      }
      const one = /^\/sources\/(src_[A-Za-z0-9_-]{22})(?:\/(rotate|delete|sample))?$/.exec(path);
      if (req.method === 'GET' && one?.[2] === 'sample') {
        if (!state.sources.some((source) => source.id === one[1])) return fail(res, 404, 'not_found', 'No such alert source.');
        return json(res, 200, { v: 1, events: state.samples[one[1]] || [] });
      }
      if (req.method === 'GET' && path === '/history') {
        const count = url.searchParams.get('limit');
        const before = url.searchParams.get('before');
        if (count !== null && (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 200)) return invalid(res);
        if (before !== null && !HISTORY_ID.test(before)) return invalid(res);
        const limit = count === null ? 50 : Number(count);
        const found = before === null ? -1 : state.history.findIndex((item) => item.id === before);
        const start = before !== null && found < 0 ? state.history.length : found + 1;
        const items = state.history.slice(start, start + limit);
        return json(res, 200, { v: 1, items, next: start + items.length < state.history.length ? items.at(-1).id : null });
      }
      if (req.method !== 'POST' || !['/device', '/device/forget', '/sources', '/test'].includes(path) && (!one || one[2] === 'sample')) {
        return fail(res, 404, 'not_found', 'No such route.');
      }
      if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return invalid(res);
      const read = await readAlertBody(req, 64 * 1024);
      if (!read.ok) return fail(res, read.status, 'invalid_request', 'The request body could not be read.');
      if (!authorised()) return;
      let body;
      try { body = JSON.parse(read.body.toString('utf8')); } catch { return invalid(res); }
      let intake;
      if (path === '/sources' || one && one[2] !== 'delete') {
        intake = await address();
        if (!authorised()) return;
      }
      if (path === '/device') {
        if (!exact(body, ['expoToken', 'name'], ['expoToken']) || typeof body.expoToken !== 'string' || !TOKEN.test(body.expoToken) ||
          Object.hasOwn(body, 'name') && !labelValid(body.name)) return invalid(res);
        updateAlertsState((next) => {
          const previous = next.devices.find((item) => item.deviceId === deviceId);
          if (previous?.expoToken !== body.expoToken) next.receipts = next.receipts.filter((item) => item.deviceId !== deviceId);
          next.devices = next.devices.filter((item) => item.deviceId !== deviceId);
          next.devices.push({ deviceId, expoToken: body.expoToken, name: body.name ?? null, registeredAt: Date.now(), lastSentAt: previous?.lastSentAt ?? null, lastResult: previous?.lastResult ?? null });
        });
        return json(res, 200, { v: 1, registered: true });
      }
      if (path === '/device/forget') {
        if (!exact(body, [])) return invalid(res);
        removeAlertsDevice(deviceId);
        return json(res, 200, { v: 1, registered: false });
      }
      if (path === '/sources') {
        if (!exact(body, ['kind', 'label', 'serviceId', 'events'], ['kind', 'label']) || !ALERT_KINDS.includes(body.kind) || !labelValid(body.label) ||
          Object.hasOwn(body, 'serviceId') && (typeof body.serviceId !== 'string' || body.serviceId.length > 128 || !SERVICE_ID.test(body.serviceId)) ||
          Object.hasOwn(body, 'events') && !validateEventRules(body.kind, body.events)) return invalid(res);
        if (loadAlertsState().sources.length >= 64) return fail(res, 409, 'source_limit', 'Remove an alert source before adding another.');
        const source = {
          id: `src_${randomBytes(16).toString('base64url')}`, kind: body.kind, serviceId: body.serviceId ?? null,
          label: body.label, secret: randomBytes(32).toString('base64url'), createdAt: Date.now(), lastEventAt: null, lastTestAt: null,
          events: { ...defaultEventRules(body.kind), ...body.events },
        };
        updateAlertsState((next) => { next.sources.push(source); });
        addAudit(`created an alert source for ${SOURCE_NAMES[source.kind]}`);
        return json(res, 200, { v: 1, source: sourceView(source, intake.baseUrl) });
      }
      if (one) {
        const source = loadAlertsState().sources.find((item) => item.id === one[1]);
        if (!source) return fail(res, 404, 'not_found', 'No such alert source.');
        const action = one[2];
        if (!exact(body, action ? [] : ['label', 'events']) ||
          Object.hasOwn(body, 'label') && !labelValid(body.label) ||
          Object.hasOwn(body, 'events') && !validateEventRules(source.kind, body.events)) return invalid(res);
        let saved;
        updateAlertsState((next) => {
          const item = next.sources.find((entry) => entry.id === source.id);
          if (action === 'delete') next.sources = next.sources.filter((entry) => entry.id !== source.id);
          else {
            if (action === 'rotate') item.secret = randomBytes(32).toString('base64url');
            if (Object.hasOwn(body, 'label')) item.label = body.label;
            if (body.events) Object.assign(item.events, body.events);
            saved = structuredClone(item);
          }
        });
        if (action === 'delete') {
          addAudit(`removed an alert source for ${SOURCE_NAMES[source.kind]}`);
          return json(res, 200, { v: 1 });
        }
        if (action === 'rotate') addAudit(`gave an alert source for ${SOURCE_NAMES[source.kind]} a new address`);
        return json(res, 200, { v: 1, source: sourceView(saved, intake.baseUrl) });
      }
      if (!exact(body, ['sourceId']) || Object.hasOwn(body, 'sourceId') && (typeof body.sourceId !== 'string' || !SOURCE_ID.test(body.sourceId))) return invalid(res);
      const current = loadAlertsState();
      const source = body.sourceId ? current.sources.find((item) => item.id === body.sourceId) : null;
      if (body.sourceId && !source) return fail(res, 404, 'not_found', 'No such alert source.');
      const registered = current.devices.some((item) => item.deviceId === deviceId);
      const record = {
        id: `al_${randomBytes(12).toString('base64url')}`, at: Date.now(), sourceId: source?.id ?? null, event: 'test',
        title: source ? `Test from ${source.label}` : 'Quartermaster',
        body: source ? 'Alerts from this source reach this iPhone.' : 'Alerts from your Companion reach this iPhone.',
        outcome: registered ? 'failed' : 'noDevices',
      };
      updateAlertsState((next) => { next.history.unshift(record); });
      if (!registered) return json(res, 200, { v: 1, result: 'not-registered' });
      const result = await deliver({ source, parsed: { data: {} }, rule: { sound: true, level: 'active' }, record, deviceId });
      updateAlertsState((next) => {
        const item = next.history.find((entry) => entry.id === record.id);
        if (item) item.outcome = result.ok ? 'sent' : 'failed';
      });
      return json(res, 200, { v: 1, result: result.ok ? 'sent' : 'failed', ...(!result.ok ? { detail: result.detail || 'delivery_failed' } : {}) });
    } catch {
      return fail(res, 503, 'alerts_unavailable', 'Alerts are unavailable. Check the alerts data file on this Companion.');
    }
  };
}

export const handleAlertRoute = createAlertsRouter();

export function resetAlertRouteLimiterForTest() {
  limiter.reset();
}
