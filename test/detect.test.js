import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeDetectedServices, mergeLiveProbes, configFileRule, applyMintedKeys, availabilityFor, publishedPortOf } from '../src/detect.js';
import { fingerprintsFor, schemeForKindPort } from '../src/probe.js';

test('CrowdSec uses its public health endpoint', () => {
  const [fingerprint] = fingerprintsFor('crowdsec');
  assert.equal(fingerprint.port, 8080);
  assert.equal(fingerprint.path, '/health');
  assert.equal(fingerprint.sig.test('{"status":"up"}'), true);
});

function docker(name, publishedPort, apiKey) {
  return {
    kind: 'radarr', name, identity: `docker:${name}`, aliases: [name.replace(/[^a-z0-9]/gi, '').toLowerCase()],
    publishedPort, apiKey, sources: ['docker'],
  };
}

function config(name, configPort, apiKey) {
  return {
    kind: 'radarr', name, identity: `config:/stack/${name}`, aliases: [name.replace(/[^a-z0-9]/gi, '').toLowerCase()],
    configPort, apiKey, sources: ['config'],
  };
}

test('same-kind instances retain unique credential matches', () => {
  const rows = mergeDetectedServices(
    [docker('radarr-hd', 17878, undefined), docker('radarr-4k', 27878, undefined)],
    [config('radarr-hd', 7878, 'key-hd'), config('radarr-4k', 8787, 'key-4k')],
  );
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.instanceId)).size, 2);
  assert.equal(rows.find((row) => row.name === 'radarr-hd').apiKey, 'key-hd');
  assert.equal(rows.find((row) => row.name === 'radarr-4k').apiKey, 'key-4k');
  assert.equal(rows.find((row) => row.name === 'radarr-hd').port, 17878);
  assert.deepEqual(rows.find((row) => row.name === 'radarr-hd').sources, ['docker', 'config']);
});

test('ambiguous config keys are not assigned', () => {
  const rows = mergeDetectedServices(
    [docker('radarr-a', 17878, undefined), docker('radarr-b', 27878, undefined)],
    [config('radarr', 7878, 'do-not-guess')],
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.apiKey === 'do-not-guess').length, 1);
  assert.equal(rows.find((row) => row.apiKey === 'do-not-guess').sources[0], 'config');
  assert.equal(rows.filter((row) => row.sources.includes('docker')).every((row) => !row.apiKey), true);
});

test('port priority is published, then config, then the service default', () => {
  const published = mergeDetectedServices([docker('radarr', 17878)], [config('radarr', 27878, 'key')])[0];
  assert.equal(published.port, 17878);
  const configured = mergeDetectedServices([docker('radarr', undefined)], [config('radarr', 27878, 'key')])[0];
  assert.equal(configured.port, 27878);
  const fallback = mergeDetectedServices([docker('radarr', undefined)], [])[0];
  assert.equal(fallback.port, 7878);
});

test('file credential rules cover all three additions', () => {
  assert.deepEqual(configFileRule('tautulli'), { sourcePath: '/config/config.ini', mountedName: 'config.ini', maxBytes: 512 * 1024, format: 'tautulli-ini' });
  assert.deepEqual(configFileRule('jackett'), { sourcePath: '/config/Jackett/ServerConfig.json', mountedName: 'ServerConfig.json', maxBytes: 512 * 1024, format: 'jackett-json' });
  assert.deepEqual(configFileRule('nzbhydra2'), { sourcePath: '/config/nzbhydra.yml', mountedName: 'nzbhydra.yml', maxBytes: 512 * 1024, format: 'nzbhydra-yaml' });
  assert.equal(configFileRule('plex'), undefined);
});

test('merges minted keys and removes stale records', () => {
  const services = [
    { instanceId: 'jellyfin-1', kind: 'jellyfin', name: 'Jellyfin' },
    { instanceId: 'radarr-1', kind: 'radarr', name: 'Radarr', apiKey: 'file-key' },
    { instanceId: 'sonarr-1', kind: 'sonarr', name: 'Sonarr', apiKey: undefined, credentialConflict: true },
    { instanceId: 'prowlarr-1', kind: 'prowlarr', name: 'Prowlarr' },
  ];
  const minted = {
    'jellyfin-1': { kind: 'jellyfin', apiKey: 'minted-key' },
    'radarr-1': { kind: 'radarr', apiKey: 'stale-mint-key' },
    'sonarr-1': { kind: 'sonarr', apiKey: 'never-applied' },
  };
  const { services: rows, stale } = applyMintedKeys(services, minted);
  assert.equal(rows.find((r) => r.instanceId === 'jellyfin-1').apiKey, 'minted-key', 'a gap is filled from the mint');
  assert.equal(rows.find((r) => r.instanceId === 'radarr-1').apiKey, 'file-key', 'the authoritative file key wins');
  assert.equal(rows.find((r) => r.instanceId === 'sonarr-1').apiKey, undefined);
  assert.equal(rows.find((r) => r.instanceId === 'prowlarr-1').apiKey, undefined, 'a row with no record is untouched');
  assert.deepEqual(stale, ['radarr-1']);
});

test('live probes add status without replacing a known custom port', () => {
  const local = mergeDetectedServices([docker('radarr', 17878)], []);
  const rows = mergeLiveProbes(local, [{ kind: 'radarr', port: 7878, up: true, url: 'http://nas:7878' }], 'nas');
  assert.equal(rows.find((row) => row.sources.includes('docker')).port, 17878);
  assert.equal(rows.find((row) => row.sources.includes('docker')).up, null);
  assert.equal(rows.find((row) => row.sources.includes('probe')).port, 7878);
});

test('failed and unconfirmed probes update the matching row', () => {
  const local = mergeDetectedServices([docker('radarr', 7878), { ...docker('sonarr', 8989), kind: 'sonarr' }], []);
  const rows = mergeLiveProbes(local, [
    { kind: 'radarr', port: 7878, up: false, confirmed: false, url: 'http://nas:7878' },
    { kind: 'sonarr', port: 8989, up: true, confirmed: false, url: 'http://nas:8989' },
    { kind: 'prowlarr', port: 9696, up: false, confirmed: false, url: 'http://nas:9696' },
  ], 'nas');
  const radarr = rows.find((row) => row.kind === 'radarr');
  assert.equal(radarr.up, false, 'the stopped service reaches the page as offline');
  assert.equal(radarr.url, 'http://nas:7878');
  assert.equal(rows.find((row) => row.kind === 'sonarr').up, null);
  assert.equal(rows.some((row) => row.kind === 'prowlarr'), false);
});

test('a stopped container stays offline through the docker and file merge', () => {
  const stopped = { ...docker('radarr-hd', 17878), up: false };
  const rows = mergeLiveProbes(mergeDetectedServices([stopped], [config('radarr-hd', 7878, 'key-hd')]), [], 'nas');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].apiKey, 'key-hd');
  assert.equal(rows[0].up, false);
  const running = mergeLiveProbes(mergeDetectedServices([docker('radarr-hd', 17878)], []), [], 'nas');
  assert.equal(running[0].up, null);
});

test('Docker lifecycle state determines availability', () => {
  const states = { running: 'reachable', exited: 'not-running', created: 'not-running', paused: 'not-running', restarting: 'not-running', dead: 'not-running', removing: 'not-running' };
  for (const [state, expected] of Object.entries(states)) {
    const raw = { ...docker(`radarr-${state}`, 17878), dockerState: state, up: state === 'running' ? undefined : false };
    const [row] = mergeLiveProbes(mergeDetectedServices([raw], []), state === 'running' ? [{ kind: 'radarr', port: 17878, up: true, confirmed: true, url: 'http://nas:17878' }] : [], 'nas');
    assert.equal(row.dockerState, state, `${state} survives detection verbatim`);
    assert.equal(row.availability, expected, `${state} derives ${expected}`);
    if (state !== 'running') assert.equal(row.up, false, `${state} can never answer`);
  }
  assert.equal(availabilityFor({ dockerState: 'running', up: true }), 'reachable');
  assert.equal(availabilityFor({ dockerState: 'running', up: false }), 'unreachable');
  assert.equal(availabilityFor({ dockerState: 'running', up: null }), 'unverified', 'running with no probe verdict is unverified');
  assert.equal(availabilityFor({ dockerState: 'running' }), 'unverified');
  assert.equal(availabilityFor({ dockerState: 'exited', up: true }), 'not-running', 'Docker wins over anything a probe saw');
  assert.equal(availabilityFor({ up: true }), 'unverified');
  assert.equal(availabilityFor({ up: false }), 'unverified');
  assert.equal(availabilityFor({}), 'unverified');
});

test('requires probe confirmation before marking a container reachable', () => {
  const local = mergeDetectedServices([{ ...docker('radarr', 7878), dockerState: 'running' }, { ...docker('sonarr', 8989), kind: 'sonarr', dockerState: 'running' }, { ...docker('lidarr', 8686), kind: 'lidarr', dockerState: 'running' }], []);
  assert.equal(local.every((row) => row.availability === 'unverified'), true);
  const rows = mergeLiveProbes(local, [
    { kind: 'radarr', port: 7878, up: true, confirmed: true, url: 'http://nas:7878' },
    { kind: 'sonarr', port: 8989, up: false, confirmed: false, url: 'http://nas:8989' },
    { kind: 'lidarr', port: 8686, up: true, confirmed: false, url: 'http://nas:8686' },
  ], 'nas');
  assert.equal(rows.find((row) => row.kind === 'radarr').availability, 'reachable');
  assert.equal(rows.find((row) => row.kind === 'sonarr').availability, 'unreachable');
  assert.equal(rows.find((row) => row.kind === 'lidarr').availability, 'unverified');
});

test('config-only and probe-only rows remain unverified', () => {
  const rows = mergeLiveProbes(mergeDetectedServices([], [config('radarr', 7878, 'key')]), [
    { kind: 'radarr', port: 7878, up: true, confirmed: true, url: 'http://nas:7878' },
    { kind: 'sonarr', port: 8989, up: true, confirmed: true, url: 'http://nas:8989' },
  ], 'nas');
  const radarr = rows.find((row) => row.kind === 'radarr');
  assert.equal(radarr.availability, 'unverified');
  assert.equal(radarr.dockerState, undefined, 'no Docker evidence, no state');
  assert.equal(radarr.up, true, 'the probe result is preserved');
  const failed = mergeLiveProbes(mergeDetectedServices([], [config('radarr', 7878, 'key')]), [{ kind: 'radarr', port: 7878, up: false, confirmed: false, url: 'http://nas:7878' }], 'nas');
  assert.equal(failed[0].availability, 'unverified');
  assert.equal(rows.find((row) => row.sources.includes('probe')).availability, 'unverified', 'a probe-only row has no Docker evidence');
});

test('merge preserves stopped-container lifecycle state', () => {
  const stopped = { ...docker('radarr-hd', undefined), dockerState: 'paused', up: false };
  const rows = mergeLiveProbes(mergeDetectedServices([stopped], [config('radarr-hd', 7878, 'key-hd')]), [
    { kind: 'radarr', port: 7878, up: true, confirmed: true, url: 'http://nas:7878' },
  ], 'nas');
  const merged = rows.find((row) => row.sources.includes('config'));
  assert.deepEqual(merged.sources, ['docker', 'config']);
  assert.equal(merged.dockerState, 'paused');
  assert.equal(merged.availability, 'not-running');
  assert.equal(merged.up, false);
  const extra = rows.find((row) => row.sources.includes('probe'));
  assert.ok(extra);
  assert.equal(extra.availability, 'unverified');
});

test('a dual-stack published port is one port, not two', () => {
  const dualStack = [
    { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 7979, Type: 'tcp' },
    { IP: '::', PrivatePort: 80, PublicPort: 7979, Type: 'tcp' },
  ];
  assert.equal(publishedPortOf(dualStack, 'audiobookshelf'), 7979, 'the remapped port survives');
});

test('default internal port wins among published ports', () => {
  const ports = [
    { IP: '0.0.0.0', PrivatePort: 7878, PublicPort: 7878, Type: 'tcp' },
    { IP: '::', PrivatePort: 7878, PublicPort: 7878, Type: 'tcp' },
    { IP: '0.0.0.0', PrivatePort: 9999, PublicPort: 9999, Type: 'tcp' },
  ];
  assert.equal(publishedPortOf(ports, 'radarr'), 7878);
});

test('ambiguous published ports do not produce a route', () => {
  const ports = [
    { IP: '0.0.0.0', PrivatePort: 111, PublicPort: 1111, Type: 'tcp' },
    { IP: '::', PrivatePort: 111, PublicPort: 1111, Type: 'tcp' },
    { IP: '0.0.0.0', PrivatePort: 222, PublicPort: 2222, Type: 'tcp' },
    { IP: '::', PrivatePort: 222, PublicPort: 2222, Type: 'tcp' },
  ];
  assert.equal(publishedPortOf(ports, 'radarr'), undefined, 'two real mappings, no default match');
});

test('udp and unpublished ports are ignored', () => {
  assert.equal(publishedPortOf([{ PrivatePort: 80, PublicPort: 7979, Type: 'udp' }], 'audiobookshelf'), undefined);
  assert.equal(publishedPortOf([{ PrivatePort: 80, Type: 'tcp' }], 'audiobookshelf'), undefined);
  assert.equal(publishedPortOf(undefined, 'radarr'), undefined);
});

test('the handover scheme comes from the port, not the kind', () => {
  assert.equal(schemeForKindPort('portainer', 9000), 'http');
  assert.equal(schemeForKindPort('portainer', 9443), 'https');
  assert.equal(schemeForKindPort('portainer', 9000), schemeForKindPort('portainer', '9000'), 'string ports too');
  assert.equal(schemeForKindPort('radarr', 7878), 'http');
  assert.equal(schemeForKindPort('radarr', 12345), 'http');
});
