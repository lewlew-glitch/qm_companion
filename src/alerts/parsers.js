// Service webhook fields and standard alert wording.

const SERVARR_EVENTS = Object.freeze({
  Grab: 'grab', Download: 'download', ManualInteractionRequired: 'failed',
  Health: 'health', HealthIssue: 'health', HealthRestored: 'healthRestored', ApplicationUpdate: 'update',
});
const SEERR_EVENTS = Object.freeze({
  MEDIA_PENDING: 'requested', MEDIA_AUTO_REQUESTED: 'requested',
  MEDIA_APPROVED: 'approved', MEDIA_AUTO_APPROVED: 'approved',
  MEDIA_AVAILABLE: 'available', MEDIA_DECLINED: 'declined', MEDIA_FAILED: 'requestFailed',
  ISSUE_CREATED: 'issue', ISSUE_COMMENT: 'issue', ISSUE_RESOLVED: 'issue', ISSUE_REOPENED: 'issue',
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, key) {
  return object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function text(value) {
  if (typeof value === 'string') return value.includes('{{') ? '' : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function field(value, key) {
  return text(own(value, key));
}

function number(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positive(value) {
  return number(value) && value > 0;
}

function episodeCode(episode) {
  const season = own(episode, 'seasonNumber');
  const numberInSeason = own(episode, 'episodeNumber');
  return number(season) && number(numberInSeason)
    ? `S${String(season).padStart(2, '0')}E${String(numberInSeason).padStart(2, '0')}` : '';
}

function servarrName(movie, series, episodes, release, downloadInfo) {
  const movieTitle = field(movie, 'title');
  const year = own(movie, 'year');
  if (movieTitle) return `${movieTitle}${typeof year === 'number' && Number.isFinite(year) ? ` (${year})` : ''}`;
  const seriesTitle = field(series, 'title');
  if (seriesTitle) {
    if (episodes.length === 1) {
      const code = episodeCode(episodes[0]);
      const title = field(episodes[0], 'title');
      return `${seriesTitle}${code ? ` ${code}` : ''}${title ? ` · ${title}` : ''}`;
    }
    if (episodes.length > 1) {
      const season = own(episodes[0], 'seasonNumber');
      return number(season) && episodes.every((episode) => own(episode, 'seasonNumber') === season)
        ? `${seriesTitle} · Season ${season} (${episodes.length} episodes)`
        : `${seriesTitle} (${episodes.length} episodes)`;
    }
    const releaseTitle = field(release, 'releaseTitle') || field(downloadInfo, 'title');
    const code = /(?:^|[^A-Za-z0-9])S(\d+)(?:E(\d+))?(?=$|[^A-Za-z0-9])/i.exec(releaseTitle);
    return seriesTitle + (code ? code[2] ? ` S${code[1]}E${code[2]}` : ` · Season ${Number(code[1])}` : '');
  }
  return field(episodes[0], 'title') || 'A download';
}

function servarrTarget(kind, movie, series, episodes) {
  const record = kind === 'radarr' ? movie : series;
  const id = own(record, 'id');
  if (!positive(id)) return undefined;
  const target = { service: kind, id };
  const externalKey = kind === 'radarr' ? 'tmdbId' : 'tvdbId';
  const externalId = own(record, externalKey);
  if (positive(externalId)) target[externalKey] = externalId;
  if (kind === 'sonarr' && episodes.length === 1) {
    const season = own(episodes[0], 'seasonNumber');
    const episode = own(episodes[0], 'episodeNumber');
    if (number(season)) target.season = season;
    if (number(episode)) target.episode = episode;
  }
  return target;
}

function parseServarr(kind, body) {
  const type = field(body, 'eventType');
  if (type === 'Test') return { test: true };
  if (!Object.hasOwn(SERVARR_EVENTS, type)) return null;
  const event = SERVARR_EVENTS[type];
  const movie = own(body, 'movie');
  const series = own(body, 'series');
  const episodeList = own(body, 'episodes');
  const episodes = Array.isArray(episodeList) ? episodeList : [];
  const release = own(body, 'release');
  const files = own(body, 'episodeFiles');
  const file = kind === 'radarr' ? own(body, 'movieFile')
    : own(body, 'episodeFile') || (Array.isArray(files) ? files[0] : undefined);
  const messages = own(body, 'downloadStatusMessages');
  const season = own(episodes[0], 'seasonNumber');
  const fields = {
    name: servarrName(movie, series, episodes, release, own(body, 'downloadInfo')),
    series: field(series, 'title'), movie: field(movie, 'title'),
    year: field(movie, 'year') || field(series, 'year'),
    episode: episodes.length === 1 ? episodeCode(episodes[0]) : '',
    episodeTitle: episodes.length === 1 ? field(episodes[0], 'title') : '',
    season: episodes.length && number(season) && episodes.every((episode) => own(episode, 'seasonNumber') === season)
      ? String(season) : '',
    quality: field(release, 'quality') || field(own(own(file, 'quality'), 'quality'), 'name'),
    indexer: field(release, 'indexer').trim(),
    releaseGroup: field(release, 'releaseGroup') || field(file, 'releaseGroup'),
    instance: field(body, 'instanceName'),
    message: event === 'failed' ? field(Array.isArray(messages) ? messages[0] : undefined, 'title') : field(body, 'message'),
    level: field(body, 'level'), type: field(body, 'type'),
    newVersion: field(body, 'newVersion'), previousVersion: field(body, 'previousVersion'),
  };
  const from = fields.indexer ? `\nfrom ${fields.indexer}` : '';
  let title;
  let message;
  switch (event) {
    case 'grab': title = 'Downloading'; message = `${fields.name} started downloading${from}`; break;
    case 'download': title = 'Download complete'; message = `${fields.name} has finished downloading${from}`; break;
    case 'failed': title = 'Needs attention'; message = `${fields.name} needs a manual step to finish${from}`; break;
    case 'health': title = 'Health issue'; message = fields.message || fields.name; break;
    case 'healthRestored': title = 'Health restored'; message = fields.message; break;
    case 'update':
      title = `${fields.instance || (kind === 'sonarr' ? 'Sonarr' : 'Radarr')} updated`;
      message = `Now on ${fields.newVersion}`;
      break;
  }
  const data = { kind: event === 'failed' ? 'doctor' : event === 'grab' || event === 'download' ? event : 'health' };
  const target = servarrTarget(kind, movie, series, episodes);
  if (target) data.target = target;
  const downloadId = own(body, 'downloadId');
  if (event === 'failed' && typeof downloadId === 'string' && downloadId.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(downloadId)) {
    data.downloadId = downloadId;
  }
  return { event, fields, title, body: message, data };
}

function parseSeerr(body) {
  const type = field(body, 'notification_type');
  if (type === 'TEST_NOTIFICATION') return { test: true };
  if (!Object.hasOwn(SEERR_EVENTS, type)) return null;
  const event = SEERR_EVENTS[type];
  const fields = {
    subject: field(body, 'subject') || 'A title', message: field(body, 'message'),
    requestedBy: field(body, 'username'), mediaType: '',
  };
  const { subject, requestedBy } = fields;
  let title;
  let message;
  switch (event) {
    case 'requested': title = 'New request'; message = requestedBy ? `${requestedBy} requested ${subject}` : `${subject} was requested`; break;
    case 'approved': title = 'Request approved'; message = `${subject} was approved${requestedBy ? ` for ${requestedBy}` : ''}`; break;
    case 'available': title = 'Ready to watch'; message = `${subject} is now available`; break;
    case 'declined': title = 'Request declined'; message = requestedBy ? `${requestedBy}'s request for ${subject} was declined` : `${subject} was declined`; break;
    case 'requestFailed': title = 'Request failed'; message = `${subject} could not be added`; break;
    case 'issue': title = 'Issue update'; message = subject + (fields.message ? `: ${fields.message}` : ''); break;
  }
  return { event, fields, title, body: message, data: { kind: 'seerr' } };
}

function parseTracearr(body) {
  const data = own(body, 'data');
  if (!object(data)) return null;
  switch (field(body, 'event')) {
    case 'test': return { test: true };
    case 'violation_detected': {
      const fields = { rule: field(own(data, 'rule'), 'name') || 'A rule', severity: field(own(data, 'violation'), 'severity') };
      const title = fields.severity === 'high' ? 'Rule broken' : fields.severity === 'warning' ? 'Rule warning' : 'Rule triggered';
      return { event: 'violation', fields, title, body: `${fields.rule} was triggered on your server`, data: { kind: 'health' } };
    }
    case 'server_down':
    case 'server_up': {
      const down = field(body, 'event') === 'server_down';
      const fields = { server: field(data, 'serverName') || 'A server' };
      return {
        event: down ? 'serverDown' : 'serverUp', fields, title: down ? 'Server down' : 'Server back up',
        body: `${fields.server} ${down ? 'stopped responding' : 'is responding again'}`, data: { kind: 'health' },
      };
    }
    case 'stream_started': return { event: 'streamStarted', fields: {}, title: 'Stream started', body: 'Someone started watching on your server', data: {} };
    case 'stream_stopped': return { event: 'streamStopped', fields: {}, title: 'Stream stopped', body: 'A stream on your server ended', data: {} };
    default: return null;
  }
}

function parseUptimeKuma(body) {
  const heartbeat = own(body, 'heartbeat');
  const monitor = own(body, 'monitor');
  if (heartbeat === null && monitor === null) return { test: true };
  const status = own(heartbeat, 'status');
  if (status !== 0 && status !== 1) return null;
  const fields = {
    monitor: field(monitor, 'name'), message: field(heartbeat, 'msg') || field(body, 'msg'), url: field(monitor, 'url'),
  };
  return {
    event: status === 0 ? 'down' : 'up', fields,
    title: `${fields.monitor} is ${status === 0 ? 'down' : 'back up'}`, body: fields.message, data: { kind: 'health' },
  };
}

function parseCustom(body, label) {
  const fields = {
    title: field(body, 'title'),
    message: typeof body === 'string' ? text(body) : field(body, 'message') || field(body, 'body') || field(body, 'text'),
  };
  if (!fields.title.trim() && !fields.message.trim()) return null;
  return { event: 'message', fields, title: fields.title || text(label), body: fields.message, data: {} };
}

export function parseAlert(kind, body, label) {
  switch (kind) {
    case 'sonarr':
    case 'radarr': return parseServarr(kind, body);
    case 'seerr': return parseSeerr(body);
    case 'tracearr': return parseTracearr(body);
    case 'uptimekuma': return parseUptimeKuma(body);
    case 'custom': return parseCustom(body, label);
    default: return null;
  }
}
