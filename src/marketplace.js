import { PORTS, labelFor, schemeFor } from './kinds.js';
import { starterFor } from './starters.js';

export const MARKETPLACE_MODES = Object.freeze({
  CONNECT_ONLY: 'connect-only',
  REVIEWED_STARTER: 'reviewed-starter',
  GENERATED_STARTER: 'generated-starter',
});

const CREDENTIAL_PRIORITY = Object.freeze([
  'conflict',
  'missing-key',
  'key-and-secret',
  'sign-in',
  'included',
  'not-required',
]);

function strongestCredentialState(value) {
  const states = new Set((Array.isArray(value) ? value : [value])
    .map((state) => String(state || '').trim().toLowerCase())
    .filter(Boolean));
  return CREDENTIAL_PRIORITY.find((state) => states.has(state)) || '';
}

function presentation(value) {
  return Object.freeze(value);
}

// Derive marketplace UI state from catalogue metadata and current server state.
export function marketplacePresentation(entry = {}, context = {}) {
  const community = context.community === true;
  const installed = context.installed === undefined ? entry.installed === true : context.installed === true;
  const detectionKnown = context.detectionKnown !== false;
  const control = context.control === true;
  const hasStarter = context.hasStarter === undefined ? entry.hasStarter === true : context.hasStarter === true;
  const reviewed = !community && (context.reviewed === true || entry.hasReviewedStarter === true);
  const generated = !community && hasStarter && !reviewed;
  const credentialState = strongestCredentialState(context.credentialStates || context.credentialState);
  const composeTitle = community
    ? 'Community template Compose file'
    : reviewed ? 'Reviewed Compose starter' : generated ? 'Generated Compose starting point' : '';

  if (community) {
    return presentation({
      state: 'community',
      filter: 'community',
      credentialState: '',
      badgeTone: 'line',
      badgeLabel: 'Community, unreviewed',
      badgeIcon: 'list',
      actionLabel: 'Review template',
      actionIcon: 'list',
      actionTarget: 'details',
      primary: false,
      canDeploy: hasStarter && control && detectionKnown,
      showConnectionPanel: true,
      detailTitle: hasStarter ? 'Community template' : 'Compose file unavailable',
      detailCopy: hasStarter
        ? 'This template came from a community source and has not been reviewed by Quartermaster.'
        : 'Companion could not fetch a Compose file for this template. Review it in the source repository instead.',
      statusText: hasStarter && !detectionKnown
        ? 'Docker is unavailable, so deployment is disabled.'
        : hasStarter && !control ? 'Read-only mode. Review, copy or download this template.' : '',
      composeTitle,
    });
  }

  if (installed) {
    const dockerNote = detectionKnown ? '' : ' Docker is unavailable, so Companion cannot confirm its running state.';
    const installedStates = {
      included: {
        state: 'installed-included', filter: 'ready', badgeTone: 'ok', badgeLabel: 'Ready for scan', badgeIcon: 'check',
        actionLabel: 'Review setup', primary: false, detailTitle: 'Ready for scan',
        detailCopy: `This service and its detected API key can be included in the next encrypted transfer.${dockerNote}`,
      },
      'not-required': {
        state: 'installed-no-key', filter: 'ready', badgeTone: 'info', badgeLabel: 'No key needed', badgeIcon: 'check',
        actionLabel: 'Review setup', primary: false, detailTitle: 'No key needed',
        detailCopy: `This service can be included in the next encrypted transfer without an API key.${dockerNote}`,
      },
      'sign-in': {
        state: 'installed-sign-in', filter: 'ready', badgeTone: 'info', badgeLabel: 'Sign in after pairing', badgeIcon: 'link',
        actionLabel: 'Review setup', primary: false, detailTitle: 'Sign in after pairing',
        detailCopy: `The scan can add this service, then the phone will ask the user to sign in.${dockerNote}`,
      },
      'key-and-secret': {
        state: 'installed-credentials', filter: 'attention', badgeTone: 'warn', badgeLabel: 'Credentials needed', badgeIcon: 'alert',
        actionLabel: 'Resolve in setup', primary: true, detailTitle: 'Credentials needed',
        detailCopy: `This service needs both a key and a secret before the phone can use it.${dockerNote}`,
      },
      'missing-key': {
        state: 'installed-missing-key', filter: 'attention', badgeTone: 'warn', badgeLabel: 'Needs a key', badgeIcon: 'alert',
        actionLabel: 'Resolve in setup', primary: true, detailTitle: 'API key needed',
        detailCopy: `Companion has not found a transferable API key yet. Setup can show the supported next step.${dockerNote}`,
      },
      conflict: {
        state: 'installed-conflict', filter: 'attention', badgeTone: 'warn', badgeLabel: 'Check key sources', badgeIcon: 'alert',
        actionLabel: 'Resolve in setup', primary: true, detailTitle: 'Conflicting key sources',
        detailCopy: `Companion found different API keys for this service. Resolve the conflict before creating a transfer.${dockerNote}`,
      },
    };
    const selected = installedStates[credentialState] || {
      state: 'installed-detected', filter: 'attention', badgeTone: 'info', badgeLabel: 'Detected', badgeIcon: 'check',
      actionLabel: 'Review setup', primary: false, detailTitle: 'Detected on this server',
      detailCopy: `Review this service's address and sign-in requirements before creating a transfer.${dockerNote}`,
    };
    return presentation({
      ...selected,
      credentialState,
      actionIcon: 'link',
      actionTarget: 'setup',
      canDeploy: false,
      showConnectionPanel: true,
      statusText: hasStarter ? 'This service is already detected. Its starter remains available to review, copy or download.' : '',
      composeTitle,
    });
  }

  if (!detectionKnown) {
    return presentation({
      state: 'detection-unavailable',
      filter: 'preview',
      credentialState: '',
      badgeTone: 'warn',
      badgeLabel: 'Detection unavailable',
      badgeIcon: 'alert',
      actionLabel: hasStarter ? 'Review Compose' : 'View details',
      actionIcon: hasStarter ? 'list' : 'link',
      actionTarget: 'details',
      primary: false,
      canDeploy: false,
      showConnectionPanel: true,
      detailTitle: 'Detection unavailable',
      detailCopy: hasStarter
        ? 'Companion cannot read Docker, so it cannot confirm whether this service is already present. The Compose file is available for review only.'
        : 'Companion cannot read Docker, so it cannot confirm whether this service is already present.',
      statusText: hasStarter ? 'Docker is unavailable, so deployment is disabled.' : '',
      composeTitle,
    });
  }

  if (hasStarter) {
    const canDeploy = control;
    return presentation({
      state: reviewed ? (canDeploy ? 'reviewed-deployable' : 'reviewed-preview') : (canDeploy ? 'generated-deployable' : 'generated-preview'),
      filter: canDeploy ? 'deploy' : 'preview',
      credentialState: '',
      badgeTone: canDeploy ? (reviewed ? 'info' : 'warn') : 'line',
      badgeLabel: canDeploy ? (reviewed ? 'Reviewed starter' : 'Generated starting point') : 'Preview only',
      badgeIcon: canDeploy ? (reviewed ? 'stack' : 'list') : 'list',
      actionLabel: reviewed ? (canDeploy ? 'Review and deploy' : 'Review starter') : 'Review Compose',
      actionIcon: reviewed && canDeploy ? 'play' : 'list',
      actionTarget: 'details',
      primary: canDeploy && reviewed,
      canDeploy,
      showConnectionPanel: true,
      detailTitle: reviewed ? 'Reviewed starter' : 'Generated starting point',
      detailCopy: reviewed
        ? 'Review the Compose file and its requirements before starting a deployment.'
        : 'This Compose file was generated from basic service defaults. Review every field for this server before deployment.',
      statusText: canDeploy ? '' : 'Read-only mode. Review, copy or download this Compose file.',
      composeTitle,
    });
  }

  return presentation({
    state: 'connection-support',
    filter: 'preview',
    credentialState: '',
    badgeTone: 'line',
    badgeLabel: 'External setup',
    badgeIcon: 'link',
    actionLabel: 'View details',
    actionIcon: 'link',
    actionTarget: 'details',
    primary: false,
    canDeploy: false,
    showConnectionPanel: true,
    detailTitle: entry.blocked ? 'External setup required' : 'Not detected on this server',
    detailCopy: entry.blocked || 'Run this service on the Docker host, then refresh Companion so it can be discovered and included in setup.',
    statusText: '',
    composeTitle: '',
  });
}

export const MARKETPLACE_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'media-automation', label: 'Media automation' }),
  Object.freeze({ id: 'downloads', label: 'Downloads' }),
  Object.freeze({ id: 'media-servers', label: 'Media servers' }),
  Object.freeze({ id: 'requests', label: 'Requests and access' }),
  Object.freeze({ id: 'insights', label: 'Media insights' }),
  Object.freeze({ id: 'containers', label: 'Container management' }),
  Object.freeze({ id: 'monitoring', label: 'Monitoring' }),
  Object.freeze({ id: 'networking', label: 'Network and DNS' }),
  Object.freeze({ id: 'hosting', label: 'Application hosting' }),
  Object.freeze({ id: 'iptv', label: 'IPTV' }),
  Object.freeze({ id: 'home', label: 'Home automation' }),
  Object.freeze({ id: 'infrastructure', label: 'Servers and storage' }),
  Object.freeze({ id: 'books', label: 'Books and audio' }),
  Object.freeze({ id: 'photos', label: 'Photos' }),
]);

export const MARKETPLACE_CATEGORY_ORDER = Object.freeze(MARKETPLACE_CATEGORIES.map(({ id }) => id));

export const MARKETPLACE_CATEGORY_LABELS = Object.freeze(Object.fromEntries(
  MARKETPLACE_CATEGORIES.map(({ id, label }) => [id, label]),
));

// Catalogue metadata only. Deployment support is gated separately.
const CATALOGUE = {
  radarr: ['media-automation', 'Manages and automates a movie library.'],
  sonarr: ['media-automation', 'Manages and automates a TV series library.'],
  lidarr: ['media-automation', 'Manages and automates a music library.'],
  prowlarr: ['media-automation', 'Manages indexers used by download clients and media automation tools.'],
  bazarr: ['media-automation', 'Finds and manages subtitles for movie and TV libraries.'],
  sabnzbd: ['downloads', 'Downloads and processes files from Usenet.'],
  nzbget: ['downloads', 'Downloads and processes files from Usenet.'],
  qbittorrent: ['downloads', 'Downloads and manages torrents through qBittorrent.'],
  transmission: ['downloads', 'Downloads and manages torrents through Transmission.'],
  deluge: ['downloads', 'Downloads and manages torrents through Deluge.'],
  jackett: ['downloads', 'Provides a tracker proxy and search API for automation tools.'],
  nzbhydra2: ['downloads', 'Searches multiple Usenet indexers from one interface.'],
  qui: ['downloads', 'Provides one interface for multiple qBittorrent instances.'],
  jellyfin: ['media-servers', 'Streams a self-hosted movie, TV and music library.'],
  emby: ['media-servers', 'Streams a self-hosted movie, TV and music library.'],
  plex: ['media-servers', 'Organises and streams personal media libraries.'],
  jellyseerr: ['requests', 'Collects and manages requests for movies and TV series.'],
  musicseerr: ['requests', 'Collects and manages requests for music.'],
  wizarr: ['requests', 'Manages invitations and members for media servers.'],
  tautulli: ['insights', 'Reports Plex activity, users and playback history.'],
  jellystat: ['insights', 'Reports Jellyfin activity, users and playback history.'],
  streamystats: ['insights', 'Analyses Jellyfin playback and library activity.'],
  tracearr: ['insights', 'Monitors media streams and account sharing signals.'],
  maintainerr: ['media-automation', 'Automates media library cleanup using configurable rules.'],
  portainer: ['containers', 'Manages Docker containers, images, networks and volumes.'],
  dozzle: ['containers', 'Shows live logs from Docker containers.'],
  dockhand: ['containers', 'Manages Docker containers and Compose stacks from a web interface.'],
  komodo: ['containers', 'Coordinates servers, deployments and Compose stacks.'],
  arcane: ['containers', 'Manages Docker environments, containers and Compose stacks.'],
  beszel: ['monitoring', 'Monitors servers, containers and resource usage.'],
  glances: ['monitoring', 'Reports live system and process resource usage.'],
  scrutiny: ['monitoring', 'Tracks drive health and SMART data.'],
  gluetun: ['networking', 'Provides VPN connectivity and exposes operational status.'],
  coolify: ['hosting', 'Deploys and manages self-hosted applications and databases.'],
  dispatcharr: ['iptv', 'Manages IPTV channels, programme data and live streams.'],
  adguard: ['networking', 'Filters DNS requests and manages network-wide blocking.'],
  pihole: ['networking', 'Filters DNS requests and manages network-wide blocking.'],
  technitium: ['networking', 'Manages DNS zones, resolution and blocking.'],
  crowdsec: ['networking', 'Detects hostile activity and shares decisions with connected security tools.'],
  homeassistant: ['home', 'Coordinates smart home devices, entities and automations.'],
  unifi: ['networking', 'Manages UniFi network devices, clients and traffic.'],
  proxmox: ['infrastructure', 'Manages Proxmox virtual machines and system containers.'],
  truenas: ['infrastructure', 'Manages TrueNAS storage pools, datasets and disks.'],
  synology: ['infrastructure', 'Connects to Synology DSM and its container workloads.'],
  unraid: ['infrastructure', 'Manages an Unraid NAS, storage array and Docker services.'],
  ugreen: ['infrastructure', 'Reports system and storage status from a UGREEN NAS.'],
  komga: ['books', 'Serves self-hosted comic and manga libraries.'],
  kavita: ['books', 'Serves self-hosted comic, manga and ebook libraries.'],
  audiobookshelf: ['books', 'Serves self-hosted audiobook and podcast libraries.'],
  readmeabook: ['books', 'Handles audiobook requests and download workflows.'],
  bookorbit: ['books', 'Manages books and audiobooks from one self-hosted interface.'],
  shelfmark: ['books', 'Tracks and manages book requests and downloads.'],
  shelfarr: ['books', 'Handles book and audiobook request automation.'],
  immich: ['photos', 'Manages a self-hosted photo and video library.'],
  tdarr: ['media-automation', 'Automates media transcoding and library health checks.'],
};

const UPSTREAM = Object.freeze({
  radarr: 'https://github.com/Radarr/Radarr',
  sonarr: 'https://github.com/Sonarr/Sonarr',
  lidarr: 'https://github.com/Lidarr/Lidarr',
  prowlarr: 'https://github.com/Prowlarr/Prowlarr',
  bazarr: 'https://github.com/morpheus65535/bazarr',
  maintainerr: 'https://github.com/Maintainerr/Maintainerr',
  tdarr: 'https://github.com/HaveAGitGat/Tdarr',
  deluge: 'https://github.com/deluge-torrent/deluge',
  jackett: 'https://github.com/Jackett/Jackett',
  nzbget: 'https://github.com/nzbgetcom/nzbget',
  nzbhydra2: 'https://github.com/theotherp/nzbhydra2',
  qbittorrent: 'https://github.com/qbittorrent/qBittorrent',
  qui: 'https://github.com/autobrr/qui',
  sabnzbd: 'https://github.com/sabnzbd/sabnzbd',
  transmission: 'https://github.com/transmission/transmission',
  emby: 'https://github.com/MediaBrowser/Emby.Build',
  jellyfin: 'https://github.com/jellyfin/jellyfin',
  plex: 'https://github.com/plexinc/pms-docker',
  jellyseerr: 'https://github.com/seerr-team/seerr',
  musicseerr: 'https://github.com/DroppedNeedle/DroppedNeedle',
  wizarr: 'https://github.com/wizarrrr/wizarr',
  jellystat: 'https://github.com/CyferShepard/Jellystat',
  streamystats: 'https://github.com/fredrikburmester/streamystats',
  tautulli: 'https://github.com/Tautulli/Tautulli',
  tracearr: 'https://github.com/connorgallopo/Tracearr',
  arcane: 'https://github.com/getarcaneapp/arcane',
  dockhand: 'https://github.com/Finsys/dockhand',
  dozzle: 'https://github.com/amir20/dozzle',
  komodo: 'https://github.com/moghtech/komodo',
  portainer: 'https://github.com/portainer/portainer',
  beszel: 'https://github.com/henrygd/beszel',
  glances: 'https://github.com/nicolargo/glances',
  scrutiny: 'https://github.com/AnalogJ/scrutiny',
  adguard: 'https://github.com/AdguardTeam/AdGuardHome',
  gluetun: 'https://github.com/passteque/gluetun',
  pihole: 'https://github.com/pi-hole/pi-hole',
  technitium: 'https://github.com/TechnitiumSoftware/DnsServer',
  crowdsec: 'https://github.com/crowdsecurity/crowdsec',
  unifi: 'https://ui.com/download',
  coolify: 'https://github.com/coollabsio/coolify',
  dispatcharr: 'https://github.com/Dispatcharr/Dispatcharr',
  homeassistant: 'https://github.com/home-assistant/core',
  proxmox: 'https://github.com/proxmox/pve-manager',
  synology: 'https://www.synology.com/en-global/dsm',
  truenas: 'https://github.com/truenas/middleware',
  ugreen: 'https://www.ugreen.com/en-gb/collections/uk-nas',
  unraid: 'https://github.com/unraid/webgui',
  audiobookshelf: 'https://github.com/advplyr/audiobookshelf',
  bookorbit: 'https://github.com/bookorbit/bookorbit',
  kavita: 'https://github.com/Kareadita/Kavita',
  komga: 'https://github.com/gotson/komga',
  readmeabook: 'https://github.com/kikootwo/readmeabook',
  shelfarr: 'https://github.com/Pedro-Revez-Silva/shelfarr',
  shelfmark: 'https://github.com/calibrain/shelfmark',
  immich: 'https://github.com/immich-app/immich',
});

function yaml(lines) {
  return `${lines.join('\n')}\n`;
}

function reviewedStarter(kind, image, lines, reviewNotes) {
  return Object.freeze({
    kind,
    image,
    serviceCount: 1,
    reviewRequired: true,
    reviewNotes: Object.freeze(reviewNotes),
    yaml: yaml(lines),
  });
}

// Named volumes keep examples host-independent; metadata lists required local changes.
const REVIEWED_STARTERS = Object.freeze({
  prowlarr: reviewedStarter('prowlarr', 'lscr.io/linuxserver/prowlarr:latest', [
    'services:',
    '  prowlarr:',
    '    image: lscr.io/linuxserver/prowlarr:latest',
    '    container_name: prowlarr',
    '    environment:',
    '      PUID: "1000"',
    '      PGID: "1000"',
    '      TZ: Etc/UTC',
    '    ports:',
    '      - "9696:9696"',
    '    volumes:',
    '      - prowlarr-config:/config',
    '    restart: unless-stopped',
    'volumes:',
    '  prowlarr-config:',
  ], [
    'Review PUID, PGID, timezone and the published port before deployment.',
    'The named volume stores Prowlarr configuration and needs its own backup plan.',
    'The image uses a mutable latest tag. Pin a reviewed digest for repeatable deployment.',
  ]),
  tautulli: reviewedStarter('tautulli', 'lscr.io/linuxserver/tautulli:latest', [
    'services:',
    '  tautulli:',
    '    image: lscr.io/linuxserver/tautulli:latest',
    '    container_name: tautulli',
    '    environment:',
    '      PUID: "1000"',
    '      PGID: "1000"',
    '      TZ: Etc/UTC',
    '    ports:',
    '      - "8181:8181"',
    '    volumes:',
    '      - tautulli-config:/config',
    '    restart: unless-stopped',
    'volumes:',
    '  tautulli-config:',
  ], [
    'Review PUID, PGID, timezone and the published port before deployment.',
    'Connect Tautulli to Plex during Tautulli setup.',
    'The image uses a mutable latest tag. Pin a reviewed digest for repeatable deployment.',
  ]),
  jellyfin: reviewedStarter('jellyfin', 'jellyfin/jellyfin:latest', [
    'services:',
    '  jellyfin:',
    '    image: jellyfin/jellyfin:latest',
    '    container_name: jellyfin',
    '    ports:',
    '      - "8096:8096"',
    '    volumes:',
    '      - jellyfin-config:/config',
    '      - jellyfin-cache:/cache',
    '    restart: unless-stopped',
    'volumes:',
    '  jellyfin-config:',
    '  jellyfin-cache:',
  ], [
    'This starts Jellyfin setup with persistent configuration and cache volumes.',
    'Add media mounts before using a library. Hardware devices require using the downloaded Compose file with Docker Compose.',
    'The image uses a mutable latest tag. Pin a reviewed digest for repeatable deployment.',
  ]),
});

const categoryRank = new Map(MARKETPLACE_CATEGORY_ORDER.map((id, index) => [id, index]));
const knownKinds = Object.keys(PORTS);
const catalogueKinds = Object.keys(CATALOGUE);
const missingKinds = knownKinds.filter((kind) => !Object.hasOwn(CATALOGUE, kind));
const unknownKinds = catalogueKinds.filter((kind) => !Object.hasOwn(PORTS, kind));
const missingUpstreamKinds = knownKinds.filter((kind) => !Object.hasOwn(UPSTREAM, kind));
const unknownUpstreamKinds = Object.keys(UPSTREAM).filter((kind) => !Object.hasOwn(PORTS, kind));
const invalidUpstreamKinds = Object.entries(UPSTREAM).filter(([, value]) => {
  try {
    const url = new URL(value);
    return url.protocol !== 'https:' || !!url.username || !!url.password;
  } catch {
    return true;
  }
}).map(([kind]) => kind);

if (missingKinds.length || unknownKinds.length || missingUpstreamKinds.length || unknownUpstreamKinds.length || invalidUpstreamKinds.length) {
  throw new Error(`Marketplace catalogue mismatch. Missing: ${missingKinds.join(', ') || 'none'}. Unknown: ${unknownKinds.join(', ') || 'none'}. Missing upstream: ${missingUpstreamKinds.join(', ') || 'none'}. Unknown upstream: ${unknownUpstreamKinds.join(', ') || 'none'}. Invalid upstream: ${invalidUpstreamKinds.join(', ') || 'none'}.`);
}

function compareEntries(a, b) {
  const categoryDifference = categoryRank.get(a.category) - categoryRank.get(b.category);
  if (categoryDifference) return categoryDifference;
  const left = a.label.toLowerCase();
  const right = b.label.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

function makeEntry(kind) {
  const [category, description] = CATALOGUE[kind];
  const reviewed = REVIEWED_STARTERS[kind] || null;
  // Single-container integrations may use generated starters; other kinds remain connect-only.
  const gen = reviewed ? null : starterFor(kind);
  const starter = reviewed
    || (gen && gen.yaml
      ? Object.freeze({ kind, image: gen.image, serviceCount: 1, reviewRequired: true, reviewNotes: Object.freeze(gen.notes), yaml: gen.yaml, generated: true })
      : null);
  const blocked = !reviewed && gen && gen.blocked ? gen.blocked : null;
  const mode = reviewed
    ? MARKETPLACE_MODES.REVIEWED_STARTER
    : starter ? MARKETPLACE_MODES.GENERATED_STARTER : MARKETPLACE_MODES.CONNECT_ONLY;
  return Object.freeze({
    kind,
    label: labelFor(kind),
    category,
    categoryLabel: MARKETPLACE_CATEGORY_LABELS[category],
    description,
    defaultPort: PORTS[kind],
    scheme: schemeFor(kind),
    upstreamUrl: UPSTREAM[kind],
    mode,
    connectOnly: mode === MARKETPLACE_MODES.CONNECT_ONLY,
    hasReviewedStarter: mode === MARKETPLACE_MODES.REVIEWED_STARTER,
    hasStarter: !!starter,
    blocked,
    actionLabel: reviewed ? 'Review starter' : starter ? 'Review Compose' : 'Service details',
    starter,
  });
}

export const MARKETPLACE_ENTRIES = Object.freeze(knownKinds.map(makeEntry).sort(compareEntries));

const ENTRIES_BY_KIND = new Map(MARKETPLACE_ENTRIES.map((entry) => [entry.kind, entry]));

export function marketplaceEntry(kind) {
  return ENTRIES_BY_KIND.get(String(kind || '').toLowerCase()) || null;
}

export function reviewedStarterCompose(kind) {
  const entry = marketplaceEntry(kind);
  return entry && entry.starter ? entry.starter.yaml : null;
}

function detectedSet(detectedKinds) {
  const found = new Set();
  for (const value of detectedKinds || []) {
    const kind = typeof value === 'string' ? value : value && value.kind;
    if (kind) found.add(String(kind).toLowerCase());
  }
  return found;
}

export function listMarketplace({ query = '', category = '', detectedKinds = [] } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const selectedCategory = String(category || '').trim().toLowerCase();
  const installedKinds = detectedSet(detectedKinds);
  const entries = MARKETPLACE_ENTRIES
    .filter((entry) => !selectedCategory || selectedCategory === 'all' || entry.category === selectedCategory)
    .filter((entry) => !needle || [
      entry.kind,
      entry.label,
      entry.description,
      entry.categoryLabel,
    ].some((value) => value.toLowerCase().includes(needle)))
    .map((entry) => Object.freeze({ ...entry, installed: installedKinds.has(entry.kind) }));
  return Object.freeze(entries);
}

export function groupMarketplace(options = {}) {
  const entries = listMarketplace(options);
  return Object.freeze(MARKETPLACE_CATEGORIES.map((category) => Object.freeze({
    ...category,
    entries: Object.freeze(entries.filter((entry) => entry.category === category.id)),
  })).filter((group) => group.entries.length > 0));
}
