import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractContainerApiKey,
  homepageCredential,
  mergeDetectedServices,
} from '../src/detect.js';
import { matchImage, pairingCredentialState } from '../src/kinds.js';

test('recognises the CrowdSec image', () => {
  assert.equal(matchImage('crowdsecurity/crowdsec:latest', 'crowdsec'), 'crowdsec');
});

test('Homepage credentials require an exact matching widget type', () => {
  assert.deepEqual(homepageCredential('radarr', {
    'homepage.widget.type': 'radarr',
    'homepage.widget.key': 'radarr-key',
  }), {
    apiKey: 'radarr-key',
    credentialConflict: false,
  });

  assert.deepEqual(homepageCredential('radarr', {
    'homepage.widget.type': 'sonarr',
    'homepage.widget.key': 'wrong-service-key',
  }), {
    apiKey: undefined,
    credentialConflict: false,
  });

  assert.deepEqual(homepageCredential('radarr', {
    'homepage.widget.type': 'radarr-helper',
    'homepage.widget.key': 'substring-must-not-match',
  }), {
    apiKey: undefined,
    credentialConflict: false,
  });

  for (const type of ['radarr:tag', 'registry/radarr']) {
    assert.deepEqual(homepageCredential('radarr', {
      'homepage.widget.type': type,
      'homepage.widget.key': 'decorated-type-must-not-match',
    }), {
      apiKey: undefined,
      credentialConflict: false,
    }, type);
  }
});

test('Homepage widgets match by type and reject conflicting keys', () => {
  assert.deepEqual(homepageCredential('radarr', {
    'homepage.widgets[0].type': 'sonarr',
    'homepage.widgets[0].key': 'sonarr-key',
    'homepage.widgets[12].type': 'radarr',
    'homepage.widgets[12].key': 'radarr-key',
  }), {
    apiKey: 'radarr-key',
    credentialConflict: false,
  });

  assert.deepEqual(homepageCredential('radarr', {
    'homepage.widget.type': 'radarr',
    'homepage.widget.key': 'first-key',
    'homepage.widgets[1].type': 'radarr',
    'homepage.widgets[1].key': 'second-key',
  }), {
    apiKey: undefined,
    credentialConflict: true,
  });

  assert.deepEqual(homepageCredential('radarr', {
    'homepage.widget.type': 'radarr',
    'homepage.widget.key': 'same-key',
    'homepage.widgets[1].type': 'radarr',
    'homepage.widgets[1].key': 'same-key',
  }), {
    apiKey: 'same-key',
    credentialConflict: false,
  });
});

test('fixed container config parsers recover only the expected key field', () => {
  const cases = [
    ['radarr', '/config/config.xml', '<Config><ApiKey>radarr-key</ApiKey></Config>', 'radarr-key'],
    ['sonarr', '/config/config.xml', '<Config><ApiKey>sonarr-key</ApiKey></Config>', 'sonarr-key'],
    ['lidarr', '/config/config.xml', '<Config><ApiKey>lidarr-key</ApiKey></Config>', 'lidarr-key'],
    ['prowlarr', '/config/config.xml', '<Config><ApiKey>prowlarr-key</ApiKey></Config>', 'prowlarr-key'],
    ['bazarr', '/config/config/config.yaml', 'auth:\n  apikey: bazarr-key\n', 'bazarr-key'],
    ['sabnzbd', '/config/sabnzbd.ini', '[misc]\napi_key = sab-key\n', 'sab-key'],
    ['jellyseerr', '/app/config/settings.json', JSON.stringify({ main: { apiKey: 'jellyseerr-key' } }), 'jellyseerr-key'],
  ];

  for (const [kind, path, input, expected] of cases) {
    assert.equal(extractContainerApiKey(kind, path, Buffer.from(input)), expected, kind);
    assert.equal(extractContainerApiKey(kind, `${path}.other`, Buffer.from(input)), undefined, `${kind} wrong path`);
  }
});

test('container config parsers reject lookalike fields and malformed secrets', () => {
  assert.equal(
    extractContainerApiKey('bazarr', '/config/config/config.yaml', Buffer.from('other:\n  apikey: wrong\n')),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('sabnzbd', '/config/sabnzbd.ini', Buffer.from('[another]\napi_key = wrong\n')),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('jellyseerr', '/app/config/settings.json', Buffer.from(JSON.stringify({ apiKey: 'wrong' }))),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('radarr', '/config/config.xml', Buffer.from('<Config><ApiKey>bad\u0000key</ApiKey></Config>')),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('radarr', '/config/config.xml', Buffer.alloc(256 * 1024 + 1, 65)),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('radarr', '/config/config.xml', Buffer.concat([
      Buffer.from('<Config><ApiKey>'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('</ApiKey></Config>'),
    ])),
    undefined,
  );
});

test('XML credentials ignore complete comments and reject ambiguous markup', () => {
  const path = '/config/config.xml';
  assert.equal(
    extractContainerApiKey('radarr', path, Buffer.from(
      '<!-- <ApiKey>commented-key</ApiKey> --><Config><ApiKey>real-key</ApiKey></Config>',
    )),
    'real-key',
  );
  assert.equal(
    extractContainerApiKey('radarr', path, Buffer.from(
      '<Config><!-- <ApiKey>comment-only-key</ApiKey> --></Config>',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('radarr', path, Buffer.from(
      '<Config><ApiKey>first-key</ApiKey><ApiKey>second-key</ApiKey></Config>',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('radarr', path, Buffer.from(
      '<Config><!-- unclosed comment <ApiKey>hidden-key</ApiKey></Config>',
    )),
    undefined,
  );
});

test('XML credentials require one direct key in a complete Config document', () => {
  const path = '/config/config.xml';
  assert.equal(
    extractContainerApiKey('radarr', path, Buffer.from(
      '<?xml version="1.0" encoding="utf-8"?><Config><ApiKey>declared-key</ApiKey></Config>',
    )),
    'declared-key',
  );
  assert.equal(
    extractContainerApiKey('radarr', path, Buffer.from(
      '\uFEFF<Config><!-- valid comment --><ApiKey>bom-key</ApiKey></Config>',
    )),
    'bom-key',
  );

  for (const xml of [
    ' <?xml version="1.0"?><Config><ApiKey>late-declaration</ApiKey></Config>',
    '<Config><Wrapper><ApiKey>nested-key</ApiKey></Wrapper></Config>',
    '<Config><ApiKey>direct-key</ApiKey><Wrapper><ApiKey>nested-key</ApiKey></Wrapper></Config>',
    '<Config><ApiKey><![CDATA[cdata-key]]></ApiKey></Config>',
    '<![CDATA[<ApiKey>outside-cdata-key</ApiKey>]]><Config></Config>',
    '<!DOCTYPE Config [<!ENTITY key "entity-key">]><Config><ApiKey>&key;</ApiKey></Config>',
    '<Config><ApiKey>encoded&amp;key</ApiKey></Config>',
    '<Config><ApiKey>key-before-missing-root-close</ApiKey>',
    '<Config><ApiKey>key-before-junk</ApiKey></Config><Broken>',
    '<Config><ApiKey>mismatched-close</Config></ApiKey>',
    '<Config><ApiKey>commented<!-- inside -->key</ApiKey></Config>',
    '<Config><ApiKey source="other">attributed-key</ApiKey></Config>',
    '<Config><?other value?><ApiKey>processing-key</ApiKey></Config>',
    '<?other <ApiKey>outside-processing-key</ApiKey>?><Config></Config>',
  ]) {
    assert.equal(extractContainerApiKey('radarr', path, Buffer.from(xml)), undefined, xml);
  }
});

test('YAML, INI and JSON duplicate credential fields fail closed', () => {
  assert.equal(
    extractContainerApiKey('bazarr', '/config/config/config.yaml', Buffer.from(
      'auth:\n  apikey: first-key\n  apikey: second-key\n',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('bazarr', '/config/config/config.yaml', Buffer.from(
      'auth:\n  apikey: first-key\nauth:\n  apikey: second-key\n',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('bazarr', '/config/config/config.yaml', Buffer.from(
      'auth:\n  enabled: true\nauth:\n  apikey: second-key\n',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('bazarr', '/config/config/config.yaml', Buffer.from(
      'other:\n  auth:\n    apikey: nested-key\n',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('bazarr', '/config/config/config.yaml', Buffer.from(
      'auth:\n  nested:\n    apikey: nested-key\n',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('sabnzbd', '/config/sabnzbd.ini', Buffer.from(
      '[misc]\napi_key = first-key\napi_key = second-key\n',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('sabnzbd', '/config/sabnzbd.ini', Buffer.from(
      '[misc]\nother = value\n[misc]\napi_key = second-key\n',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('jellyseerr', '/app/config/settings.json', Buffer.from(
      '{"main":{"apiKey":"first-key"},"main":{"apiKey":"second-key"}}',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('jellyseerr', '/app/config/settings.json', Buffer.from(
      '{"main":{"apiKey":"first-key","apiKey":"second-key"}}',
    )),
    undefined,
  );
});

test('new file credential parsers recover their own key fields', () => {
  const cases = [
    ['tautulli', '/config/config.ini', '[General]\napi_key = tautulli-key\npms_ip = 10.0.0.1\n', 'tautulli-key'],
    ['jackett', '/config/Jackett/ServerConfig.json', JSON.stringify({ Port: 9117, APIKey: 'jackett-key', BasePathOverride: '' }), 'jackett-key'],
    ['nzbhydra2', '/config/nzbhydra.yml', 'main:\n  host: 0.0.0.0\n  apiKey: hydra-key\nsearching:\n  timeout: 30\n', 'hydra-key'],
  ];
  for (const [kind, path, input, expected] of cases) {
    assert.equal(extractContainerApiKey(kind, path, Buffer.from(input)), expected, kind);
    assert.equal(extractContainerApiKey(kind, `${path}.other`, Buffer.from(input)), undefined, `${kind} wrong path`);
  }
});

test('file credential parsers reject ambiguous input', () => {
  assert.equal(extractContainerApiKey('tautulli', '/config/config.ini', Buffer.from('[General]\napi_key = one\n[General]\napi_key = two\n')), undefined);
  assert.equal(extractContainerApiKey('tautulli', '/config/config.ini', Buffer.from('[General]\napi_key = a\napi_key = b\n')), undefined);
  assert.equal(extractContainerApiKey('tautulli', '/config/config.ini', Buffer.from('[Advanced]\napi_key = wrong\n')), undefined);
  assert.equal(extractContainerApiKey('jackett', '/config/Jackett/ServerConfig.json', Buffer.from(JSON.stringify({ APIKey: 'a', Nested: { APIKey: 'b' } }))), undefined);
  assert.equal(extractContainerApiKey('jackett', '/config/Jackett/ServerConfig.json', Buffer.from('{"ApiKey":"wrong-case"}')), undefined);
  assert.equal(extractContainerApiKey('nzbhydra2', '/config/nzbhydra.yml', Buffer.from('main:\n  apiKey: a\nmain:\n  apiKey: b\n')), undefined);
  assert.equal(extractContainerApiKey('nzbhydra2', '/config/nzbhydra.yml', Buffer.from('main:\n  apiKey: a\n  apiKey: b\n')), undefined);
  assert.equal(extractContainerApiKey('nzbhydra2', '/config/nzbhydra.yml', Buffer.from('main:\n\tapiKey: tabbed\n')), undefined);
  assert.equal(extractContainerApiKey('nzbhydra2', '/config/nzbhydra.yml', Buffer.from('other:\n  main:\n    apiKey: nested\n')), undefined);
  for (const [kind, path] of [['tautulli', '/config/config.ini'], ['jackett', '/config/Jackett/ServerConfig.json'], ['nzbhydra2', '/config/nzbhydra.yml']]) {
    assert.equal(extractContainerApiKey(kind, path, Buffer.alloc(512 * 1024 + 1, 65)), undefined, `${kind} size`);
  }
});

test('credential conflicts remain unresolved', () => {
  const rows = mergeDetectedServices([{
    kind: 'radarr',
    name: 'radarr',
    identity: 'docker:radarr',
    aliases: ['radarr'],
    publishedPort: 7878,
    apiKey: 'homepage-key',
    sources: ['docker'],
  }], [{
    kind: 'radarr',
    name: 'radarr',
    identity: 'config:/stack/radarr/config.xml',
    aliases: ['radarr'],
    configPort: 7878,
    apiKey: 'config-key',
    sources: ['config'],
  }]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].apiKey, undefined);
  assert.equal(rows[0].credentialConflict, true);
  assert.deepEqual(rows[0].sources, ['docker', 'config']);
});

test('pairing status distinguishes keyless services from missing credentials', () => {
  assert.deepEqual(
    ['dozzle', 'glances', 'pihole', 'streamystats'].map((kind) => pairingCredentialState(kind)),
    ['not-required', 'not-required', 'not-required', 'not-required'],
  );
  assert.equal(pairingCredentialState('radarr', 'recovered-key'), 'included');
  assert.equal(pairingCredentialState('radarr'), 'missing-key');
  assert.equal(pairingCredentialState('plex'), 'sign-in');
  assert.equal(pairingCredentialState('komodo'), 'key-and-secret');
  assert.equal(pairingCredentialState('crowdsec'), 'sign-in');
});

test('Jellyseerr media-server sections do not hide main.apiKey', () => {
  const real = JSON.stringify({
    clientId: 'abc',
    vapidPrivate: 'x',
    vapidPublic: 'y',
    main: { apiKey: 'seerr-main-key', applicationTitle: 'Jellyseerr' },
    plex: { name: '', ip: '', port: 32400 },
    jellyfin: { name: 'NAS', ip: '10.0.0.2', apiKey: 'jellyfin-side-key' },
    tautulli: { apiKey: 'tautulli-side-key' },
    radarr: [],
    sonarr: [],
    public: { initialized: true },
  });
  assert.equal(
    extractContainerApiKey('jellyseerr', '/app/config/settings.json', Buffer.from(real)),
    'seerr-main-key',
  );
  assert.equal(
    extractContainerApiKey('jellyseerr', '/app/config/settings.json', Buffer.from(
      '{"jellyfin":{"apiKey":"other"},"main":{"apiKey":"first","apiKey":"second"}}',
    )),
    undefined,
  );
  assert.equal(
    extractContainerApiKey('jellyseerr', '/app/config/settings.json', Buffer.from(
      '{"main":{"apiKey":"a"},"deep":{"main":{"apiKey":"b"}}}',
    )),
    undefined,
  );
});
