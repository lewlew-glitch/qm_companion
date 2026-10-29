import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanCheck, lanAttachments, ownId, proxyName } from '../src/network-check.js';

const self = 'abcdef123456';
const container = (id, name, networks) => ({
  Id: id, Names: [`/${name}`],
  NetworkSettings: { Networks: Object.fromEntries(Object.entries(networks).map(([net, ip]) => [net, { IPAddress: ip }])) },
});
const NETWORKS = [
  { Name: 'br0', Driver: 'macvlan' }, { Name: 'vlan20', Driver: 'ipvlan' },
  { Name: 'qm-companion', Driver: 'bridge' }, { Name: 'bridge', Driver: 'bridge' }, { Name: 'host', Driver: 'host' },
];

test('macvlan and ipvlan attachments of Companion and its proxy are reported with their addresses', () => {
  const found = lanAttachments([
    container(`${self}${'0'.repeat(52)}`, 'qm-companion', { br0: '192.168.1.2', 'qm-companion': '172.20.0.3' }),
    container('f'.repeat(64), 'qm-socket-proxy', { vlan20: '' }),
    container('e'.repeat(64), 'plex', { br0: '192.168.1.40' }),
  ], NETWORKS, { selfId: self, proxy: 'qm-socket-proxy' });
  assert.deepEqual(found, [
    { container: 'qm-companion', network: 'br0', driver: 'macvlan', ip: '192.168.1.2' },
    { container: 'qm-socket-proxy', network: 'vlan20', driver: 'ipvlan', ip: '' },
  ], 'other containers on br0 are not Companion\'s business');
});

test('bridge, user-defined bridge and host networks stay quiet, as do unreadable lists', () => {
  const quiet = [container(self, 'qm-companion', { bridge: '172.17.0.2', 'qm-companion': '172.20.0.3', host: '' })];
  assert.deepEqual(lanAttachments(quiet, NETWORKS, { selfId: self, proxy: '' }), []);
  assert.deepEqual(lanAttachments(null, NETWORKS, { selfId: self }), []);
  assert.deepEqual(lanAttachments(quiet, null, { selfId: self }), [], 'an unknown driver is never a warning');
  assert.deepEqual(lanAttachments([{ Id: self, Names: ['/qm-companion'], NetworkSettings: null }], NETWORKS, { selfId: self }), []);
  assert.deepEqual(lanAttachments([container(self, 'qm-companion', { br0: '192.168.1.2' })], NETWORKS, { selfId: '', proxy: '' }), [],
    'without its own id Companion cannot tell which container it is');
});

test('the check reads once, keeps the answer for ten minutes and never throws', async () => {
  let clock = 0, reads = 0, fail = false;
  const check = createLanCheck({ now: () => clock, identity: { selfId: self, proxy: '' }, read: async () => {
    reads++;
    if (fail) throw new Error('proxy refused');
    return [[container(self, 'qm-companion', { br0: '192.168.1.2' })], NETWORKS];
  } });
  assert.deepEqual(check.current(), []);
  assert.equal(reads, 1);
  await check.refresh();
  assert.equal(reads, 1, 'a refresh joins the read in flight');
  assert.deepEqual(check.current(), [{ container: 'qm-companion', network: 'br0', driver: 'macvlan', ip: '192.168.1.2' }]);
  clock = 599_999; check.current(); assert.equal(reads, 1);
  fail = true; clock = 600_000; check.current();
  assert.deepEqual(await check.refresh(), []); assert.equal(reads, 2);
});

test('the proxy is found by its DOCKER_HOST name and Companion by its short container id', () => {
  assert.equal(proxyName('tcp://qm-socket-proxy:2375'), 'qm-socket-proxy');
  assert.equal(proxyName('tcp://192.168.1.10:2375'), '', 'an address names no container');
  assert.equal(proxyName('/var/run/docker.sock'), '');
  assert.equal(ownId('abcdef123456'), 'abcdef123456');
  assert.equal(ownId('nas'), '', 'a hostname set in the template is not an id');
});
