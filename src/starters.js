// Compose starters cover supported single-container services.

import { PORTS } from './kinds.js';

// Host-OS services cannot use a container starter.
const HOST_OS = new Set(['proxmox', 'truenas', 'synology', 'unraid', 'ugreen']);

// Docker-socket tools remain connect-only because a socket bind grants control of the host.
const SOCKET = {
  portainer: 'Portainer manages Docker through the host socket, which grants control of the host. Run it separately, then point Companion at it.',
  dozzle: 'Dozzle reads container logs through the host Docker socket, which grants control of the host. Run it separately, then point Companion at it.',
  dockhand: 'Dockhand manages Docker through the host socket, which grants control of the host. Run it separately, then point Companion at it.',
  arcane: 'Arcane manages Docker through the host socket, which grants control of the host. Run it separately, then point Companion at it.',
  glances: 'Glances reads container stats through the host Docker socket, which grants control of the host. Run it separately, then point Companion at it.',
};

// Multi-container services require a reviewed stack.
const MULTI = {
  immich: 'Immich needs its server, machine-learning, Redis and Postgres services together.',
  komodo: 'Komodo needs its core, a periphery agent and a database.',
  streamystats: 'Streamystats needs its app and a Postgres database.',
  jellystat: 'Jellystat needs its app and a Postgres database.',
  unifi: 'The UniFi Network application needs its own MongoDB.',
  coolify: 'Coolify installs itself and its dependencies through its own script, not a single compose.',
  gluetun: 'Gluetun needs the NET_ADMIN capability, which Companion does not deploy. Add it by hand.',
};

const MANUAL = {
  crowdsec: 'CrowdSec needs access to the logs it protects and its own acquisition configuration. Run it separately, then point Companion at its Local API.',
};

// Shared linuxserver.io starter shape.
const LS = new Set([
  'radarr', 'sonarr', 'lidarr', 'prowlarr', 'bazarr', 'sabnzbd', 'nzbget',
  'qbittorrent', 'transmission', 'deluge', 'jackett', 'nzbhydra2', 'tautulli', 'emby', 'plex',
]);

// Single-container images and configuration mounts.
const PLAIN = {
  jellyfin: { image: 'jellyfin/jellyfin:latest', vols: [['jellyfin-config', '/config'], ['jellyfin-cache', '/cache']] },
  jellyseerr: { image: 'fallenbagel/jellyseerr:latest', vols: [['jellyseerr-config', '/app/config']] },
  wizarr: { image: 'ghcr.io/wizarrrr/wizarr:latest', vols: [['wizarr-data', '/data/database']] },
  maintainerr: { image: 'ghcr.io/jorenn92/maintainerr:latest', vols: [['maintainerr-data', '/opt/data']] },
  beszel: { image: 'henrygd/beszel:latest', vols: [['beszel-data', '/beszel_data']] },
  scrutiny: { image: 'ghcr.io/analogj/scrutiny:master-omnibus', vols: [['scrutiny-config', '/opt/scrutiny/config'], ['scrutiny-influxdb', '/opt/scrutiny/influxdb']] },
  dispatcharr: { image: 'ghcr.io/dispatcharr/dispatcharr:latest', vols: [['dispatcharr-data', '/data']] },
  adguard: { image: 'adguard/adguardhome:latest', vols: [['adguard-work', '/opt/adguardhome/work'], ['adguard-conf', '/opt/adguardhome/conf']] },
  pihole: { image: 'pihole/pihole:latest', vols: [['pihole-config', '/etc/pihole']], env: { TZ: 'Etc/UTC' } },
  technitium: { image: 'technitium/dns-server:latest', vols: [['technitium-config', '/etc/dns']] },
  homeassistant: { image: 'ghcr.io/home-assistant/home-assistant:stable', vols: [['homeassistant-config', '/config']] },
  komga: { image: 'gotson/komga:latest', vols: [['komga-config', '/config']] },
  kavita: { image: 'jvmilazz0/kavita:latest', vols: [['kavita-config', '/kavita/config']] },
  audiobookshelf: { image: 'ghcr.io/advplyr/audiobookshelf:latest', vols: [['audiobookshelf-config', '/config'], ['audiobookshelf-metadata', '/metadata']] },
  tdarr: { image: 'ghcr.io/haveagitgat/tdarr:latest', vols: [['tdarr-server', '/app/server'], ['tdarr-configs', '/app/configs']] },
  qui: { image: 'ghcr.io/autobrr/qui:latest', vols: [['qui-config', '/config']] },
};

function q(v) { return `"${v}"`; }

function lines(kind) {
  const port = PORTS[kind];
  const out = ['services:', `  ${kind}:`];
  if (LS.has(kind)) {
    out.push(`    image: lscr.io/linuxserver/${kind}:latest`, `    container_name: ${kind}`,
      '    environment:', '      PUID: "1000"', '      PGID: "1000"', '      TZ: Etc/UTC');
    if (kind === 'qbittorrent') out.push(`      WEBUI_PORT: ${q(port)}`);
    if (port) out.push('    ports:', `      - ${q(`${port}:${port}`)}`);
    out.push('    volumes:', `      - ${kind}-config:/config`, '    restart: unless-stopped',
      'volumes:', `  ${kind}-config:`);
    return out;
  }
  const spec = PLAIN[kind];
  out.push(`    image: ${spec.image}`, `    container_name: ${kind}`);
  const env = spec.env || {};
  const envKeys = Object.keys(env);
  if (envKeys.length) {
    out.push('    environment:');
    for (const k of envKeys) out.push(`      ${k}: ${/[^A-Za-z0-9_.\/-]/.test(String(env[k])) ? q(env[k]) : env[k]}`);
  }
  if (port) out.push('    ports:', `      - ${q(`${port}:${port}`)}`);
  const vols = (spec.vols || []).slice();
  if (vols.length) {
    out.push('    volumes:');
    for (const [name, path] of vols) out.push(`      - ${name}:${path}`);
  }
  out.push('    restart: unless-stopped');
  if (vols.length) { out.push('volumes:'); for (const [name] of vols) out.push(`  ${name}:`); }
  return out;
}

const NOTES = [
  'Review the published port, timezone and any credentials before you deploy.',
  'Config lives in a named volume, so give it a backup plan.',
  'The image uses a mutable latest tag. Pin a reviewed digest for a repeatable deployment.',
];

/** Return a starter, a block reason, or null for an unknown kind. */
export function starterFor(kind) {
  const k = String(kind || '');
  if (HOST_OS.has(k)) return { blocked: 'This runs on your hardware, not as a container. Point Companion at its address instead.' };
  if (SOCKET[k]) return { blocked: SOCKET[k] };
  if (MULTI[k]) return { blocked: MULTI[k] };
  if (MANUAL[k]) return { blocked: MANUAL[k] };
  if (LS.has(k) || PLAIN[k]) {
    const image = LS.has(k) ? `lscr.io/linuxserver/${k}:latest` : PLAIN[k].image;
    return { image, yaml: `${lines(k).join('\n')}\n`, notes: NOTES };
  }
  return null;
}

// Kinds with deployable single-container starters.
export function deployableKinds() {
  return [...LS, ...Object.keys(PLAIN)].sort();
}
