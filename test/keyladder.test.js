import test from 'node:test';
import assert from 'node:assert/strict';

import { ladderFor, missingKeyKinds, LADDER_MINT_KINDS } from '../src/keyladder.js';
import { configFileRule } from '../src/detect.js';

test('missing-key kinds map to one ladder class', () => {
  const kinds = missingKeyKinds();
  assert.ok(kinds.length >= 30);
  for (const kind of kinds) {
    const rung = ladderFor(kind);
    assert.ok(rung, `${kind} has a rung`);
    assert.ok(['file', 'mint', 'manual'].includes(rung.class), `${kind} class`);
    const operative = [rung.fileRule ? 'file' : null, rung.mint ? 'mint' : null].filter(Boolean);
    if (rung.class === 'file') assert.deepEqual(operative, ['file'], `${kind} file only`);
    if (rung.class === 'mint') assert.deepEqual(operative, ['mint'], `${kind} mint only`);
    if (rung.class === 'manual') assert.deepEqual(operative, [], `${kind} carries no file or mint spec`);
  }
});

test('unsupported kinds have no credential ladder entry', () => {
  for (const kind of ['plex', 'komodo', 'qbittorrent', 'dozzle', 'transmission', 'synology']) {
    assert.equal(ladderFor(kind), null, kind);
  }
});

test('file credential rules match discovery and include mount hints', () => {
  const fileKinds = missingKeyKinds().filter((kind) => ladderFor(kind).class === 'file');
  assert.deepEqual(
    fileKinds.slice().sort(),
    missingKeyKinds().filter((kind) => configFileRule(kind)).sort(),
  );
  for (const kind of fileKinds) {
    const { fileRule } = ladderFor(kind);
    assert.equal(fileRule.folder, kind);
    assert.equal(fileRule.target, `/stack/${kind}`);
    assert.ok(fileRule.sourcePath.startsWith('/'), `${kind} source path`);
    assert.ok(fileRule.mountHint.startsWith('/'), `${kind} mount hint`);
  }
});

test('mint rungs include credential specs and registry membership', () => {
  const mintKinds = missingKeyKinds().filter((kind) => ladderFor(kind).class === 'mint');
  assert.deepEqual(mintKinds.slice().sort(), LADDER_MINT_KINDS.slice().sort());
  for (const kind of mintKinds) {
    const { mint } = ladderFor(kind);
    assert.ok(mint.usernameLabel && mint.passwordLabel && mint.note, `${kind} spec fields`);
  }
});

test('manual rungs carry a settings path for the Companion paste flow', () => {
  const manualKinds = missingKeyKinds().filter((kind) => ladderFor(kind).class === 'manual');
  assert.ok(manualKinds.length > 0);
  for (const kind of manualKinds) {
    const rung = ladderFor(kind);
    assert.ok(rung.settingsPath, `${kind} has a settings path`);
    assert.equal(Object.hasOwn(rung, 'phoneOnly'), false, `${kind} is completed in Companion before scanning`);
  }
  assert.equal(ladderFor('homeassistant').settingsPath, '/profile/security', 'home assistant opens its token page');
});
