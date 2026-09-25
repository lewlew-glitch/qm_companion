// Bounded Expo delivery and receipt collection for registered phones.

import { setTimeout as delay } from 'node:timers/promises';

import { config } from '../config.js';
import { alertDeviceAllowed } from '../mobile/devices.js';
import { loadMobileState } from '../mobile/store.js';
import { fetchTextBounded } from '../net.js';
import { loadAlertsState, updateAlertsState } from './store.js';

const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const RESPONSE_BYTES = 256 * 1024;
const RECEIPT_AGE_MS = 15 * 60 * 1000;
const RECEIPT_EXPIRY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const HEADERS = Object.freeze({
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': 'Quartermaster-Companion',
});
const INTERRUPTION_LEVELS = Object.freeze({ active: 'active', passive: 'passive', timeSensitive: 'time-sensitive' });
const EXPO_ERROR_CODES = Object.freeze([
  'DeviceNotRegistered', 'MessageTooBig', 'MessageRateExceeded', 'MismatchSenderId',
  'InvalidCredentials', 'DeveloperError', 'PUSH_TOO_MANY_NOTIFICATIONS',
  'PUSH_TOO_MANY_RECEIPTS', 'PUSH_TOO_MANY_EXPERIENCE_IDS', 'UNAUTHORIZED',
]);
const NETWORK_ERROR_CODES = Object.freeze([
  'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND',
  'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const FAILURE_CODES = Object.freeze(['NetworkError', 'Timeout', 'ResponseTooLarge', 'InvalidResponse', 'DeliveryFailed']);

function expoCode(value, fallback = 'DeliveryFailed') {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function messageFor(device, { source, parsed, rule, record }, companion) {
  const data = { alertId: record.id, companion };
  for (const [key, value] of Object.entries({
    kind: parsed.data?.kind,
    sourceServiceId: source?.serviceId,
    target: parsed.data?.target,
    downloadId: parsed.data?.downloadId,
  })) {
    if (value !== null && value !== undefined && value !== '' &&
        (typeof value !== 'object' || Object.keys(value).length > 0)) data[key] = value;
  }
  return {
    to: device.expoToken,
    title: record.title,
    body: record.body,
    sound: rule.sound ? 'default' : null,
    priority: rule.level === 'passive' ? 'normal' : 'high',
    interruptionLevel: INTERRUPTION_LEVELS[rule.level] || 'active',
    ttl: 86400,
    data,
  };
}

export function createAlertDelivery({
  fetchImpl = globalThis.fetch,
  wait = delay,
  now = Date.now,
  loadState = loadAlertsState,
  updateState = updateAlertsState,
  loadMobile = loadMobileState,
  allowDevice = alertDeviceAllowed,
  settings = config,
  timeoutMs = 10_000,
  log = (line) => process.stdout.write(line),
} = {}) {
  let lastLogAt = -Infinity;
  let checkingReceipts = false;

  function logFailure(detail, status) {
    const at = now();
    if (at - lastLogAt < 60_000) return;
    lastLogAt = at;
    const code = Number.isInteger(status) ? String(status) :
      [...EXPO_ERROR_CODES, ...NETWORK_ERROR_CODES, ...FAILURE_CODES].includes(detail) ? detail : 'DeliveryFailed';
    log(`  alerts: delivery failed (${code})\n`);
  }

  function authority() {
    const mobile = loadMobile();
    const allowed = new Set(mobile.devices.filter((device) => allowDevice(device, now())).map((device) => device.deviceId));
    return { companion: mobile.mobileInstallationId, allowed };
  }

  async function request(url, body) {
    if (new URL(url).protocol !== 'https:') return { ok: false, detail: 'DeliveryFailed', retry: false };
    let response;
    let text;
    try {
      ({ response, text } = await fetchTextBounded(url, {
        method: 'POST', headers: HEADERS, body: JSON.stringify(body),
      }, {
        fetchImpl: async (...args) => {
          // Keep the status if bounded body reading throws.
          response = await fetchImpl(...args);
          return response;
        },
        timeoutMs,
        maxBytes: RESPONSE_BYTES,
        redirect: 'manual',
      }));
    } catch (error) {
      const code = error.cause?.code || error.code;
      const detail = error.message === 'response too large' ? 'ResponseTooLarge' :
        error.message === 'response body is not safely streamable' ? 'InvalidResponse' :
        error.name === 'AbortError' ? 'Timeout' : NETWORK_ERROR_CODES.includes(code) ? code : 'NetworkError';
      const status = response?.status;
      const retry = status >= 300 ? status >= 500 && status <= 599 :
        detail !== 'ResponseTooLarge' && detail !== 'InvalidResponse';
      return { ok: false, detail, retry, ...(Number.isInteger(status) ? { status } : {}) };
    }
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (!response.ok) {
      return {
        ok: false,
        detail: expoCode(payload?.errors?.[0]?.code, `HTTP_${response.status}`),
        status: response.status,
        retry: response.status >= 500 && response.status <= 599,
      };
    }
    if (!payload || typeof payload !== 'object') return { ok: false, detail: 'InvalidResponse', retry: false };
    return { ok: true, payload };
  }

  async function requestWithRetry(url, prepare) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!settings.alertsEnabled) return { result: { ok: false, detail: 'disabled' }, context: null };
      const context = prepare();
      if (!context) return { result: { ok: false, detail: 'not-registered' }, context: null };
      const result = await request(url, context.body);
      if (result.ok || !result.retry || attempt === 1) return { result, context };
      await wait(RETRY_MS);
    }
  }

  function saveTickets(context, result) {
    const tickets = result.ok && Array.isArray(result.payload.data) ? result.payload.data : [];
    let accepted = false;
    let detail = result.ok ? 'InvalidResponse' : result.detail;
    const { allowed } = authority();
    const at = now();
    updateState((state) => {
      for (const [index, sent] of context.devices.entries()) {
        const ticket = tickets[index];
        const good = ticket?.status === 'ok' && typeof ticket.id === 'string' && ticket.id.length > 0 && ticket.id.length <= 256;
        if (good) accepted = true;
        else {
          detail = result.ok ? expoCode(ticket?.details?.error, 'InvalidResponse') : result.detail;
          logFailure(detail, result.status);
        }
        const device = state.devices.find((entry) => entry.deviceId === sent.deviceId && entry.expoToken === sent.expoToken);
        if (!device || !allowed.has(device.deviceId)) continue;
        if (good) {
          device.lastResult = 'ok';
          device.lastSentAt = at;
          if (!state.receipts.some((receipt) => receipt.id === ticket.id)) {
            state.receipts.push({ id: ticket.id, deviceId: device.deviceId, at });
          }
        } else if (ticket?.details?.error === 'DeviceNotRegistered') {
          state.devices = state.devices.filter((entry) => entry.deviceId !== device.deviceId);
          state.receipts = state.receipts.filter((receipt) => receipt.deviceId !== device.deviceId);
        } else {
          device.lastResult = 'failed';
        }
      }
    });
    return accepted ? { ok: true } : { ok: false, detail };
  }

  async function deliverAlert(input) {
    if (!settings.alertsEnabled) return { ok: false, detail: 'disabled' };
    const initial = loadState().devices.filter((device) => !input.deviceId || device.deviceId === input.deviceId);
    let accepted = false;
    let detail = 'not-registered';
    for (let offset = 0; offset < initial.length; offset += 100) {
      const ids = new Set(initial.slice(offset, offset + 100).map((device) => device.deviceId));
      const { context, result } = await requestWithRetry(settings.alertsPushUrl, () => {
        const { companion, allowed } = authority();
        const devices = loadState().devices.filter((device) => ids.has(device.deviceId) && allowed.has(device.deviceId));
        return devices.length ? { devices, body: devices.map((device) => messageFor(device, input, companion)) } : null;
      });
      const outcome = context ? saveTickets(context, result) : result;
      accepted ||= outcome.ok;
      if (outcome.detail) detail = outcome.detail;
    }
    return accepted ? { ok: true } : { ok: false, detail };
  }

  async function checkAlertReceipts() {
    if (!settings.alertsEnabled || checkingReceipts) return;
    checkingReceipts = true;
    try {
      const at = now();
      const state = loadState();
      if (!state.receipts.length) return;
      const { allowed } = authority();
      const registered = new Set(state.devices.map((device) => device.deviceId));
      const expired = state.receipts.filter((receipt) => at - receipt.at >= RECEIPT_EXPIRY_MS ||
        !allowed.has(receipt.deviceId) || !registered.has(receipt.deviceId));
      if (expired.length) {
        const ids = new Set(expired.map((receipt) => receipt.id));
        updateState((current) => { current.receipts = current.receipts.filter((receipt) => !ids.has(receipt.id)); });
      }
      const ids = new Set(state.receipts.filter((receipt) => at - receipt.at >= RECEIPT_AGE_MS &&
        at - receipt.at < RECEIPT_EXPIRY_MS && allowed.has(receipt.deviceId) && registered.has(receipt.deviceId))
        .slice(0, 1000).map((receipt) => receipt.id));
      if (!ids.size) return;
      const { context, result } = await requestWithRetry(RECEIPTS_URL, () => {
        const live = authority();
        const current = loadState();
        const devices = current.devices.filter((device) => live.allowed.has(device.deviceId));
        const deviceIds = new Set(devices.map((device) => device.deviceId));
        const receipts = current.receipts.filter((receipt) => ids.has(receipt.id) && deviceIds.has(receipt.deviceId));
        return receipts.length ? { devices, receipts, body: { ids: receipts.map((receipt) => receipt.id) } } : null;
      });
      if (!context) return;
      if (!result.ok) logFailure(result.detail, result.status);
      const receipts = result.ok && result.payload.data && typeof result.payload.data === 'object' &&
        !Array.isArray(result.payload.data) ? result.payload.data : {};
      const checked = new Set(context.receipts.map((receipt) => receipt.id));
      updateState((current) => {
        const removed = new Set();
        for (const receipt of context.receipts) {
          if (!current.receipts.some((entry) => entry.id === receipt.id)) continue;
          const outcome = Object.hasOwn(receipts, receipt.id) ? receipts[receipt.id] : null;
          if (outcome?.status !== 'error') continue;
          logFailure(expoCode(outcome.details?.error));
          if (outcome.details?.error !== 'DeviceNotRegistered') continue;
          const sent = context.devices.find((device) => device.deviceId === receipt.deviceId);
          if (current.devices.some((device) => device.deviceId === sent.deviceId && device.expoToken === sent.expoToken)) removed.add(sent.deviceId);
          current.devices = current.devices.filter((device) => device.deviceId !== sent.deviceId || device.expoToken !== sent.expoToken);
        }
        current.receipts = current.receipts.filter((receipt) => !checked.has(receipt.id) && !removed.has(receipt.deviceId));
      });
    } finally {
      checkingReceipts = false;
    }
  }

  return { deliverAlert, checkAlertReceipts };
}

const delivery = createAlertDelivery();
export const deliverAlert = delivery.deliverAlert;
export const checkAlertReceipts = delivery.checkAlertReceipts;
