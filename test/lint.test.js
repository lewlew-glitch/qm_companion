import test from 'node:test';
import assert from 'node:assert/strict';

import { lintCompose } from '../src/lint.js';
import { parseCompose } from '../src/compose.js';

const CLEAN = [
  'services:',
  '  radarr:',
  '    image: lscr.io/linuxserver/radarr:5.14.0',
  '    container_name: radarr',
  '    restart: unless-stopped',
  '    ports:',
  '      - "7878:7878"',
  '    environment:',
  '      PUID: "1000"',
  '      TZ: Etc/UTC',
  '      API_KEY: ${RADARR_API_KEY}',
  '    volumes:',
  '      - radarr-config:/config',
  'volumes:',
  '  radarr-config:',
  '',
].join('\n');

const CLEAN_ENV = { RADARR_API_KEY: 'supplied-at-deploy-time' };

function ids(findings) {
  return [...new Set(findings.map((f) => f.id))].sort();
}

function svcBlock(extra) {
  return ['services:', '  app:', '    image: example/app:1.0', '    restart: unless-stopped', ...extra, ''].join('\n');
}

const CASES = [
  {
    rule: 'QM001', severity: 'warn',
    yaml: 'services:\n  app:\n    image: example/app\n    restart: unless-stopped\n',
    also: 'services:\n  app:\n    image: example/app:latest\n    restart: unless-stopped\n',
  },
  {
    rule: 'QM002', severity: 'info',
    yaml: 'services:\n  app:\n    image: example/app:1.0\n',
  },
  {
    rule: 'QM003', severity: 'error',
    yaml: svcBlock(['    ports:', '      - "8080:80"', '  other:', '    image: example/other:1.0', '    restart: unless-stopped', '    ports:', '      - "8080:81"']),
  },
  {
    rule: 'QM004', severity: 'error',
    yaml: svcBlock(['    volumes:', '      - /etc:/host-etc:ro']),
  },
  {
    rule: 'QM005', severity: 'error',
    yaml: svcBlock(['    volumes:', '      - /var/run/docker.sock:/var/run/docker.sock:ro']),
  },
  {
    rule: 'QM006', severity: 'error',
    yaml: svcBlock(['    privileged: true']),
  },
  {
    rule: 'QM007', severity: 'warn',
    yaml: svcBlock(['    environment:', '      API_KEY: DO-NOT-ECHO-c0ffee00c0ffee00c0ffee00c0ffee00']),
  },
  {
    rule: 'QM008', severity: 'error',
    yaml: svcBlock(['    volumes:', '      - app-data:/data']),
  },
  {
    rule: 'QM009', severity: 'error',
    yaml: svcBlock(['    container_name: jellyfin']),
    context: { containers: [{ name: 'jellyfin' }], publishedHostPorts: [] },
  },
  {
    rule: 'QM010', severity: 'error',
    yaml: svcBlock(['    container_name: shared', '  other:', '    image: example/other:1.0', '    restart: unless-stopped', '    container_name: shared']),
  },
  {
    rule: 'QM011', severity: 'warn',
    yaml: svcBlock(['    environment:', '      TOKEN_TARGET: ${UNSET_VAR}']),
  },
  {
    rule: 'QM012', severity: 'error',
    yaml: 'services:\n\tapp:\n\t\timage: example/app:1.0\n',
  },
  {
    rule: 'QM013', severity: 'error',
    yaml: svcBlock(['    labels:', '      qm.protected: "true"']),
  },
];

test('every rule fires on its trigger and stays quiet on the clean file', () => {
  const clean = lintCompose(CLEAN, CLEAN_ENV, { containers: [], publishedHostPorts: [] });
  assert.deepEqual(clean, [], `clean file must lint clean, got ${JSON.stringify(clean)}`);
  assert.equal(parseCompose(CLEAN).ok, true, 'the clean fixture must also deploy-parse');

  for (const c of CASES) {
    const findings = lintCompose(c.yaml, c.env || {}, c.context || { containers: [], publishedHostPorts: [] });
    const hit = findings.filter((f) => f.id === c.rule);
    assert.ok(hit.length >= 1, `${c.rule} must fire, got ${JSON.stringify(ids(findings))}`);
    for (const f of hit) {
      assert.equal(f.severity, c.severity, `${c.rule} severity`);
      assert.ok(Number.isInteger(f.line) && f.line >= 1, `${c.rule} carries a line`);
      assert.ok(f.message.length > 10, `${c.rule} carries a message`);
    }
    if (c.also) {
      assert.ok(lintCompose(c.also, {}, {}).some((f) => f.id === c.rule), `${c.rule} also fires on the variant`);
    }
  }
});

test('QM001 leaves pinned tags and digest references alone', () => {
  const pinned = lintCompose(svcBlock([]), {}, {});
  assert.ok(!pinned.some((f) => f.id === 'QM001'));
  const digest = lintCompose('services:\n  app:\n    image: example/app@sha256:' + 'ab'.repeat(32) + '\n    restart: always\n', {}, {});
  assert.ok(!digest.some((f) => f.id === 'QM001'));
});

test('QM003 identifies the port holder and skips unclaimed ports', () => {
  const context = { containers: [], publishedHostPorts: [{ port: 8096, owner: 'jellyfin' }] };
  const conflict = lintCompose(svcBlock(['    ports:', '      - "8096:8096"']), {}, context);
  const row = conflict.find((f) => f.id === 'QM003');
  assert.ok(row, 'the live conflict fires');
  assert.match(row.message, /jellyfin/);
  const free = lintCompose(svcBlock(['    ports:', '      - "8097:8096"']), {}, context);
  assert.ok(!free.some((f) => f.id === 'QM003'));
  const split = lintCompose(svcBlock(['    ports:', '      - "5353:53/tcp"', '      - "5353:53/udp"']), {}, { containers: [], publishedHostPorts: [] });
  assert.ok(!split.some((f) => f.id === 'QM003'));
});

test('QM005 reports read-only mounts without API restriction', () => {
  const ro = lintCompose(svcBlock(['    volumes:', '      - /var/run/docker.sock:/var/run/docker.sock:ro']), {}, {});
  assert.match(ro.find((f) => f.id === 'QM005').message, /\(ro\).*does not restrict/);
  const rw = lintCompose(svcBlock(['    volumes:', '      - /var/run/docker.sock:/var/run/docker.sock']), {}, {});
  assert.doesNotMatch(rw.find((f) => f.id === 'QM005').message, /\(ro\)/);
  assert.ok(!rw.some((f) => f.id === 'QM004'), 'the socket line is QM005 ground, not QM004');
});

test('QM004 and QM005 share the deploy path verdict for sensitive host binds', () => {
  for (const bind of [
    '/etc/shadow:/host/shadow:ro',
    '/root/.ssh:/host/ssh:ro',
    '/var/lib/docker:/host/docker:ro',
    '/var/run:/host/run:ro',
    '/srv/app/../../etc/shadow:/host/shadow:ro',
  ]) {
    const findings = lintCompose(svcBlock(['    volumes:', `      - ${bind}`]), {}, {});
    assert.ok(findings.some((f) => f.id === 'QM004' && f.severity === 'error'), bind);
  }
  for (const bind of [
    '/var/run/docker.sock:/host/docker.sock:ro',
    '/run/containerd/containerd.sock:/host/containerd.sock:ro',
  ]) {
    const findings = lintCompose(svcBlock(['    volumes:', `      - ${bind}`]), {}, {});
    assert.ok(findings.some((f) => f.id === 'QM005' && f.severity === 'error'), bind);
    assert.ok(!findings.some((f) => f.id === 'QM004'), `${bind} stays on the socket rule`);
  }
  for (const bind of [
    '/etc/localtime:/etc/localtime:ro',
    '/volume1/docker/radarr/config.xml:/config/config.xml:ro',
    '/srv/radarr/config:/config',
  ]) {
    const findings = lintCompose(svcBlock(['    volumes:', `      - ${bind}`]), {}, {});
    const found = findings.find((f) => f.id === 'QM004');
    assert.ok(found, bind);
    assert.match(found.message, /DOCKER_DEPLOY_BIND_ROOTS/, bind);
    assert.ok(!findings.some((f) => f.id === 'QM005'), `${bind} is not a socket`);
  }
  {
    const findings = lintCompose(`services:
  app:
    image: example/app:1.0
    volumes:
      - app-config:/config
volumes:
  app-config:
`, {}, {});
    assert.ok(!findings.some((f) => f.id === 'QM004' || f.id === 'QM005'), 'named volume');
  }
});

test('QM013 rejects control-plane shield claims', () => {
  const cases = [
    { yaml: 'services:\n  companion:\n    image: example/app:1.0\n', line: 2 },
    { yaml: svcBlock(['    container_name: qm-socket-proxy']), line: 5 },
    { yaml: svcBlock(['    labels:', '      qm.protected: "false"']), line: 6 },
    { yaml: svcBlock(['    labels:', '      - qm.protected=true']), line: 6 },
    { yaml: svcBlock(['    labels:', '      - ${LABEL_NAME}=true']), env: { LABEL_NAME: 'qm.protected' }, line: 6 },
  ];
  for (const entry of cases) {
    const findings = lintCompose(entry.yaml, entry.env || {}, {});
    const reserved = findings.find((f) => f.id === 'QM013');
    assert.ok(reserved, entry.yaml);
    assert.equal(reserved.line, entry.line, entry.yaml);
    assert.match(reserved.message, /reserved.*will not deploy/i, entry.yaml);
  }
  const allowed = lintCompose(svcBlock(['    container_name: media-app', '    labels:', '      qm.url: https://media.example.test']), {}, {});
  assert.ok(!allowed.some((f) => f.id === 'QM013'));
});

test('QM006 covers refused fields and limits network_mode to host', () => {
  for (const line of ['    privileged: true', '    cap_add:', '    pid: host', '    devices:', '    network_mode: host']) {
    const findings = lintCompose(svcBlock([line]), {}, {});
    const hit = findings.find((f) => f.id === 'QM006');
    assert.ok(hit, `${line.trim()} fires QM006`);
    assert.match(hit.message, /not deployable through Companion/);
  }
  assert.ok(!lintCompose(svcBlock(['    network_mode: bridge']), {}, {}).some((f) => f.id === 'QM006'));
});

test('QM007 detects secrets without including their values', () => {
  const sentinel = 'DO-NOT-ECHO-deadbeefdeadbeefdeadbeefdeadbeef';
  const byName = lintCompose(svcBlock(['    environment:', `      DB_PASSWORD: ${sentinel}`]), {}, {});
  const byShape = lintCompose(svcBlock(['    environment:', '      HARMLESS_NAME: a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0']), {}, {});
  assert.ok(byName.some((f) => f.id === 'QM007'));
  assert.ok(byShape.some((f) => f.id === 'QM007'));
  assert.doesNotMatch(JSON.stringify(byName), /DO-NOT-ECHO/);
  assert.match(byName.find((f) => f.id === 'QM007').message, /"DB_PASSWORD"/);
  for (const goodLine of ['      API_KEY: ${API_KEY}', '      PASSWORD_FILE: /run/secrets/pw', '      KEY_ENABLED: "true"', '      TOKEN_TTL: "3600"']) {
    const quiet = lintCompose(svcBlock(['    environment:', goodLine]), {}, {});
    assert.ok(!quiet.some((f) => f.id === 'QM007'), `${goodLine.trim()} stays quiet`);
  }
});

test('QM008 emits one finding per undeclared variable', () => {
  const yaml = svcBlock(['    volumes:', '      - data-a:/a', '      - data-b:/b']);
  const findings = lintCompose(yaml, {}, {});
  assert.equal(findings.filter((f) => f.id === 'QM008').length, 2);
  assert.ok(!findings.some((f) => f.id === 'QM012'));
  assert.match(parseCompose(yaml).error, /undeclared named volume/);
});

test('QM011 respects defaults and supplied values', () => {
  const withDefault = lintCompose(svcBlock(['    environment:', '      TZ_NAME: ${TZ_NAME:-Etc/UTC}']), {}, {});
  assert.ok(!withDefault.some((f) => f.id === 'QM011'));
  const supplied = lintCompose(svcBlock(['    environment:', '      TARGET: ${TARGET}']), { TARGET: 'set' }, {});
  assert.ok(!supplied.some((f) => f.id === 'QM011'));
  const empty = lintCompose(svcBlock(['    environment:', '      TARGET: ${TARGET}']), { TARGET: '' }, {});
  assert.ok(empty.some((f) => f.id === 'QM011'), 'an empty supplied value is not a value');
});

test('QM012 matches parser line and message', () => {
  const odd = lintCompose('services:\n  app:\n   image: example/app:1.0\n', {}, {});
  const row = odd.find((f) => f.id === 'QM012');
  assert.ok(row);
  assert.equal(row.line, 3);
  assert.match(row.message, /odd indentation/);
  const noImage = lintCompose('services:\n  app:\n    restart: always\n', {}, {});
  assert.match(noImage.find((f) => f.id === 'QM012').message, /has no image/);
});

test('invalid input returns findings', () => {
  for (const junk of [null, undefined, 12345, {}, '', '\u0000\u0001\u0002', '- - -\n\t\t', 'a'.repeat(300000), ':\n:\n:\n']) {
    let findings;
    assert.doesNotThrow(() => { findings = lintCompose(junk, null, null); });
    assert.ok(Array.isArray(findings));
    for (const f of findings) {
      assert.match(f.id, /^QM0(0[1-9]|1[0-2])$/);
      assert.ok(['error', 'warn', 'info'].includes(f.severity));
    }
  }
});

test('findings arrive sorted by line and capped', () => {
  const lines = ['services:'];
  for (let i = 0; i < 300; i += 1) {
    lines.push(`  app${i}:`, '    image: example/app');
  }
  const findings = lintCompose(lines.join('\n'), {}, {});
  assert.ok(findings.length <= 200, 'the findings list is bounded');
  for (let i = 1; i < findings.length; i += 1) {
    assert.ok(findings[i].line >= findings[i - 1].line, 'sorted by line');
  }
});
