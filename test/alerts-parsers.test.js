// Webhook mappings, standard wording and safe tap targets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAlert } from '../src/alerts/parsers.js';
import { renderTemplate } from '../src/alerts/rules.js';

const SERVARR_CASES = Object.freeze([
  ['Grab', 'grab', 'Downloading', 'started downloading', 'grab'],
  ['Download', 'download', 'Download complete', 'has finished downloading', 'download'],
  ['ManualInteractionRequired', 'failed', 'Needs attention', 'needs a manual step to finish', 'doctor'],
  ['Health', 'health', 'Health issue', 'The indexer is unavailable', 'health'],
  ['HealthIssue', 'health', 'Health issue', 'The indexer is unavailable', 'health'],
  ['HealthRestored', 'healthRestored', 'Health restored', 'The indexer is unavailable', 'health'],
  ['ApplicationUpdate', 'update', 'Media updated', 'Now on 5.1', 'health'],
]);

for (const kind of ['sonarr', 'radarr']) {
  test(`${kind} maps each supported event and drops unknown ones`, () => {
    for (const [eventType, event, title, wording, dataKind] of SERVARR_CASES) {
      const parsed = parseAlert(kind, {
        eventType, movie: { title: 'Arrival', year: 2016 }, instanceName: 'Media',
        release: { indexer: '  Example  ' }, message: 'The indexer is unavailable', newVersion: '5.1',
      });
      assert.equal(parsed.event, event);
      assert.equal(parsed.title, title);
      assert.equal(parsed.body, ['grab', 'download', 'failed'].includes(event)
        ? `Arrival (2016) ${wording}\nfrom Example` : wording);
      assert.deepEqual(parsed.data, { kind: dataKind });
      assert.ok(Object.values(parsed.fields).every((value) => typeof value === 'string'));
    }
    assert.deepEqual(parseAlert(kind, { eventType: 'Test' }), { test: true });
    for (const eventType of ['Rename', 'SeriesDelete', 'MovieDelete', 'DownloadFailure', 'constructor', 'toString', '']) {
      assert.equal(parseAlert(kind, { eventType }), null);
    }
    assert.equal(parseAlert(kind, { eventType: 'ApplicationUpdate' }).title, `${kind === 'sonarr' ? 'Sonarr' : 'Radarr'} updated`);
    assert.equal(parseAlert(kind, { eventType: 'Download' }).body, 'A download has finished downloading');
    assert.equal(parseAlert(kind, { eventType: 'Health' }).body, 'A download');
    assert.equal(parseAlert(kind, { eventType: 'HealthRestored' }).body, '');
  });
}

test('servarr names films, individual episodes, season packs and mixed seasons', () => {
  const cases = [
    [{ movie: { title: 'Arrival', year: 2016 }, series: { title: 'Ignored' } }, 'Arrival (2016)'],
    [{ movie: { title: 'Arrival', year: '2016' } }, 'Arrival'],
    [{ series: { title: 'Slow Horses' }, episodes: [{ seasonNumber: 4, episodeNumber: 2, title: 'A Stranger Comes to Town' }] }, 'Slow Horses S04E02 · A Stranger Comes to Town'],
    [{ series: { title: 'Slow Horses' }, episodes: [{ seasonNumber: 4, episodeNumber: 2 }] }, 'Slow Horses S04E02'],
    [{ series: { title: 'Slow Horses' }, episodes: [{ title: 'A Stranger Comes to Town' }] }, 'Slow Horses · A Stranger Comes to Town'],
    [{ series: { title: 'Slow Horses' }, episodes: [{ seasonNumber: 4 }, { seasonNumber: 4 }] }, 'Slow Horses · Season 4 (2 episodes)'],
    [{ series: { title: 'Slow Horses' }, episodes: [{ seasonNumber: 3 }, { seasonNumber: 4 }] }, 'Slow Horses (2 episodes)'],
    [{ series: { title: 'Slow Horses' }, episodes: [{}, {}] }, 'Slow Horses (2 episodes)'],
    [{ series: { title: 'Slow Horses' }, episodes: [] }, 'Slow Horses'],
    [{ episodes: [{ title: 'A Stranger Comes to Town' }] }, 'A Stranger Comes to Town'],
    [{}, 'A download'],
  ];
  for (const [body, expected] of cases) {
    assert.equal(parseAlert('sonarr', { eventType: 'Download', ...body }).fields.name, expected);
  }
});

test('servarr reads a release code only when no episodes are named', () => {
  for (const [releaseTitle, expected] of [
    ['Show.S16E03.1080p', 'Show S16E03'], ['Show_S16E03_1080p', 'Show S16E03'],
    ['Show.S16.1080p', 'Show · Season 16'], ['Show.s04e02.1080p', 'Show S04E02'],
    ['Show.S04.1080p', 'Show · Season 4'], ['Show.1080p', 'Show'],
  ]) {
    for (const location of [{ release: { releaseTitle } }, { downloadInfo: { title: releaseTitle } }]) {
      const parsed = parseAlert('sonarr', { eventType: 'Grab', series: { title: 'Show' }, episodes: [], ...location });
      assert.equal(parsed.fields.name, expected);
      assert.equal(parsed.fields.episode, '');
      assert.equal(parsed.fields.season, '');
    }
  }
  const parsed = parseAlert('sonarr', {
    eventType: 'Grab', series: { title: 'Show' }, episodes: [{ seasonNumber: 2, episodeNumber: 1 }],
    release: { releaseTitle: 'Show.S16E03.1080p' },
  });
  assert.equal(parsed.fields.name, 'Show S02E01');
});

test('servarr exposes all wording fields as strings', () => {
  const parsed = parseAlert('sonarr', {
    eventType: 'Download', series: { id: 12, title: 'Slow Horses', year: 2022, tvdbId: 372264 },
    episodes: [{ seasonNumber: 4, episodeNumber: 2, title: 'A Stranger Comes to Town' }],
    release: { quality: 'WEBDL-2160p', indexer: '  Example  ', releaseGroup: 'Group' },
    instanceName: 'Sonarr UHD', message: 'Imported', level: 'notice', type: 'IndexerStatusCheck',
    newVersion: '4.1', previousVersion: '4.0',
  });
  assert.deepEqual(parsed.fields, {
    name: 'Slow Horses S04E02 · A Stranger Comes to Town', series: 'Slow Horses', movie: '', year: '2022',
    episode: 'S04E02', episodeTitle: 'A Stranger Comes to Town', season: '4', release: '', quality: 'WEBDL-2160p',
    indexer: 'Example', releaseGroup: 'Group', instance: 'Sonarr UHD', message: 'Imported',
    level: 'notice', type: 'IndexerStatusCheck', newVersion: '4.1', previousVersion: '4.0',
  });
  assert.deepEqual(parsed.data.target, { service: 'sonarr', id: 12, tvdbId: 372264, season: 4, episode: 2 });
  const pack = parseAlert('sonarr', {
    eventType: 'Download', series: { id: 12 }, episodes: [{ seasonNumber: 4 }, { seasonNumber: 4 }],
  });
  assert.equal(pack.fields.season, '4');
  assert.equal(pack.fields.episode, '');
  assert.equal(pack.fields.episodeTitle, '');
  assert.deepEqual(pack.data.target, { service: 'sonarr', id: 12 });
});

test('servarr grabs expose the full release title', () => {
  for (const kind of ['sonarr', 'radarr']) {
    const releaseTitle = 'The.Expanse.S02E05.Home.2160p.AMZN.WEB-DL.DDP5.1.H.265-FLUX';
    const parsed = parseAlert(kind, { eventType: 'Grab', release: { releaseTitle } });
    assert.equal(parsed.fields.release, releaseTitle);
    assert.equal(renderTemplate('{release}', parsed.fields), releaseTitle);
  }
});

test('servarr imports use the scene name unless a release title is present', () => {
  const sceneName = 'Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb';
  for (const [kind, body] of [
    ['sonarr', { episodeFile: { sceneName } }],
    ['sonarr', { episodeFiles: [{ sceneName }, { sceneName: 'Another release' }] }],
    ['radarr', { movieFile: { sceneName } }],
  ]) {
    const payload = { eventType: 'Download', downloadInfo: { title: 'Download title' }, ...body };
    assert.equal(parseAlert(kind, payload).fields.release, sceneName);
    assert.equal(parseAlert(kind, { ...payload, release: { releaseTitle: 'Grabbed release' } }).fields.release, 'Grabbed release');
  }
});

test('servarr uses the download title before the imported file path', () => {
  for (const [kind, fileKey] of [['sonarr', 'episodeFile'], ['radarr', 'movieFile']]) {
    for (const eventType of ['Download', 'ManualInteractionRequired']) {
      const parsed = parseAlert(kind, {
        eventType, downloadInfo: { title: 'Original.Release.Name' },
        [fileKey]: { relativePath: 'Season 01/Renamed file.mkv', path: '/media/Other file.mkv' },
      });
      assert.equal(parsed.fields.release, 'Original.Release.Name');
    }
  }
});

test('servarr falls back to the file basename without its extension', () => {
  const cases = [
    [{ relativePath: 'Season 01/Show - S01E01 - Pilot WEBDL-1080p.mkv', path: '/media/Other.mkv' }, 'Show - S01E01 - Pilot WEBDL-1080p'],
    [{ relativePath: 'Season 01\\Show.S01E01.MP4' }, 'Show.S01E01'],
    [{ path: '/media/Film (2024)/Film (2024).webm' }, 'Film (2024)'],
    [{ path: 'C:\\Media\\Film (2024)\\Film (2024).mkv' }, 'Film (2024)'],
    [{ relativePath: '', path: '/media/Original.Release-Group' }, 'Original.Release-Group'],
    [{ relativePath: 'Season 01/Show.backup.mkv' }, 'Show.backup'],
    [{ relativePath: 'Season 01/Show.archive' }, 'Show.archive'],
  ];
  for (const [kind, fileKey] of [['sonarr', 'episodeFile'], ['radarr', 'movieFile']]) {
    for (const [file, expected] of cases) {
      assert.equal(parseAlert(kind, { eventType: 'Download', [fileKey]: file }).fields.release, expected);
    }
  }
});

test('missing release names render as nothing, including health and update events', () => {
  for (const kind of ['sonarr', 'radarr']) {
    for (const eventType of ['Grab', 'Download', 'ManualInteractionRequired', 'Health', 'HealthIssue', 'HealthRestored', 'ApplicationUpdate']) {
      const parsed = parseAlert(kind, { eventType });
      assert.equal(parsed.fields.release, '');
      assert.equal(renderTemplate('{release}', parsed.fields), '');
      assert.equal(renderTemplate('Ready {release}', parsed.fields), 'Ready');
    }
  }
});

test('release names preserve supplied text and ignore unresolved or inherited values', () => {
  const supplied = '  Original.Release.Name.mkv  ';
  for (const body of [
    { release: { releaseTitle: supplied } },
    { episodeFile: { sceneName: supplied } },
    { downloadInfo: { title: supplied } },
  ]) assert.equal(parseAlert('sonarr', { eventType: 'Download', ...body }).fields.release, supplied);
  for (const body of [
    { release: { releaseTitle: '{{release}}' }, episodeFile: { sceneName: 'Scene name' } },
    { release: Object.create({ releaseTitle: 'Inherited' }), episodeFile: { sceneName: 'Scene name' } },
  ]) assert.equal(parseAlert('sonarr', { eventType: 'Download', ...body }).fields.release, 'Scene name');
  for (const episodeFile of [
    { sceneName: '{{scene}}', relativePath: '{{path}}', path: '/media/File.mkv' },
    Object.assign(Object.create({ sceneName: 'Inherited', relativePath: 'Inherited.mkv' }), { path: '/media/File.mkv' }),
  ]) {
    assert.equal(parseAlert('sonarr', {
      eventType: 'Download', episodeFile, downloadInfo: Object.create({ title: 'Inherited' }),
    }).fields.release, 'File');
  }
});

test('servarr uses file quality and release group when the release lacks them', () => {
  const file = { quality: { quality: { name: 'Bluray-1080p' } }, releaseGroup: 'FileGroup' };
  for (const [kind, body] of [
    ['sonarr', { episodeFile: file }], ['sonarr', { episodeFiles: [file] }], ['radarr', { movieFile: file }],
  ]) {
    const parsed = parseAlert(kind, { eventType: 'Download', ...body });
    assert.equal(parsed.fields.quality, 'Bluray-1080p');
    assert.equal(parsed.fields.releaseGroup, 'FileGroup');
  }
  const parsed = parseAlert('radarr', {
    eventType: 'Download', movie: { id: 15, title: 'Arrival', year: 2016, tmdbId: 329865 }, movieFile: file,
    release: { quality: 'WEBDL-2160p', releaseGroup: 'ReleaseGroup' },
  });
  assert.equal(parsed.fields.quality, 'WEBDL-2160p');
  assert.equal(parsed.fields.releaseGroup, 'ReleaseGroup');
  assert.deepEqual(parsed.data.target, { service: 'radarr', id: 15, tmdbId: 329865 });
});

test('servarr only includes numeric record ids and valid download ids', () => {
  for (const id of [0, -1, 1.2, '12', null, {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseAlert('radarr', { eventType: 'Download', movie: { id, tmdbId: 10 } }).data.target, undefined);
    assert.equal(parseAlert('sonarr', { eventType: 'Download', series: { id, tvdbId: 10 } }).data.target, undefined);
  }
  assert.deepEqual(parseAlert('radarr', { eventType: 'Download', movie: { id: 1, tmdbId: -1 } }).data.target, { service: 'radarr', id: 1 });
  assert.deepEqual(parseAlert('sonarr', {
    eventType: 'Download', series: { id: 1, tvdbId: '10' }, episodes: [{ seasonNumber: 0, episodeNumber: 2 }],
  }).data.target, { service: 'sonarr', id: 1, season: 0, episode: 2 });
  assert.deepEqual(parseAlert('sonarr', {
    eventType: 'Download', series: { id: 1 }, episodes: [{ seasonNumber: -1, episodeNumber: '2' }],
  }).data.target, { service: 'sonarr', id: 1 });
  for (const downloadId of ['a', 'download_1.2:3-4', 'a'.repeat(256)]) {
    assert.equal(parseAlert('sonarr', { eventType: 'ManualInteractionRequired', downloadId }).data.downloadId, downloadId);
    assert.equal(parseAlert('sonarr', { eventType: 'Download', downloadId }).data.downloadId, undefined);
  }
  for (const downloadId of ['', '_abc', 'a/b', 'a b', 'a\nb', 'a'.repeat(257), 12]) {
    assert.equal(parseAlert('sonarr', { eventType: 'ManualInteractionRequired', downloadId }).data.downloadId, undefined);
  }
  assert.equal(parseAlert('sonarr', {
    eventType: 'ManualInteractionRequired', message: 'Ignored', downloadStatusMessages: [{ title: 'Manual import needed' }, { title: 'Other' }],
  }).fields.message, 'Manual import needed');
});

test('seerr maps requests, automatic requests and each issue event', () => {
  const cases = [
    ['MEDIA_PENDING', 'requested', 'New request', 'Lewis requested Arrival'],
    ['MEDIA_AUTO_REQUESTED', 'requested', 'New request', 'Lewis requested Arrival'],
    ['MEDIA_APPROVED', 'approved', 'Request approved', 'Arrival was approved for Lewis'],
    ['MEDIA_AUTO_APPROVED', 'approved', 'Request approved', 'Arrival was approved for Lewis'],
    ['MEDIA_AVAILABLE', 'available', 'Ready to watch', 'Arrival is now available'],
    ['MEDIA_DECLINED', 'declined', 'Request declined', "Lewis's request for Arrival was declined"],
    ['MEDIA_FAILED', 'requestFailed', 'Request failed', 'Arrival could not be added'],
    ...['ISSUE_CREATED', 'ISSUE_COMMENT', 'ISSUE_RESOLVED', 'ISSUE_REOPENED'].map((type) => [type, 'issue', 'Issue update', 'Arrival: Subtitles missing']),
  ];
  for (const [notification_type, event, title, body] of cases) {
    assert.deepEqual(parseAlert('seerr', { notification_type, subject: 'Arrival', username: 'Lewis', message: 'Subtitles missing' }), {
      event, fields: { subject: 'Arrival', message: 'Subtitles missing', requestedBy: 'Lewis', mediaType: '' },
      title, body, data: { kind: 'seerr' },
    });
  }
  assert.deepEqual(parseAlert('seerr', { notification_type: 'TEST_NOTIFICATION' }), { test: true });
  for (const notification_type of ['UNKNOWN', 'constructor', 'toString', '']) {
    assert.equal(parseAlert('seerr', { notification_type }), null);
  }
});

test('seerr uses the subject alone when a requester or issue message is absent', () => {
  for (const [notification_type, body] of [
    ['MEDIA_PENDING', 'A title was requested'], ['MEDIA_APPROVED', 'A title was approved'],
    ['MEDIA_DECLINED', 'A title was declined'], ['ISSUE_CREATED', 'A title'],
  ]) assert.equal(parseAlert('seerr', { notification_type }).body, body);
  const parsed = parseAlert('seerr', {
    notification_type: 'MEDIA_PENDING', subject: '{{subject}}', username: 'Someone {{unknown}}', message: '{{message}}',
  });
  assert.deepEqual(parsed.fields, { subject: 'A title', message: '', requestedBy: '', mediaType: '' });
});

test('tracearr maps violations, server changes and streams', () => {
  for (const [severity, title] of [['high', 'Rule broken'], ['warning', 'Rule warning'], ['low', 'Rule triggered'], ['', 'Rule triggered']]) {
    assert.deepEqual(parseAlert('tracearr', {
      event: 'violation_detected', data: { rule: { name: 'Travel' }, violation: { severity } },
    }), { event: 'violation', fields: { rule: 'Travel', severity }, title, body: 'Travel was triggered on your server', data: { kind: 'health' } });
  }
  for (const [event, resultEvent, title, body, fields, data] of [
    ['server_down', 'serverDown', 'Server down', 'Plex stopped responding', { server: 'Plex' }, { kind: 'health' }],
    ['server_up', 'serverUp', 'Server back up', 'Plex is responding again', { server: 'Plex' }, { kind: 'health' }],
    ['stream_started', 'streamStarted', 'Stream started', 'Someone started watching on your server', {}, {}],
    ['stream_stopped', 'streamStopped', 'Stream stopped', 'A stream on your server ended', {}, {}],
  ]) {
    assert.deepEqual(parseAlert('tracearr', { event, data: { serverName: 'Plex' } }), { event: resultEvent, title, body, fields, data });
  }
  assert.equal(parseAlert('tracearr', { event: 'server_down', data: {} }).fields.server, 'A server');
  assert.equal(parseAlert('tracearr', { event: 'violation_detected', data: {} }).fields.rule, 'A rule');
  assert.deepEqual(parseAlert('tracearr', { event: 'test', data: {} }), { test: true });
  assert.equal(parseAlert('tracearr', { event: 'unknown', data: {} }), null);
});

test('tracearr requires a data object and never reads violation details', () => {
  for (const data of [undefined, null, [], 'text', 42]) {
    for (const event of ['test', 'server_down', 'violation_detected']) {
      assert.equal(parseAlert('tracearr', { event, data }), null);
    }
  }
  const violation = { severity: 'high' };
  Object.defineProperty(violation, 'details', { get() { throw new Error('details must stay unread'); } });
  assert.equal(parseAlert('tracearr', { event: 'violation_detected', data: { violation } }).title, 'Rule broken');
});

test('uptime kuma recognises tests and only the up and down statuses', () => {
  assert.deepEqual(parseAlert('uptimekuma', { heartbeat: null, monitor: null }), { test: true });
  for (const [status, event, title] of [[0, 'down', 'Media is down'], [1, 'up', 'Media is back up']]) {
    assert.deepEqual(parseAlert('uptimekuma', {
      heartbeat: { status, msg: 'Heartbeat message' }, monitor: { name: 'Media', url: 'https://media.test' }, msg: 'Outer message',
    }), {
      event, title, body: 'Heartbeat message', data: { kind: 'health' },
      fields: { monitor: 'Media', message: 'Heartbeat message', url: 'https://media.test' },
    });
  }
  assert.equal(parseAlert('uptimekuma', { heartbeat: { status: 0 }, monitor: {}, msg: 'Outer message' }).body, 'Outer message');
  for (const status of [2, 3, -1, '0', '1', true, undefined]) {
    assert.equal(parseAlert('uptimekuma', { heartbeat: { status }, monitor: {} }), null);
  }
  for (const body of [{}, { heartbeat: null }, { monitor: null }, { heartbeat: null, monitor: {} }]) {
    assert.equal(parseAlert('uptimekuma', body), null);
  }
});

test('custom messages accept text and use the documented json field order', () => {
  assert.deepEqual(parseAlert('custom', 'Backup finished', 'Backups'), {
    event: 'message', fields: { title: '', message: 'Backup finished' }, title: 'Backups', body: 'Backup finished', data: {},
  });
  for (const [body, expectedTitle, expectedBody] of [
    [{ title: 'Done', message: 'Message', body: 'Body', text: 'Text' }, 'Done', 'Message'],
    [{ body: 'Body', text: 'Text' }, 'Backups', 'Body'],
    [{ text: 'Text' }, 'Backups', 'Text'], [{ title: 'Done' }, 'Done', ''],
    [{ title: '{{title}}', message: '{{message}}', body: 'Body' }, 'Backups', 'Body'],
    [{ message: 42 }, 'Backups', '42'], [{ message: false }, 'Backups', 'false'],
  ]) {
    const parsed = parseAlert('custom', body, 'Backups');
    assert.equal(parsed.title, expectedTitle);
    assert.equal(parsed.body, expectedBody);
    assert.ok(Object.values(parsed.fields).every((value) => typeof value === 'string'));
  }
  for (const body of ['', ' \n ', '{{message}}', {}, { title: '', message: '' }, { message: {} }, [], null]) {
    assert.equal(parseAlert('custom', body, 'Backups'), null);
  }
});

test('all parsers treat unresolved template values as missing and ignore inherited fields', () => {
  const servarr = parseAlert('sonarr', {
    eventType: 'Download', series: { title: 'Show {{unknown}}' },
    episodes: [{ title: '{{title}}' }], release: { indexer: '{{indexer}}', quality: '{{quality}}' },
  });
  assert.equal(servarr.fields.name, 'A download');
  assert.equal(servarr.fields.quality, '');
  assert.equal(servarr.fields.indexer, '');
  assert.equal(parseAlert('tracearr', { event: 'server_up', data: { serverName: '{{server}}' } }).fields.server, 'A server');
  const kuma = parseAlert('uptimekuma', { heartbeat: { status: 1, msg: '{{msg}}' }, monitor: { name: '{{name}}', url: '{{url}}' } });
  assert.deepEqual(kuma.fields, { monitor: '', message: '', url: '' });
  assert.equal(parseAlert('sonarr', Object.create({ eventType: 'Test' })), null);
  assert.equal(parseAlert('seerr', Object.create({ notification_type: 'TEST_NOTIFICATION' })), null);
  assert.equal(parseAlert('custom', Object.create({ message: 'Inherited' }), 'Custom'), null);
  assert.equal(parseAlert('radarr', { eventType: 'Download', movie: Object.create({ id: 5, title: 'Inherited' }) }).data.target, undefined);
});

test('the configured kind chooses the parser and malformed bodies are dropped', () => {
  assert.equal(parseAlert('seerr', { eventType: 'Download' }), null);
  assert.equal(parseAlert('sonarr', { notification_type: 'MEDIA_AVAILABLE' }), null);
  assert.equal(parseAlert('unknown', { message: 'Hello' }), null);
  assert.equal(parseAlert('sonarr', { eventType: 'Download', movie: { id: 5 } }).data.target, undefined);
  assert.equal(parseAlert('radarr', { eventType: 'Download', series: { id: 5 } }).data.target, undefined);
  for (const kind of ['sonarr', 'radarr', 'seerr', 'tracearr', 'uptimekuma']) {
    for (const body of [null, undefined, [], 'message', 12, true]) assert.equal(parseAlert(kind, body), null);
  }
});
