// Shared wording vectors and alert rule outcomes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { clip, evaluateAlert, matchesCondition, renderTemplate } from '../src/alerts/rules.js';

const fields = { series: 'Slow Horses', episode: 'S04E02', quality: 'WEBDL-2160p', indexer: '', size: '12', year: '2024' };

function source(changes = {}) {
  return {
    id: 'src_test', events: {
      download: { on: true, title: null, body: null, when: [], level: 'active', sound: true, historyOnly: false, throttleMinutes: 0, ...changes },
    },
  };
}

function event(changes = {}) {
  return { event: 'download', fields, title: 'Download complete', body: 'Slow Horses S04E02 has finished downloading', ...changes };
}

function evaluate(rule = {}, options = {}, parsed = event()) {
  return evaluateAlert(source(rule), parsed, { now: 1_000_000, throttle: {}, hasDevices: true, ...options });
}

test('substitutes known fields', () => {
  assert.equal(renderTemplate('{series} {episode} is ready', fields), 'Slow Horses S04E02 is ready');
});

test('renders unknown and empty fields as nothing, without double spaces', () => {
  assert.equal(renderTemplate('{series} from {indexer} {nope} done', fields), 'Slow Horses from done');
});

test('keeps braces that are not placeholders', () => {
  assert.equal(renderTemplate('{ series } {1abc} {}', fields), '{ series } {1abc} {}');
});

test('trims each line and drops blank lines at the ends only', () => {
  assert.equal(renderTemplate('\n  {series}  \n\n{indexer}\n', fields), 'Slow Horses');
  assert.equal(renderTemplate('{series}\n\n{episode}', fields), 'Slow Horses\n\nS04E02');
  assert.equal(renderTemplate('{series}\n{episode}', fields), 'Slow Horses\nS04E02');
});

test('never reads inherited keys', () => {
  assert.equal(renderTemplate('{constructor}{toString}', {}), '');
});

test('leaves short text alone and ends long text with an ellipsis', () => {
  assert.equal(clip('abc', 3), 'abc');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('ab  def', 4), 'ab…');
});

test('compares text without case or surrounding space', () => {
  assert.equal(matchesCondition({ field: 'series', op: 'is', value: ' slow horses ' }, fields), true);
  assert.equal(matchesCondition({ field: 'series', op: 'isNot', value: 'Slow Horses' }, fields), false);
  assert.equal(matchesCondition({ field: 'quality', op: 'contains', value: '2160P' }, fields), true);
  assert.equal(matchesCondition({ field: 'quality', op: 'notContains', value: '1080p' }, fields), true);
});

test('treats a missing field as empty', () => {
  assert.equal(matchesCondition({ field: 'missing', op: 'is', value: '' }, fields), true);
  assert.equal(matchesCondition({ field: 'missing', op: 'contains', value: 'x' }, fields), false);
});

test('only compares numbers when both sides are plain numbers', () => {
  assert.equal(matchesCondition({ field: 'size', op: 'atLeast', value: '10' }, fields), true);
  assert.equal(matchesCondition({ field: 'size', op: 'atMost', value: '10' }, fields), false);
  assert.equal(matchesCondition({ field: 'quality', op: 'atLeast', value: '1' }, fields), false);
  assert.equal(matchesCondition({ field: 'year', op: 'atLeast', value: '2024.0' }, fields), true);
});

test('needs every condition to hold', () => {
  const when = [
    { field: 'quality', op: 'contains', value: '2160p' },
    { field: 'series', op: 'is', value: 'Andor' },
  ];
  assert.equal(evaluate({ when }).record.outcome, 'filtered');
  assert.equal(evaluate({ when: when.slice(0, 1) }).send, true);
  assert.equal(evaluate({ when: [] }).send, true);
});

test('keeps the companion wording when no template is set', () => {
  const parsed = event();
  const { record } = evaluate({ title: null, body: null }, {}, parsed);
  assert.deepEqual({ title: record.title, body: record.body }, { title: parsed.title, body: parsed.body });
});

test('falls back when a template renders empty', () => {
  const { record } = evaluate({ title: '{indexer}', body: '{series} in {quality}' });
  assert.deepEqual({ title: record.title, body: record.body }, {
    title: 'Download complete', body: 'Slow Horses in WEBDL-2160p',
  });
});

test('placeholder names and whitespace follow the shared grammar', () => {
  const name = 'a'.repeat(32);
  const tooLong = 'a'.repeat(33);
  assert.equal(renderTemplate(`{${name}} {${tooLong}} {under_score} {a0}`, { [name]: 'yes', [tooLong]: 'no', a0: 'last' }), `yes {${tooLong}} {under_score} last`);
  assert.equal(renderTemplate(' \t{series}\t \t{episode}\t\n \n x ', fields), 'Slow Horses S04E02\n\nx');
  assert.equal(renderTemplate('{value}', Object.create({ value: 'inherited' })), '');
  assert.equal(renderTemplate('{value}', { value: 12 }), '');
});

test('conditions ignore inherited values and reject malformed numeric comparisons', () => {
  assert.equal(matchesCondition({ field: 'constructor', op: 'is', value: '' }, {}), true);
  assert.equal(matchesCondition({ field: 'n', op: 'is', value: '' }, Object.create({ n: 'inherited' })), true);
  assert.equal(matchesCondition({ field: 'n', op: 'atMost', value: ' -1.2 ' }, { n: ' -2 ' }), true);
  for (const value of ['1e3', '+1', '.5', '1.', '0x10', 'Infinity', 'NaN', '', '1,000']) {
    assert.equal(matchesCondition({ field: 'n', op: 'atLeast', value }, { n: '1' }), false);
    assert.equal(matchesCondition({ field: 'n', op: 'atMost', value: '1' }, { n: value }), false);
  }
  assert.equal(matchesCondition({ field: 'n', op: 'unknown', value: '1' }, { n: '1' }), false);
});

test('missing and disabled rules drop the event without history or throttle changes', () => {
  const throttle = {};
  assert.deepEqual(evaluate({ on: false }, { throttle }), { record: null, send: false });
  assert.deepEqual(evaluate({}, { throttle }, event({ event: 'grab' })), { record: null, send: false });
  assert.deepEqual(evaluateAlert({ id: 'src_test', events: Object.create(source().events) }, event(), {
    now: 1_000_000, throttle, hasDevices: true,
  }), { record: null, send: false });
  assert.deepEqual(throttle, {});
});

test('filtered events keep standard wording and do not use the throttle', () => {
  const throttle = {};
  const { record, send } = evaluate({
    when: [{ field: 'quality', op: 'contains', value: '1080p' }], throttleMinutes: 10, title: 'Custom title', body: 'Custom body',
  }, { throttle });
  assert.equal(send, false);
  assert.equal(record.outcome, 'filtered');
  assert.equal(record.title, 'Download complete');
  assert.deepEqual(throttle, {});
});

test('throttle records the first admission and opens at the exact boundary', () => {
  const throttle = {};
  assert.equal(evaluate({ throttleMinutes: 5 }, { now: 0, throttle }).send, true);
  assert.deepEqual(throttle, { 'src_test:download': 0 });
  const throttled = evaluate({ throttleMinutes: 5, title: 'Custom' }, { now: 299_999, throttle });
  assert.equal(throttled.send, false);
  assert.equal(throttled.record.outcome, 'throttled');
  assert.equal(throttled.record.title, 'Download complete');
  assert.deepEqual(throttle, { 'src_test:download': 0 });
  assert.equal(evaluate({ throttleMinutes: 5 }, { now: 300_000, throttle }).send, true);
  assert.deepEqual(throttle, { 'src_test:download': 300_000 });
});

test('throttle is separate for each source and event and may be switched off', () => {
  const throttle = { 'src_other:download': 1_000_000, 'src_test:grab': 1_000_000 };
  assert.equal(evaluate({ throttleMinutes: 5 }, { throttle }).send, true);
  assert.equal(evaluate({ throttleMinutes: 0 }, { now: 1_000_001, throttle }).send, true);
  assert.equal(throttle['src_test:download'], 1_000_001);
  const inherited = Object.create({ 'src_test:download': 1_000_000 });
  assert.equal(evaluate({ throttleMinutes: 5 }, { throttle: inherited }).send, true);
  assert.equal(Object.hasOwn(inherited, 'src_test:download'), true);
});

test('history only precedes the no devices outcome and uses custom wording', () => {
  const throttle = {};
  const { record, send } = evaluate({ historyOnly: true, title: '{series}', body: '{episode} is ready', throttleMinutes: 5 }, { hasDevices: false, throttle });
  assert.equal(send, false);
  assert.equal(record.outcome, 'historyOnly');
  assert.equal(record.title, 'Slow Horses');
  assert.equal(record.body, 'S04E02 is ready');
  assert.equal(throttle['src_test:download'], 1_000_000);
});

test('events without a registered device are recorded without delivery', () => {
  const { record, send } = evaluate({}, { hasDevices: false });
  assert.equal(send, false);
  assert.equal(record.outcome, 'noDevices');
});

test('admitted events have unique history ids and await a delivery result', () => {
  const first = evaluate();
  const second = evaluate();
  assert.equal(first.send, true);
  assert.match(first.record.id, /^al_[A-Za-z0-9_-]{16}$/);
  assert.notEqual(first.record.id, second.record.id);
  assert.deepEqual({ ...first.record, id: 'id' }, {
    id: 'id', at: 1_000_000, sourceId: 'src_test', event: 'download', title: 'Download complete',
    body: 'Slow Horses S04E02 has finished downloading', outcome: 'failed',
  });
});

test('both custom and standard wording stay within the delivery limits', () => {
  for (const { record } of [
    evaluate({ title: '{long}', body: '{long}' }, {}, event({ fields: { long: 'x'.repeat(1200) } })),
    evaluate({}, {}, event({ title: 'x'.repeat(121), body: 'x'.repeat(1001) })),
    evaluate({ title: '{missing}', body: '{missing}' }, {}, event({ title: 'x'.repeat(121), body: 'x'.repeat(1001) })),
    evaluate({ when: [{ field: 'missing', op: 'is', value: 'required' }] }, {}, event({ title: 'x'.repeat(121), body: 'x'.repeat(1001) })),
  ]) {
    assert.equal(record.title, `${'x'.repeat(119)}…`);
    assert.equal(record.body, `${'x'.repeat(999)}…`);
  }
});
