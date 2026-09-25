// Record accepted events before attempting push delivery.

import { config } from '../config.js';
import { updateAlertsState } from './store.js';
import { evaluateAlert } from './rules.js';
import { deliverAlert } from './delivery.js';

export function prepareAlert(sourceId, parsed) {
  if (!config.alertsEnabled || !parsed) return null;
  const at = Date.now();
  let pending = null;
  updateAlertsState((state) => {
    const source = state.sources.find((item) => item.id === sourceId);
    if (!source) return;
    if (parsed.test) {
      source.lastTestAt = at;
      return;
    }
    source.lastEventAt = at;
    state.samples[sourceId] = [{ at, event: parsed.event, fields: parsed.fields, title: parsed.title, body: parsed.body }, ...(state.samples[sourceId] || [])].slice(0, 5);
    const result = evaluateAlert(source, parsed, { now: at, throttle: state.throttle, hasDevices: state.devices.length > 0 });
    if (result.record) state.history.unshift(result.record);
    if (result.send) pending = { source: structuredClone(source), parsed, rule: structuredClone(source.events[parsed.event]), record: result.record };
  });
  return pending;
}

export async function dispatchAlert(pending) {
  if (!pending || !config.alertsEnabled) return;
  const result = await deliverAlert(pending);
  updateAlertsState((state) => {
    const record = state.history.find((item) => item.id === pending.record.id);
    if (record) record.outcome = result.ok ? 'sent' : 'failed';
  });
}
