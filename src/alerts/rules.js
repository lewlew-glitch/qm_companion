// Alert conditions, wording and admission to delivery.

import { randomBytes } from 'node:crypto';

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]{0,31})\}/g;

function field(fields, name) {
  return Object.hasOwn(fields, name) && typeof fields[name] === 'string' ? fields[name] : '';
}

export function renderTemplate(template, fields) {
  return template.replace(PLACEHOLDER, (_match, name) => field(fields, name))
    .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/^\n+|\n+$/g, '');
}

export function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function matchesCondition(condition, fields) {
  const actual = field(fields, condition.field).trim();
  const expected = condition.value.trim();
  const a = actual.toLowerCase();
  const b = expected.toLowerCase();
  switch (condition.op) {
    case 'is': return a === b;
    case 'isNot': return a !== b;
    case 'contains': return a.includes(b);
    case 'notContains': return !a.includes(b);
    case 'atLeast':
    case 'atMost': {
      if (!/^-?\d+(\.\d+)?$/.test(actual) || !/^-?\d+(\.\d+)?$/.test(expected)) return false;
      return condition.op === 'atLeast' ? Number(actual) >= Number(expected) : Number(actual) <= Number(expected);
    }
    default: return false;
  }
}

export function evaluateAlert(source, parsed, { now, throttle, hasDevices }) {
  const rule = Object.hasOwn(source.events, parsed.event) ? source.events[parsed.event] : null;
  if (!rule || !rule.on) return { record: null, send: false };
  const record = {
    id: `al_${randomBytes(12).toString('base64url')}`, at: now, sourceId: source.id, event: parsed.event,
    title: clip(parsed.title, 120), body: clip(parsed.body, 1000), outcome: 'failed',
  };
  if (!rule.when.every((condition) => matchesCondition(condition, parsed.fields))) {
    record.outcome = 'filtered';
    return { record, send: false };
  }
  const key = `${source.id}:${parsed.event}`;
  if (rule.throttleMinutes > 0 && Object.hasOwn(throttle, key) && now - throttle[key] < rule.throttleMinutes * 60_000) {
    record.outcome = 'throttled';
    return { record, send: false };
  }
  throttle[key] = now;
  record.title = clip((rule.title ? renderTemplate(rule.title, parsed.fields) : '') || parsed.title, 120);
  record.body = clip((rule.body ? renderTemplate(rule.body, parsed.fields) : '') || parsed.body, 1000);
  if (rule.historyOnly) {
    record.outcome = 'historyOnly';
    return { record, send: false };
  }
  if (!hasDevices) {
    record.outcome = 'noDevices';
    return { record, send: false };
  }
  return { record, send: true };
}
