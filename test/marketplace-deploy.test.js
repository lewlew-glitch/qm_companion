
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = 'nas.local';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qm-companion-market-test-'));
const MARKET_DATA_DIR = process.env.DATA_DIR;
test.after(() => rmSync(MARKET_DATA_DIR, { recursive: true, force: true }));

const { LINT_FN } = await import('../src/ui/bits.js');
const { cataloguePage, suggestedStack, STACK_NAME_MAX } = await import('../src/ui/pages/marketplace.js');
const { lintCompose } = await import('../src/lint.js');


class El {
  constructor(name) {
    this.name = name;
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.value = '';
    this.parentNode = null;
    this.listeners = {};
    this.attrs = {};
    this._text = '';
  }

  get textContent() { return this._text; }

  set textContent(v) { this._text = String(v); this.children = []; }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }

  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; return child; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }

  setAttribute(key, value) { this.attrs[key] = String(value); }

  getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; }
}

function wire(fetchImpl) {
  const doc = {
    createElement: (name) => new El(name),
    querySelector: () => ({ content: 'csrf-token' }),
  };
  const make = new Function('document', 'fetch', `${LINT_FN}\nreturn qmLintWire;`)(doc, fetchImpl);
  const panel = new El('div');
  const yaml = new El('textarea');
  const button = new El('button');
  panel.hidden = true;
  return { lint: make({ yaml, panel, buttons: [button] }), panel, yaml, button };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ONE_ERROR = [{ id: 'QM003', severity: 'error', line: 7, message: 'host port 8096 is already published by container "jellyfin"' }];

test('preserves findings when the linter is unreachable', async () => {
  let answer = { ok: true, json: async () => ({ findings: ONE_ERROR }) };
  const { lint, panel, button } = wire(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });

  lint.refresh();
  await settle();
  const rows = panel.children[1];
  assert.equal(button.disabled, true, 'an error finding locks the button');
  assert.equal(rows.children.length, 1);
  assert.match(panel.children[0].textContent, /1 error blocks deployment/);

  answer = new Error('offline');
  lint.refresh();
  await settle();
  assert.equal(button.disabled, true, 'the lock survives a linter that went away');
  assert.equal(rows.children.length, 1, 'the findings stay on screen');
  assert.equal(panel.hidden, false);
  assert.match(panel.children[0].textContent, /1 error blocks deployment/);
  assert.match(panel.children[0].textContent, /could not be reached/);
  assert.match(panel.children[0].textContent, /Edit the file to check again, or reload the page/);

  answer = { ok: true, json: async () => ({ findings: [] }) };
  lint.refresh();
  await settle();
  assert.equal(button.disabled, false);
  assert.equal(panel.hidden, true);
  assert.doesNotMatch(panel.children[0].textContent, /could not be reached/);
});

test('reports an unavailable linter without prior findings', async () => {
  const { lint, panel, button } = wire(async () => { throw new Error('offline'); });
  lint.refresh();
  await settle();
  assert.equal(button.disabled, false);
  assert.equal(panel.hidden, false);
  assert.match(panel.children[0].textContent, /could not be reached/);
});


const SOURCES = [{
  id: 'aabbccdd00112233',
  name: 'Community apps',
  url: 'https://templates.example.com/v2.json',
  addedAt: 1755000000000,
  fetchedAt: 1755003600000,
  fetchError: null,
  entries: [
    { type: 3, title: '日本語のスタック', description: 'A title with no latin characters at all.', yaml: 'services:\n  app:\n    image: example/app:1.0\n' },
    { type: 3, title: 'Very Long Community Stack Name For Networks', name: 'very-long-community-stack-name-for-networks', description: 'Long.', yaml: 'services:\n  app:\n    image: example/app:1.0\n' },
  ],
}];

test('does not pass typed ownership to the linter', () => {
  const html = cataloguePage([], true, 'csrf-token', SOURCES, 'catalogue');
  assert.match(html, /stack:function\(\)\{ return ''; \}/);
  assert.doesNotMatch(html, /stack:function\(\)\{ return stackName\.value\.trim\(\); \}/);
});

test('populates stack values before initial linting', () => {
  const html = cataloguePage([], true, 'csrf-token', SOURCES, 'catalogue');
  const fields = html.indexOf("stackName.value=entry.stack||''");
  const firstLint = html.indexOf('if(hasCompose) mlint.refresh();');
  assert.ok(fields > 0 && firstLint > 0);
  assert.ok(fields < firstLint);
  assert.match(html, /buildEnv\(\);\n?\s*if\(hasCompose\) mlint\.refresh\(\)/);
});

test('re-lints supplied Compose values on input', () => {
  const html = cataloguePage([], true, 'csrf-token', SOURCES, 'catalogue');
  assert.match(html, /env:envValues\(\),start:true/, 'the values reach the deploy request');
  assert.match(html, /env:function\(\)\{ return envValues\(\); \}/);
  assert.match(html, /setTimeout\(function\(\)\{ mlint\.refresh\(\); \},400\)/, 'typing a value re-lints');
  assert.match(html, /Used for this deployment only\. Nothing typed here is written into the Compose file\./);
  const readOnly = cataloguePage([], false, 'csrf-token', SOURCES, 'catalogue');
  assert.doesNotMatch(readOnly, /envValues\(\)/);
});

test('a suggested stack name fits the network Docker will build from it', () => {
  assert.equal(STACK_NAME_MAX, 33);
  assert.equal(suggestedStack({ name: 'Uptime Kuma' }), 'uptime-kuma');
  const long = suggestedStack({ title: 'Very Long Community Stack Name For Networks' });
  assert.ok(long.length <= 33, `"${long}" is ${long.length} characters`);
  assert.ok(`${long}_default`.length <= 41, 'the network name Docker is asked for is legal');
  assert.doesNotMatch(long, /[-_]$/);
  assert.equal(suggestedStack({ name: 'aaaaaaaaaa-bbbbbbbbbb-cccccccccc-dddddddddd' }), 'aaaaaaaaaa-bbbbbbbbbb-cccccccccc');
  assert.equal(suggestedStack({ title: '日本語のスタック' }), '');
});

test('array indices do not become Docker object names', () => {
  const html = cataloguePage([], true, 'csrf-token', SOURCES, 'catalogue');
  assert.match(html, /stackName\.value=entry\.stack\|\|''/);
  assert.doesNotMatch(html, /stackName\.value=entry\.stack\|\|kind/);
  assert.match(html, /"kind":"src-0-0"[^}]*"stack":""/);
  assert.match(html, /"kind":"radarr"[^}]*"stack":"radarr"/);
  assert.match(html, new RegExp(`id="market-stack-name" maxlength="${STACK_NAME_MAX}"`));
  assert.match(html, /Name this stack first\./);
});

test('state filter values match visible card states', () => {
  const control = cataloguePage([], true, 'csrf-token', SOURCES, 'catalogue');
  assert.match(control, /<option value="deploy">Available to deploy<\/option>/);

  const readOnly = cataloguePage([], false, 'csrf-token', SOURCES, 'catalogue');
  assert.doesNotMatch(readOnly, /Available to deploy/, 'no card can carry it in read-only mode');
  assert.match(readOnly, /Read-only Docker mode/);

  const noDocker = cataloguePage(null, true, 'csrf-token', SOURCES, 'catalogue');
  assert.doesNotMatch(noDocker, /Available to deploy/, 'nor when Docker is unreachable');
});

test('renders catalogue recovery guidance for empty filters', () => {
  const html = cataloguePage([], false, 'csrf-token', SOURCES, 'catalogue');
  assert.match(html, /id="market-empty"[^>]*hidden><b>No matching services<\/b>/);
  assert.match(html, /Nothing matches the selected filters/);
  assert.match(html, /function clearFilters\(\)\{ search\.value=''; categoryFilter\.value=''; sourceFilter\.value=''; plane\.value=''; apply\(\); search\.focus\(\); \}/);
  assert.match(html, /clearButtons\.forEach\(function\(button\)\{ button\.addEventListener\('click',clearFilters\); \}\)/);
  assert.match(html, /class="btn market-clear"[^>]*>Clear filters<\/button>/);
});


const MARIADB = [
  'services:',
  '  db:',
  '    image: mariadb:11',
  '    restart: unless-stopped',
  '    environment:',
  '      MARIADB_ROOT_PASSWORD: ${MARIADB_ROOT_PASSWORD}',
  '      TZ_NAME: ${TZ_NAME}',
  '',
].join('\n');

test('renders fields for unsupplied secrets', () => {
  const findings = lintCompose(MARIADB, {}, {});
  const secret = findings.find((f) => f.id === 'QM011' && /MARIADB_ROOT_PASSWORD/.test(f.message));
  const plain = findings.find((f) => f.id === 'QM011' && /TZ_NAME/.test(f.message));

  assert.ok(secret, 'the root password variable is flagged');
  assert.equal(secret.severity, 'error');
  assert.match(secret.message, /Values on the deploy panel/, 'the message names where the value goes');
  assert.doesNotMatch(secret.message, /supply the value at deploy time/);

  assert.ok(plain);
  assert.equal(plain.severity, 'warn');
  assert.match(plain.message, /\$\{TZ_NAME:-value\}/, 'with the default syntax spelled out');

  const supplied = lintCompose(MARIADB, { MARIADB_ROOT_PASSWORD: 'hunter2', TZ_NAME: 'Etc/UTC' }, {});
  assert.equal(supplied.filter((f) => f.id === 'QM011').length, 0);
});

test('maps pasted secret guidance to a real field', () => {
  const findings = lintCompose([
    'services:',
    '  db:',
    '    image: mariadb:11',
    '    restart: unless-stopped',
    '    environment:',
    '      DB_PASSWORD: DO-NOT-ECHO-c0ffee00c0ffee00c0ffee00c0ffee00',
    '',
  ].join('\n'), {}, {});
  const row = findings.find((f) => f.id === 'QM007');
  assert.ok(row);
  assert.match(row.message, /\$\{DB_PASSWORD\}/);
  assert.match(row.message, /Values on the deploy panel/);
  assert.doesNotMatch(JSON.stringify(findings), /DO-NOT-ECHO/);
});


function envHelpers(html, yaml, deployFields, onRefresh) {
  const source = html.slice(html.indexOf('var envCells=[]'), html.indexOf("deploy.addEventListener('click'"));
  assert.ok(source.length > 100, 'the value-field wiring is in the page');
  const doc = { createElement: (name) => new El(name) };
  return new Function('document', 'yaml', 'deployFields', 'mlint', 'setTimeout', 'clearTimeout', `${source}\nreturn { buildEnv: buildEnv, envValues: envValues };`)(
    doc, yaml, deployFields, { refresh: onRefresh }, (fn) => { fn(); return 1; }, () => {},
  );
}

test('deploys entered values for unsupplied variables', () => {
  const html = cataloguePage([], true, 'csrf-token', SOURCES, 'catalogue');
  const yaml = new El('textarea');
  const fields = new El('div');
  let refreshes = 0;
  const env = envHelpers(html, yaml, fields, () => { refreshes += 1; });

  yaml.value = MARIADB;
  env.buildEnv();
  const inputs = fields.children.filter((c) => c.name === 'input');
  assert.equal(inputs.length, 2);
  assert.deepEqual(fields.children.filter((c) => c.name === 'label').map((c) => c.textContent), ['Values', 'MARIADB_ROOT_PASSWORD', 'TZ_NAME']);
  assert.deepEqual(env.envValues(), {});

  inputs[0].value = 'hunter2';
  assert.deepEqual(env.envValues(), { MARIADB_ROOT_PASSWORD: 'hunter2' });
  inputs[0].listeners.input[0]();
  assert.equal(refreshes, 1);

  yaml.value = 'services:\n  app:\n    image: example/app:1.0\n';
  env.buildEnv();
  assert.equal(fields.children.length, 0);
  assert.deepEqual(env.envValues(), {});
});
