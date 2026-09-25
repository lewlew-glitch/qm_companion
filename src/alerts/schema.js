// Alerts payloads, event vocabularies and default rules.

export const ALERT_KINDS = Object.freeze(['sonarr', 'radarr', 'seerr', 'tracearr', 'uptimekuma', 'custom']);
const SERVARR_EVENTS = Object.freeze(['download', 'grab', 'failed', 'health', 'healthRestored', 'update']);
export const EVENTS_BY_KIND = Object.freeze({
  sonarr: SERVARR_EVENTS,
  radarr: SERVARR_EVENTS,
  seerr: Object.freeze(['requested', 'approved', 'available', 'declined', 'requestFailed', 'issue']),
  tracearr: Object.freeze(['violation', 'serverDown', 'serverUp', 'streamStarted', 'streamStopped']),
  uptimekuma: Object.freeze(['down', 'up']),
  custom: Object.freeze(['message']),
});
const DEFAULT_EVENTS = Object.freeze({
  sonarr: Object.freeze(['download', 'failed', 'health']),
  radarr: Object.freeze(['download', 'failed', 'health']),
  seerr: Object.freeze(['requested', 'approved', 'available']),
  tracearr: Object.freeze(['violation', 'serverDown', 'serverUp']),
  uptimekuma: Object.freeze(['down', 'up']),
  custom: Object.freeze(['message']),
});
const RULE_KEYS = Object.freeze(['on', 'title', 'body', 'when', 'level', 'sound', 'historyOnly', 'throttleMinutes']);
const LEVELS = Object.freeze(['active', 'passive', 'timeSensitive']);
const CONDITION_OPS = Object.freeze(['is', 'isNot', 'contains', 'notContains', 'atLeast', 'atMost']);
const OUTCOMES = Object.freeze(['filtered', 'throttled', 'historyOnly', 'noDevices', 'sent', 'failed']);
const DEVICE_RESULTS = Object.freeze(['ok', 'not-registered', 'failed']);
const HISTORY_EVENTS = Object.freeze([...new Set(Object.values(EVENTS_BY_KIND).flat()), 'test']);
const SOURCE_ID = /^src_[A-Za-z0-9_-]{22}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const HISTORY_ID = /^al_[A-Za-z0-9_-]{16}$/;
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$/;

export const MAX_ALERT_SOURCES = 64;
export const MAX_ALERT_HISTORY = 500;
export const MAX_ALERT_SAMPLES = 5;
export const MAX_ALERT_RECEIPTS = 1000;
export const MAX_ALERTS_STATE_BYTES = 16 * 1024 * 1024;
export const ALERT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

function plain(value) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value, min = 0, max = Infinity) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function matches(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function time(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function optionalTime(value) {
  return value === null || time(value);
}

function validRule(rule) {
  return exact(rule, RULE_KEYS) && typeof rule.on === 'boolean' &&
    (rule.title === null || text(rule.title, 0, 500)) && (rule.body === null || text(rule.body, 0, 500)) &&
    Array.isArray(rule.when) && rule.when.length <= 3 && rule.when.every((condition) =>
      exact(condition, ['field', 'op', 'value']) && text(condition.field, 0, 32) &&
      CONDITION_OPS.includes(condition.op) && text(condition.value, 0, 200)) &&
    LEVELS.includes(rule.level) && typeof rule.sound === 'boolean' && typeof rule.historyOnly === 'boolean' &&
    Number.isInteger(rule.throttleMinutes) && rule.throttleMinutes >= 0 && rule.throttleMinutes <= 1440;
}

export function defaultEventRules(kind) {
  if (!ALERT_KINDS.includes(kind)) throw new TypeError('Unknown alert kind');
  return Object.fromEntries(EVENTS_BY_KIND[kind].map((event) => [event, {
    on: DEFAULT_EVENTS[kind].includes(event), title: null, body: null, when: [],
    level: 'active', sound: true, historyOnly: false, throttleMinutes: 0,
  }]));
}

export function validateEventRules(kind, events) {
  return ALERT_KINDS.includes(kind) && plain(events) &&
    Object.entries(events).every(([event, rule]) => EVENTS_BY_KIND[kind].includes(event) && validRule(rule));
}

function validSource(source) {
  return exact(source, ['id', 'kind', 'serviceId', 'label', 'secret', 'createdAt', 'lastEventAt', 'lastTestAt', 'events']) &&
    matches(source.id, SOURCE_ID) && ALERT_KINDS.includes(source.kind) &&
    (source.serviceId === null || matches(source.serviceId, SERVICE_ID)) && text(source.label, 1, 64) &&
    matches(source.secret, SECRET) && time(source.createdAt) && optionalTime(source.lastEventAt) &&
    optionalTime(source.lastTestAt) && validateEventRules(source.kind, source.events);
}

function validDevice(device) {
  return exact(device, ['deviceId', 'expoToken', 'name', 'registeredAt', 'lastSentAt', 'lastResult']) &&
    text(device.deviceId, 1) && matches(device.expoToken, EXPO_TOKEN) &&
    (device.name === null || text(device.name, 0, 64)) && time(device.registeredAt) &&
    optionalTime(device.lastSentAt) && (device.lastResult === null || DEVICE_RESULTS.includes(device.lastResult));
}

function validHistory(record) {
  return exact(record, ['id', 'at', 'sourceId', 'event', 'title', 'body', 'outcome']) &&
    matches(record.id, HISTORY_ID) && time(record.at) &&
    (matches(record.sourceId, SOURCE_ID) || (record.sourceId === null && record.event === 'test')) &&
    HISTORY_EVENTS.includes(record.event) && text(record.title, 0, 120) && text(record.body, 0, 1000) &&
    OUTCOMES.includes(record.outcome);
}

function validSample(sample, kind) {
  return exact(sample, ['at', 'event', 'fields', 'title', 'body']) && time(sample.at) &&
    EVENTS_BY_KIND[kind].includes(sample.event) && plain(sample.fields) &&
    Object.values(sample.fields).every((value) => text(value)) && text(sample.title) && text(sample.body);
}

function newestFirst(records) {
  return records.every((record, index) => index === 0 || records[index - 1].at >= record.at);
}

function unique(records, key) {
  return new Set(records.map((record) => record[key])).size === records.length;
}

function invalid(message) {
  return { ok: false, code: 'QM_ALERTS_STATE_INVALID', message, status: 503 };
}

export function validateAlertsState(state) {
  if (!exact(state, ['sources', 'devices', 'history', 'samples', 'throttle', 'receipts'])) {
    return invalid('Alerts state has unexpected fields');
  }
  if (!Array.isArray(state.sources) || state.sources.length > MAX_ALERT_SOURCES ||
      !state.sources.every(validSource) || !unique(state.sources, 'id') || !unique(state.sources, 'secret')) {
    return invalid('Alert sources are invalid');
  }
  if (!Array.isArray(state.devices) || !state.devices.every(validDevice) || !unique(state.devices, 'deviceId')) {
    return invalid('Alert devices are invalid');
  }
  if (!Array.isArray(state.history) || state.history.length > MAX_ALERT_HISTORY ||
      !state.history.every(validHistory) || !unique(state.history, 'id') || !newestFirst(state.history)) {
    return invalid('Alert history is invalid');
  }
  if (!plain(state.samples)) return invalid('Alert samples are invalid');
  for (const [id, samples] of Object.entries(state.samples)) {
    const source = state.sources.find((entry) => entry.id === id);
    if (!source || !Array.isArray(samples) || samples.length > MAX_ALERT_SAMPLES ||
        !samples.every((sample) => validSample(sample, source.kind)) || !newestFirst(samples)) {
      return invalid('Alert samples are invalid');
    }
  }
  if (!plain(state.throttle)) return invalid('Alert throttle is invalid');
  for (const [key, at] of Object.entries(state.throttle)) {
    const [sourceId, event, extra] = key.split(':');
    const source = state.sources.find((entry) => entry.id === sourceId);
    if (!source || extra !== undefined || !EVENTS_BY_KIND[source.kind].includes(event) || !time(at)) {
      return invalid('Alert throttle is invalid');
    }
  }
  if (!Array.isArray(state.receipts) || state.receipts.length > MAX_ALERT_RECEIPTS ||
      !state.receipts.every((receipt) => exact(receipt, ['id', 'deviceId', 'at']) &&
        text(receipt.id, 1) && text(receipt.deviceId, 1) && time(receipt.at)) || !unique(state.receipts, 'id')) {
    return invalid('Alert receipts are invalid');
  }
  return { ok: true };
}
