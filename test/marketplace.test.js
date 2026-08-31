import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

process.env.SECRET_KEY ||= '33'.repeat(32);
process.env.QM_HOST ||= '192.168.1.20';
process.env.DATA_DIR ||= mkdtempSync(join(tmpdir(), 'qm-marketplace-test-'));
const testDataDir = process.env.DATA_DIR;
test.after(() => rmSync(testDataDir, { recursive: true, force: true }));

import { PORTS, labelFor, schemeFor } from '../src/kinds.js';
import { parseCompose } from '../src/compose.js';

const { parsePortainerTemplates, templateCompose, templateProjectUrl, stackfileUrl, fetchTemplateSource } = await import('../src/templates.js');
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
  MARKETPLACE_ENTRIES,
  MARKETPLACE_MODES,
  groupMarketplace,
  listMarketplace,
  marketplaceEntry,
  marketplacePresentation,
  reviewedStarterCompose,
} from '../src/marketplace.js';
import { deployableKinds } from '../src/starters.js';

test('covers each supported catalogue kind once', () => {
  const catalogueKinds = MARKETPLACE_ENTRIES.map(({ kind }) => kind);
  assert.deepEqual([...catalogueKinds].sort(), Object.keys(PORTS).sort());
  assert.equal(new Set(catalogueKinds).size, catalogueKinds.length);

  const categories = new Set(MARKETPLACE_CATEGORIES.map(({ id }) => id));
  for (const entry of MARKETPLACE_ENTRIES) {
    assert.equal(entry.label, labelFor(entry.kind));
    assert.equal(entry.defaultPort, PORTS[entry.kind]);
    assert.equal(entry.scheme, schemeFor(entry.kind));
    assert.ok(categories.has(entry.category), `${entry.kind} has an unknown category`);
    assert.equal(entry.categoryLabel, MARKETPLACE_CATEGORY_LABELS[entry.category]);
    assert.ok(entry.description.length >= 20, `${entry.kind} needs a factual description`);
    assert.ok(entry.description.length <= 120, `${entry.kind} description is too long`);
    assert.ok(Object.isFrozen(entry));
  }
  assert.ok(Object.isFrozen(MARKETPLACE_ENTRIES));
  assert.ok(Object.isFrozen(MARKETPLACE_CATEGORIES));
});

test('publishes a curated HTTPS project link for every catalogue entry', () => {
  const expected = {
    radarr: 'https://github.com/Radarr/Radarr',
    jellyseerr: 'https://github.com/seerr-team/seerr',
    musicseerr: 'https://github.com/DroppedNeedle/DroppedNeedle',
    portainer: 'https://github.com/portainer/portainer',
    dozzle: 'https://github.com/amir20/dozzle',
    dockhand: 'https://github.com/Finsys/dockhand',
    komodo: 'https://github.com/moghtech/komodo',
    arcane: 'https://github.com/getarcaneapp/arcane',
    gluetun: 'https://github.com/passteque/gluetun',
    unifi: 'https://ui.com/download',
    synology: 'https://www.synology.com/en-global/dsm',
    ugreen: 'https://www.ugreen.com/en-gb/collections/uk-nas',
    immich: 'https://github.com/immich-app/immich',
  };
  assert.equal(MARKETPLACE_ENTRIES.length, Object.keys(PORTS).length);
  for (const entry of MARKETPLACE_ENTRIES) {
    assert.ok(entry.upstreamUrl, `${entry.kind} needs a project link`);
    const url = new URL(entry.upstreamUrl);
    assert.equal(url.protocol, 'https:', entry.kind);
    assert.equal(url.username, '', entry.kind);
    assert.equal(url.password, '', entry.kind);
  }
  for (const [kind, href] of Object.entries(expected)) {
    assert.equal(marketplaceEntry(kind).upstreamUrl, href);
  }
});

test('lists starters only for supported single-container services', () => {
  const reviewedKinds = MARKETPLACE_ENTRIES
    .filter(({ mode }) => mode === MARKETPLACE_MODES.REVIEWED_STARTER)
    .map(({ kind }) => kind)
    .sort();
  assert.deepEqual(reviewedKinds, ['jellyfin', 'prowlarr', 'tautulli']);

  for (const kind of deployableKinds()) {
    const entry = marketplaceEntry(kind);
    if (reviewedKinds.includes(kind)) continue;
    assert.equal(entry.mode, MARKETPLACE_MODES.GENERATED_STARTER, kind);
    assert.equal(entry.hasStarter, true, kind);
    assert.equal(entry.actionLabel, 'Review Compose', kind);
    assert.equal(entry.starter.reviewRequired, true, kind);
    assert.ok(entry.starter && typeof entry.starter.yaml === 'string' && entry.starter.yaml.includes('services:'), kind);
  }

  for (const kind of ['proxmox', 'truenas', 'synology', 'unraid', 'ugreen', 'immich', 'komodo']) {
    const entry = marketplaceEntry(kind);
    assert.equal(entry.mode, MARKETPLACE_MODES.CONNECT_ONLY, kind);
    assert.equal(entry.starter, null, kind);
    assert.equal(entry.hasStarter, false, kind);
    assert.ok(typeof entry.blocked === 'string' && entry.blocked.length > 0, kind);
  }
  assert.equal(reviewedStarterCompose('not-a-service'), null);
});

test('socket-dependent tools remain connect-only', () => {
  const socketKinds = ['portainer', 'dozzle', 'dockhand', 'arcane', 'glances'];
  for (const kind of socketKinds) {
    assert.ok(!deployableKinds().includes(kind), `${kind} must not be deployable`);
    const entry = marketplaceEntry(kind);
    assert.equal(entry.mode, MARKETPLACE_MODES.CONNECT_ONLY, kind);
    assert.equal(entry.starter, null, kind);
    assert.equal(entry.hasStarter, false, kind);
    assert.equal(entry.actionLabel, 'Service details', kind);
    assert.match(entry.blocked, /socket/i, kind);
  }
  for (const kind of deployableKinds()) {
    const yamlText = marketplaceEntry(kind).starter.yaml;
    assert.doesNotMatch(yamlText, /docker\.sock/, `${kind} starter must not mount the docker socket`);
  }
});

test('defines deterministic reviewed single-container starters', () => {
  for (const kind of ['jellyfin', 'prowlarr', 'tautulli']) {
    const entry = marketplaceEntry(kind);
    const first = reviewedStarterCompose(kind);
    const second = reviewedStarterCompose(kind);
    assert.equal(first, second);
    assert.equal(entry.actionLabel, 'Review starter');
    assert.equal(entry.connectOnly, false);
    assert.equal(entry.hasReviewedStarter, true);
    assert.equal(entry.starter.reviewRequired, true);
    assert.equal(entry.starter.serviceCount, 1);
    assert.ok(entry.starter.reviewNotes.length >= 2);
    assert.ok(Object.isFrozen(entry.starter));
    assert.ok(Object.isFrozen(entry.starter.reviewNotes));
    assert.match(first, /^services:\n/);
    assert.match(first, new RegExp(`      - "${PORTS[kind]}:${PORTS[kind]}"`));
    assert.match(first, /    restart: unless-stopped\n/);
    assert.match(first, /    volumes:\n/);
    assert.match(first, /^volumes:\n/m);
    const parsed = parseCompose(first);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ignored, []);
    assert.ok(parsed.volumes.length >= 1);
    assert.ok(first.endsWith('\n'));
  }
  assert.match(reviewedStarterCompose('prowlarr'), /image: lscr\.io\/linuxserver\/prowlarr:latest/);
  assert.match(reviewedStarterCompose('tautulli'), /image: lscr\.io\/linuxserver\/tautulli:latest/);
  assert.match(reviewedStarterCompose('jellyfin'), /image: jellyfin\/jellyfin:latest/);
  assert.doesNotMatch(reviewedStarterCompose('jellyfin'), /\/media/);
  assert.match(marketplaceEntry('jellyfin').starter.reviewNotes.join(' '), /Add media mounts/);
});

test('uses consistent Marketplace deployment and pairing state', () => {
  const reviewed = marketplaceEntry('prowlarr');
  const generated = marketplaceEntry('radarr');
  const connectOnly = marketplaceEntry('portainer');

  const cases = [
    {
      name: 'reviewed starter with control', entry: reviewed,
      context: { control: true, detectionKnown: true },
      expected: { state: 'reviewed-deployable', badgeLabel: 'Reviewed starter', actionLabel: 'Review and deploy', canDeploy: true, composeTitle: 'Reviewed Compose starter' },
    },
    {
      name: 'reviewed starter in read-only mode', entry: reviewed,
      context: { control: false, detectionKnown: true },
      expected: { state: 'reviewed-preview', badgeLabel: 'Preview only', actionLabel: 'Review starter', canDeploy: false, composeTitle: 'Reviewed Compose starter' },
    },
    {
      name: 'generated starter with control', entry: generated,
      context: { control: true, detectionKnown: true },
      expected: { state: 'generated-deployable', badgeLabel: 'Generated starting point', actionLabel: 'Review Compose', canDeploy: true, composeTitle: 'Generated Compose starting point' },
    },
    {
      name: 'generated starter in read-only mode', entry: generated,
      context: { control: false, detectionKnown: true },
      expected: { state: 'generated-preview', badgeLabel: 'Preview only', actionLabel: 'Review Compose', canDeploy: false, composeTitle: 'Generated Compose starting point' },
    },
    {
      name: 'starter while Docker is unavailable', entry: reviewed,
      context: { control: true, detectionKnown: false },
      expected: { state: 'detection-unavailable', badgeLabel: 'Detection unavailable', actionLabel: 'Review Compose', canDeploy: false, composeTitle: 'Reviewed Compose starter' },
    },
    {
      name: 'installed service ready for scan', entry: generated,
      context: { installed: true, control: true, detectionKnown: true, credentialState: 'included' },
      expected: { state: 'installed-included', badgeLabel: 'Ready for scan', actionLabel: 'Review setup', canDeploy: false, credentialState: 'included' },
    },
    {
      name: 'installed service needs no key', entry: connectOnly,
      context: { installed: true, control: true, detectionKnown: true, credentialState: 'not-required' },
      expected: { state: 'installed-no-key', badgeLabel: 'No key needed', actionLabel: 'Review setup', canDeploy: false, credentialState: 'not-required' },
    },
    {
      name: 'installed service signs in after pairing', entry: generated,
      context: { installed: true, control: true, detectionKnown: true, credentialState: 'sign-in' },
      expected: { state: 'installed-sign-in', badgeLabel: 'Sign in after pairing', actionLabel: 'Review setup', canDeploy: false, credentialState: 'sign-in' },
    },
    {
      name: 'installed service needs a key and secret', entry: marketplaceEntry('komodo'),
      context: { installed: true, control: true, detectionKnown: true, credentialState: 'key-and-secret' },
      expected: { state: 'installed-credentials', badgeLabel: 'Credentials needed', actionLabel: 'Resolve in setup', canDeploy: false, credentialState: 'key-and-secret' },
    },
    {
      name: 'installed service missing a key', entry: generated,
      context: { installed: true, control: true, detectionKnown: true, credentialState: 'missing-key' },
      expected: { state: 'installed-missing-key', badgeLabel: 'Needs a key', actionLabel: 'Resolve in setup', canDeploy: false, credentialState: 'missing-key' },
    },
    {
      name: 'installed service with conflicting keys', entry: reviewed,
      context: { installed: true, control: true, detectionKnown: true, credentialState: 'conflict' },
      expected: { state: 'installed-conflict', badgeLabel: 'Check key sources', actionLabel: 'Resolve in setup', canDeploy: false, credentialState: 'conflict' },
    },
    {
      name: 'connect-only service', entry: connectOnly,
      context: { control: true, detectionKnown: true },
      expected: { state: 'connection-support', badgeLabel: 'External setup', actionLabel: 'View details', canDeploy: false, composeTitle: '' },
    },
    {
      name: 'community template with control', entry: { hasStarter: true },
      context: { community: true, hasStarter: true, control: true, detectionKnown: true },
      expected: { state: 'community', badgeLabel: 'Community, unreviewed', actionLabel: 'Review template', canDeploy: true, composeTitle: 'Community template Compose file' },
    },
    {
      name: 'community template without Compose', entry: { hasStarter: false },
      context: { community: true, hasStarter: false, control: true, detectionKnown: true },
      expected: { state: 'community', badgeLabel: 'Community, unreviewed', actionLabel: 'Review template', canDeploy: false, composeTitle: 'Community template Compose file' },
    },
  ];

  for (const row of cases) {
    const actual = marketplacePresentation(row.entry, row.context);
    for (const [key, value] of Object.entries(row.expected)) assert.equal(actual[key], value, `${row.name}: ${key}`);
    assert.ok(Object.isFrozen(actual), `${row.name}: presentation is immutable`);
  }
});

test('omits unavailable deployment and review claims', () => {
  const entries = [marketplaceEntry('prowlarr'), marketplaceEntry('radarr'), marketplaceEntry('portainer')];
  for (const entry of entries) {
    for (const installed of [false, true]) {
      for (const control of [false, true]) {
        for (const detectionKnown of [false, true]) {
          const view = marketplacePresentation(entry, { installed, control, detectionKnown, credentialState: 'included' });
          const expectedDeploy = entry.hasStarter && !installed && control && detectionKnown;
          assert.equal(view.canDeploy, expectedDeploy, `${entry.kind}: installed=${installed} control=${control} detectionKnown=${detectionKnown}`);
          if (!expectedDeploy) assert.doesNotMatch(view.actionLabel, /^Deploy$/u);
          if (entry.mode !== MARKETPLACE_MODES.REVIEWED_STARTER) {
            assert.doesNotMatch(view.badgeLabel, /^Reviewed/u);
            assert.doesNotMatch(view.composeTitle, /^Reviewed/u);
          }
        }
      }
    }
  }

  for (const control of [false, true]) {
    for (const detectionKnown of [false, true]) {
      const community = marketplacePresentation({ hasStarter: true }, { community: true, hasStarter: true, control, detectionKnown });
      assert.equal(community.canDeploy, control && detectionKnown);
      assert.equal(community.actionLabel, 'Review template');
      assert.equal(community.actionTarget, 'details');
      assert.doesNotMatch(community.composeTitle, /^Reviewed/u);
    }
  }
});

test('selects the strongest pairing issue per catalogue kind', () => {
  const view = marketplacePresentation(marketplaceEntry('radarr'), {
    installed: true,
    control: true,
    detectionKnown: true,
    credentialStates: ['included', 'missing-key', 'not-required'],
  });
  assert.equal(view.state, 'installed-missing-key');
  assert.equal(view.badgeLabel, 'Needs a key');
  assert.equal(view.canDeploy, false);
});

test('filters and groups catalogue entries without mutation', () => {
  const detected = [{ kind: 'radarr' }, 'tautulli', { kind: 'unknown' }];
  const first = listMarketplace({ query: 'librar', category: 'media-automation', detectedKinds: detected });
  const second = listMarketplace({ query: 'librar', category: 'media-automation', detectedKinds: detected });
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ kind }) => kind), ['bazarr', 'lidarr', 'maintainerr', 'radarr', 'sonarr', 'tdarr']);
  assert.equal(first.find(({ kind }) => kind === 'radarr').installed, true);
  assert.equal(first.find(({ kind }) => kind === 'sonarr').installed, false);
  assert.equal(marketplaceEntry('radarr').installed, undefined);
  assert.ok(Object.isFrozen(first));
  assert.ok(first.every(Object.isFrozen));

  const groups = groupMarketplace({ query: 'Docker', detectedKinds: ['portainer'] });
  assert.deepEqual(groups.map(({ id }) => id), ['containers', 'infrastructure']);
  assert.equal(groups[0].entries.find(({ kind }) => kind === 'portainer').installed, true);
  assert.ok(Object.isFrozen(groups));
  assert.ok(groups.every((group) => Object.isFrozen(group) && Object.isFrozen(group.entries)));
});

test('portainer v2 template documents are parsed defensively', () => {
  const doc = JSON.stringify({
    version: '2',
    templates: [
      {
        type: 1, title: 'Uptime Kuma', name: 'uptime-kuma', description: 'Status monitoring.',
        project_url: 'https://github.com/louislam/uptime-kuma',
        categories: ['Monitoring'], image: 'louislam/uptime-kuma:1', restart_policy: 'unless-stopped',
        ports: ['3001:3001/tcp'], volumes: [{ container: '/app/data' }],
        env: [{ name: 'TZ', default: 'Etc/UTC' }, { name: 'not a name!' }, 'junk'],
      },
      { type: 2, title: 'Swarm thing', image: 'x' },
      { type: 3, title: 'Immich stack', repository: { url: 'https://github.com/example/templates', stackfile: 'stacks/immich/docker-compose.yml' } },
      { type: 1, title: '' },
      { type: 1, title: 'No image' },
      'garbage', null, 42,
    ],
  });
  const parsed = parsePortainerTemplates(doc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].title, 'Uptime Kuma');
  assert.equal(parsed.entries[0].projectUrl, 'https://github.com/louislam/uptime-kuma');
  assert.deepEqual(parsed.entries[0].env, [{ name: 'TZ', default: 'Etc/UTC' }], 'bad env names are dropped');
  assert.equal(parsed.entries[1].type, 3);
  assert.equal(parsed.entries[1].projectUrl, 'https://github.com/example/templates');

  assert.equal(parsePortainerTemplates('not json').ok, false);
  assert.equal(parsePortainerTemplates('[]').ok, false);
  assert.equal(parsePortainerTemplates(JSON.stringify({ version: '3', templates: [] })).ok, false, 'only v2 is supported');
  assert.equal(parsePortainerTemplates(JSON.stringify({ version: '2' })).ok, false, 'a missing templates array is refused');
  const flood = JSON.stringify({ version: '2', templates: Array.from({ length: 900 }, (_, i) => ({ type: 1, title: `t${i}`, image: 'x/y:1' })) });
  assert.ok(parsePortainerTemplates(flood).entries.length <= 200, 'entries are capped');
});

test('normalises only explicit safe community project links', () => {
  assert.equal(templateProjectUrl({ project_url: 'https://github.com/example/app.git?token=private#readme' }), 'https://github.com/example/app');
  assert.equal(templateProjectUrl({ homepage: 'https://example.com/app/' }), 'https://example.com/app');
  assert.equal(templateProjectUrl({ maintainer: 'https://github.com/example/maintainer' }), 'https://github.com/example/maintainer');
  assert.equal(templateProjectUrl({ repository: { url: 'https://github.com/example/templates.git' } }), 'https://github.com/example/templates');
  assert.equal(templateProjectUrl({ project_url: 'javascript:alert(1)', maintainer: 'https://github.com/example/safe' }), 'https://github.com/example/safe');
  assert.equal(templateProjectUrl({ project_url: 'http://example.com/app' }), null);
  assert.equal(templateProjectUrl({ project_url: 'https://user:password@example.com/app' }), null);
  assert.equal(templateProjectUrl(null), null);
});

test('translates type-1 templates into deployable Compose previews', () => {
  const yaml = templateCompose({
    type: 1, title: 'Uptime Kuma', name: 'uptime-kuma', image: 'louislam/uptime-kuma:1',
    restartPolicy: 'unless-stopped', ports: ['3001:3001', '80/tcp', 'junk'],
    volumes: [{ container: '/app/data', bind: '' }, { container: '/etc/localtime', bind: '/etc/localtime', readonly: true }, { container: 'relative-junk' }],
    env: [{ name: 'TZ', default: 'Etc/UTC' }, { name: 'ADMIN_TOKEN', default: '' }],
  });
  assert.match(yaml, /^# Imported from a Portainer template/);
  assert.match(yaml, /image: louislam\/uptime-kuma:1/);
  assert.match(yaml, /restart: unless-stopped/);
  assert.match(yaml, /- "3001:3001"/);
  assert.doesNotMatch(yaml, /80\/tcp|junk/, 'container-only and junk ports are dropped');
  assert.match(yaml, /- uptime-kuma-data:\/app\/data/);
  assert.match(yaml, /- \/etc\/localtime:\/etc\/localtime:ro/);
  assert.match(yaml, /TZ: "Etc\/UTC"/);
  assert.match(yaml, /ADMIN_TOKEN: \$\{ADMIN_TOKEN\}/);
  assert.match(yaml, /^volumes:\n {2}uptime-kuma-data:\n/m);
  const parsed = parseCompose(yaml);
  assert.equal(parsed.ok, true, parsed.error || '');
  assert.deepEqual(parsed.ignored, []);
  assert.equal(templateCompose({ type: 3, title: 'stack' }), null);
  assert.equal(templateCompose(null), null);
});

test('stackfile URLs are derived only for plain github repositories', () => {
  assert.equal(
    stackfileUrl({ url: 'https://github.com/example/templates', stackfile: 'stacks/immich/docker-compose.yml' }),
    'https://raw.githubusercontent.com/example/templates/HEAD/stacks/immich/docker-compose.yml',
  );
  assert.equal(stackfileUrl({ url: 'https://github.com/example/templates.git', stackfile: 'compose.yml' }), 'https://raw.githubusercontent.com/example/templates/HEAD/compose.yml');
  assert.equal(stackfileUrl({ url: 'https://gitlab.com/example/templates', stackfile: 'compose.yml' }), null, 'other forges are not fetchable');
  assert.equal(stackfileUrl({ url: 'https://github.com/example/templates', stackfile: '../secrets.yml' }), null);
  assert.equal(stackfileUrl({ url: 'https://github.com/example', stackfile: 'compose.yml' }), null);
  assert.equal(stackfileUrl({ url: 'http://github.com/example/templates', stackfile: 'compose.yml' }), null);
  assert.equal(stackfileUrl(null), null);
});

function fakeHttps(answers, seen = []) {
  let call = 0;
  return (options, callback) => {
    seen.push(options);
    const spec = answers[Math.min(call, answers.length - 1)];
    call += 1;
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = spec.status || 200;
      response.headers = spec.headers || {};
      callback(response);
      queueMicrotask(() => {
        if (response.destroyed) return;
        if (spec.body) response.write(spec.body);
        response.end();
      });
    };
    return request;
  };
}

test('fetches template sources and GitHub stackfiles through pinned transport', async () => {
  const doc = JSON.stringify({
    version: '2',
    templates: [
      { type: 1, title: 'Kuma', image: 'louislam/uptime-kuma:1' },
      { type: 3, title: 'Immich', repository: { url: 'https://github.com/example/templates', stackfile: 'stacks/immich.yml' } },
      { type: 3, title: 'Elsewhere', repository: { url: 'https://gitlab.com/x/y', stackfile: 'c.yml' } },
    ],
  });
  const stackYaml = 'services:\n  immich:\n    image: ghcr.io/immich-app/immich-server:v1.99.0\n';
  const seen = [];
  const result = await fetchTemplateSource('https://templates.example.com/v2.json', {
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
    request: fakeHttps([{ body: doc }, { body: stackYaml }], seen),
  });
  assert.equal(result.ok, true, result.error || '');
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[1].yaml, stackYaml);
  assert.equal(result.entries[2].yaml, undefined, 'an unfetchable repository stays yaml-less');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].hostname, '1.1.1.1', 'the validated DNS answer is pinned');
  assert.equal(seen[0].headers.host, 'templates.example.com');
  assert.equal(seen[1].headers.host, 'raw.githubusercontent.com');
});

test('rejects unsafe template source responses', async () => {
  const lookup = async () => [{ address: '1.1.1.1', family: 4 }];
  const redirected = await fetchTemplateSource('https://templates.example.com/v2.json', {
    lookup, request: fakeHttps([{ status: 302, headers: { location: 'https://elsewhere.example/' } }]),
  });
  assert.equal(redirected.ok, false);
  assert.match(redirected.error, /redirects/);
  const upstream = await fetchTemplateSource('https://templates.example.com/v2.json', {
    lookup, request: fakeHttps([{ status: 500, body: 'boom' }]),
  });
  assert.equal(upstream.ok, false);
  assert.match(upstream.error, /500/);
  let sockets = 0;
  const priv = await fetchTemplateSource('https://templates.example.com/v2.json', {
    lookup: async () => [{ address: '192.168.1.20', family: 4 }],
    request: () => { sockets += 1; throw new Error('must not connect'); },
  });
  assert.equal(priv.ok, false);
  assert.equal(sockets, 0);
  const plain = await fetchTemplateSource('http://templates.example.com/v2.json', {
    lookup, request: () => { sockets += 1; throw new Error('must not connect'); },
  });
  assert.equal(plain.ok, false);
  assert.equal(sockets, 0, 'plain http is refused before DNS');
});
