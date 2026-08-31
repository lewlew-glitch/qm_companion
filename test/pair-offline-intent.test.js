import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SECRET_KEY = process.env.SECRET_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = process.env.QM_HOST || '192.168.1.20';

const offlineModule = await import('../src/ui/pages/pair-offline.js');

function fakeDom() {
  const listeners = {};
  const doc = {
    activeElement: null,
    listeners,
    addEventListener(name, fn) { listeners[name] = fn; },
    dispatch(name, target) {
      const fn = listeners[name];
      assert.equal(typeof fn, 'function', 'the page script registers a delegated ' + name + ' listener on the document');
      fn({ target });
    },
  };
  function container(name) {
    return { name, children: [], insertBefore(row, next) {
      if (row.parentNode) row.parentNode.children.splice(row.parentNode.children.indexOf(row), 1);
      const at = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(at, 0, row);
      row.parentNode = this;
    } };
  }
  const groups = { reachable: container('reachable'), unreachable: container('unreachable'), stopped: container('stopped'), unverified: container('unverified') };
  const sections = { unreachable: { hidden: true }, stopped: { hidden: true }, unverified: { hidden: true } };
  const allRows = () => Object.values(groups).flatMap((g) => g.children);
  doc.querySelector = (sel) => {
    const rows = /data-pair-(\w+)-rows/.exec(sel);
    if (rows) return groups[rows[1]];
    const section = /data-pair-section="(\w+)"/.exec(sel);
    return section ? sections[section[1]] : null;
  };
  doc.querySelectorAll = (sel) => {
    const avail = /data-avail="([\w-]+)"/.exec(sel);
    return allRows().filter((row) => !avail || row.dataset.avail === avail[1]);
  };
  function row(order, avail = 'reachable') {
    const pick = { checked: avail === 'reachable', disabled: avail === 'unreachable' || avail === 'not-running' };
    const holder = { className: 'pair-pick' };
    const chip = { innerHTML: '' };
    const note = { hidden: avail === 'reachable' };
    const noteText = { textContent: '' };
    const slot = { innerHTML: '' };
    const flag = { value: '' };
    const input = {};
    const r = { dataset: { avail, dockerState: avail === 'not-running' ? 'exited' : 'running', order: String(order), credState: 'included' }, parentNode: null, input,
      contains: (node) => node === input || node === pick,
      querySelector: (sel) => (sel.includes('.pair-pick') ? pick : sel.includes('data-cred') ? chip : sel.includes('data-force-flag') ? flag : sel.includes('data-override-slot') ? slot : sel.includes('data-avail-note-text') ? noteText : note) };
    pick.closest = (sel) => (sel.includes('pair-pick') ? holder : sel.includes('data-pair-row') ? r : null);
    holder.closest = pick.closest;
    groups[offlineModule.GROUP_BY_AVAILABILITY[avail]].insertBefore(r, null);
    return { r, pick, holder, chip, note, noteText, slot, flag, input };
  }
  return { doc, groups, sections, row };
}

function clientHalf(doc, source = offlineModule.PAIR_OFFLINE_SCRIPT) {
  const factory = new Function('document', 'chipHtml', 'ALERT', `${source}\nreturn { setAvailability: setAvailability, includeAnyway: includeAnyway, leftOutCounts: leftOutCounts, countOffline: countOffline };`);
  return factory(doc, () => '<span class="badge ok">Key ready</span>', '<svg/>');
}

const URL_8989 = 'http://192.168.1.20:8989';

test('preserves Include anyway across availability changes', () => {
  const dom = fakeDom();
  const { r, pick, flag, slot } = dom.row(0);
  const { setAvailability, leftOutCounts, includeAnyway } = clientHalf(dom.doc);

  setAvailability(r, 'unreachable', 'running', URL_8989);
  setAvailability(r, 'unreachable', 'running', URL_8989);
  assert.equal(r.dataset.avail, 'unreachable', 'step 1: two misses demote');
  assert.equal(pick.checked, false);
  assert.equal(pick.disabled, true);

  includeAnyway(r);
  assert.equal(r.dataset.forced, '1', 'forced selection is recorded');
  assert.equal(r.dataset.intent, '1');
  assert.equal(pick.checked, true);
  assert.equal(flag.value, 'on');

  setAvailability(r, 'not-running', 'exited', '');
  assert.equal(r.dataset.avail, 'not-running');
  assert.equal(pick.checked, false);
  assert.equal(pick.disabled, true);
  assert.equal(r.dataset.forced, '1', 'but the decision outlives the stop');
  assert.equal(r.dataset.intent, '1');

  setAvailability(r, 'unreachable', 'running', URL_8989);
  assert.equal(r.dataset.avail, 'unreachable', 'step 3: back to running but unreachable');
  assert.equal(pick.checked, true);
  assert.equal(pick.disabled, false);
  assert.equal(flag.value, 'on');
  assert.match(slot.innerHTML, /data-include-anyway/);
  assert.deepEqual(leftOutCounts(), { unreachable: 0, stopped: 0 }, 'and it is not reported as left out');

  setAvailability(r, 'reachable', 'running', URL_8989);
  assert.equal(r.dataset.avail, 'reachable', 'step 4: it answers again');
  assert.equal(pick.checked, true);
  assert.equal(pick.disabled, false);
  assert.equal(slot.innerHTML, '');

  setAvailability(r, 'unreachable', 'running', URL_8989);
  setAvailability(r, 'unreachable', 'running', URL_8989);
  assert.equal(r.dataset.avail, 'unreachable', 'step 5: unreachable once more');
  assert.equal(pick.checked, true);
  assert.equal(pick.disabled, false);
  assert.deepEqual(leftOutCounts(), { unreachable: 0, stopped: 0 });
  assert.equal(r.parentNode, dom.groups.unreachable);
});

test('a forced row the owner unticked stays out across not running and back', () => {
  const dom = fakeDom();
  const { r, pick } = dom.row(0);
  const { setAvailability, includeAnyway, leftOutCounts } = clientHalf(dom.doc);
  setAvailability(r, 'unreachable', 'running', URL_8989);
  setAvailability(r, 'unreachable', 'running', URL_8989);
  includeAnyway(r);

  pick.checked = false;
  dom.doc.dispatch('change', pick);
  assert.equal(r.dataset.intent, '0');

  setAvailability(r, 'not-running', 'exited', '');
  setAvailability(r, 'unreachable', 'running', URL_8989);
  assert.equal(pick.checked, false, 'it stays out, because that is what they chose');
  assert.equal(pick.disabled, false);
  assert.deepEqual(leftOutCounts(), { unreachable: 1, stopped: 0 });
});

test('preserves an owner deselection across polling', () => {
  const dom = fakeDom();
  const { r, pick } = dom.row(0, 'reachable');
  const { setAvailability } = clientHalf(dom.doc);
  assert.equal(r.dataset.intent, '1');

  pick.checked = false;
  dom.doc.dispatch('change', pick);
  assert.equal(r.dataset.intent, '0');

  setAvailability(r, 'unreachable', 'running', URL_8989);
  setAvailability(r, 'unreachable', 'running', URL_8989);
  setAvailability(r, 'not-running', 'exited', '');
  setAvailability(r, 'unreachable', 'running', URL_8989);
  setAvailability(r, 'reachable', 'running', URL_8989);
  assert.equal(pick.checked, false);
});

test('records a tick on an unverified row', () => {
  const dom = fakeDom();
  const { r, pick } = dom.row(0, 'unverified');
  const { setAvailability } = clientHalf(dom.doc);
  assert.equal(r.dataset.intent, '0');

  pick.checked = true;
  dom.doc.dispatch('change', pick);
  assert.equal(r.dataset.intent, '1', 'the delegated change listener recorded the tick');

  setAvailability(r, 'unreachable', 'running', URL_8989);
  setAvailability(r, 'unreachable', 'running', URL_8989);
  assert.equal(pick.checked, false);
  setAvailability(r, 'reachable', 'running', URL_8989);
  assert.equal(pick.checked, true);
});

test('ignores changes on non-pick inputs', () => {
  const dom = fakeDom();
  const { r } = dom.row(0, 'reachable');
  clientHalf(dom.doc);
  const address = { checked: false, closest: (sel) => (sel.includes('pair-pick') ? null : r) };
  dom.doc.dispatch('change', address);
  assert.equal(r.dataset.intent, '1', 'editing an address does not untick the service');
  dom.doc.dispatch('change', null);
  dom.doc.dispatch('change', {});
  assert.equal(r.dataset.intent, '1');
});
