import test from 'node:test';
import assert from 'node:assert/strict';

import { OBSERVER_SCOPES, hasScope, validateScopeList } from '../src/mobile/scopes.js';

test('observer scope set matches the five sorted read scopes', () => {
  assert.deepEqual(OBSERVER_SCOPES, [
    'containers.read',
    'events.read',
    'stacks.read',
    'summary.read',
    'updates.read',
  ]);
  assert.deepEqual([...OBSERVER_SCOPES].sort(), [...OBSERVER_SCOPES]);
});

test('a canonical subset validates; everything else is refused', () => {
  assert.equal(validateScopeList([...OBSERVER_SCOPES]).ok, true);
  assert.equal(validateScopeList(['summary.read']).ok, true);
  assert.equal(validateScopeList(['containers.read', 'summary.read']).ok, true);
  assert.equal(validateScopeList([]).ok, false);
  assert.equal(validateScopeList('summary.read').ok, false);
  assert.equal(validateScopeList(['summary.read', 'containers.read']).ok, false);
  assert.equal(validateScopeList(['summary.read', 'summary.read']).ok, false);
  assert.equal(validateScopeList(['docker.read']).ok, false);
  assert.equal(validateScopeList(['logs.read']).ok, false);
  assert.equal(validateScopeList(['admin.read']).ok, false);
  assert.equal(validateScopeList([42]).ok, false);
});

test('hasScope is exact and fails closed on malformed grants', () => {
  const granted = ['containers.read', 'summary.read'];
  assert.equal(hasScope(granted, 'summary.read'), true);
  assert.equal(hasScope(granted, 'events.read'), false);
  assert.equal(hasScope(granted, 'docker.write'), false);
  assert.equal(hasScope(['summary.read', 'containers.read'], 'summary.read'), false);
  assert.equal(hasScope('summary.read', 'summary.read'), false);
});
