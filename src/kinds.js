// Supported services, default ports and image mappings.
export const PORTS = {
  radarr: 7878, sonarr: 8989, lidarr: 8686, prowlarr: 9696, bazarr: 6767,
  sabnzbd: 8080, nzbget: 6789, qbittorrent: 8080, transmission: 9091, deluge: 8112,
  jackett: 9117, nzbhydra2: 5076, qui: 7476,
  jellyfin: 8096, emby: 8096, plex: 32400,
  jellyseerr: 5055, musicseerr: 8688, wizarr: 5690,
  tautulli: 8181, jellystat: 3000, streamystats: 3000, tracearr: 3000, maintainerr: 6246,
  portainer: 9443, dozzle: 8080, dockhand: 3000, komodo: 9120, arcane: 3552, beszel: 8090,
  glances: 61208, scrutiny: 8080, gluetun: 8000, coolify: 8000, dispatcharr: 9191,
  adguard: 80, pihole: 80, technitium: 5380,
  homeassistant: 8123, unifi: 443, proxmox: 8006,
  truenas: 443, synology: 5000, unraid: 80, ugreen: 9999,
  komga: 25600, kavita: 5000, audiobookshelf: 13378, readmeabook: 3030, bookorbit: 8080,
  shelfmark: 8084, shelfarr: 3000, immich: 2283, tdarr: 8265,
};

// Kinds using HTTPS by default.
const HTTPS = new Set(['portainer', 'unifi', 'truenas', 'proxmox']);

export function schemeFor(kind) {
  return HTTPS.has(kind) ? 'https' : 'http';
}

// Kinds that require interactive credentials rather than a transferable API key.
export const NEEDS_LOGIN = new Set([
  'qbittorrent', 'deluge', 'synology', 'nzbget', 'ugreen', 'musicseerr', 'beszel', 'bookorbit',
  // Komodo requires a two-part interactive credential.
  'komodo',
]);

// Credential modes allowed to run with an empty secret object.
export const CREDENTIAL_OPTIONAL = new Set([
  'transmission', 'glances', 'adguard', 'pihole', 'tdarr', 'maintainerr', 'scrutiny', 'dozzle', 'gluetun',
  'streamystats', 'shelfmark',
]);

// Classify transfer readiness; credential extraction remains in the build path.
export function pairingCredentialState(kind, apiKey, credentialConflict = false) {
  if (credentialConflict) return 'conflict';
  const hasTransferableKey = !NEEDS_LOGIN.has(kind) && typeof apiKey === 'string' && apiKey.length > 0;
  if (hasTransferableKey) return 'included';
  if (CREDENTIAL_OPTIONAL.has(kind)) return 'not-required';
  if (kind === 'komodo') return 'key-and-secret';
  if (kind === 'plex' || NEEDS_LOGIN.has(kind)) return 'sign-in';
  return 'missing-key';
}

// Aliases for image basenames that do not contain their kind name.
const ALIASES = {
  overseerr: 'jellyseerr',
  'pms-docker': 'plex',
  plexinc: 'plex',
  'unifi-network-application': 'unifi',
  uniftermi: 'unifi',
  adguardhome: 'adguard',
  'home-assistant': 'homeassistant',
  hass: 'homeassistant',
  'audiobookshelf-container': 'audiobookshelf',
  droppedneedle: 'musicseerr',
  scrutiny: 'scrutiny',
};

const KINDS = Object.keys(PORTS);

function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function exactKind(candidate) {
  for (const [alias, kind] of Object.entries(ALIASES)) {
    if (candidate === normalise(alias)) return kind;
  }
  return KINDS.includes(candidate) ? candidate : null;
}

// Map an image or fallback container name to a service kind.
export function matchImage(image, name) {
  const imageBase = String(image || '').split('/').pop().split(':')[0];
  const candidates = [imageBase, image, name].map(normalise).filter(Boolean);

  for (const c of candidates) {
    const exact = exactKind(c);
    if (exact) return exact;
  }
  for (const c of candidates) {
    for (const [alias, kind] of Object.entries(ALIASES)) {
      if (c.includes(normalise(alias))) return kind;
    }
    for (const kind of KINDS) {
      if (c.includes(kind)) return kind;
    }
  }
  return null;
}

const LABELS = {
  qbittorrent: 'qBittorrent', sabnzbd: 'SABnzbd', nzbget: 'NZBGet', nzbhydra2: 'NZBHydra2',
  jellyfin: 'Jellyfin', jellyseerr: 'Jellyseerr', musicseerr: 'MusicSeerr', plex: 'Plex',
  homeassistant: 'Home Assistant', unifi: 'UniFi', truenas: 'TrueNAS', adguard: 'AdGuard Home',
  pihole: 'Pi-hole', audiobookshelf: 'Audiobookshelf', portainer: 'Portainer', tautulli: 'Tautulli',
};

export function labelFor(kind) {
  return LABELS[kind] || kind.charAt(0).toUpperCase() + kind.slice(1);
}
