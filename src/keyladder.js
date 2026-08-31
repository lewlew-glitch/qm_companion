// Map each missing-key service to one recovery path: mounted file, API mint, or manual settings.

import { dirname } from 'node:path';

import { PORTS, pairingCredentialState } from './kinds.js';
import { configFileRule } from './detect.js';

// Mint-capable kinds mirror mint.js MINT_KINDS; shared global keys remain file/manual only.
const MINT_SPECS = {
  jellyfin: { usernameLabel: 'Admin username', passwordLabel: 'Password', note: 'Signs in as this administrator and creates an API key named Quartermaster.' },
  emby: { usernameLabel: 'Admin username', passwordLabel: 'Password', note: 'Signs in as this administrator and creates an API key named Quartermaster.' },
  portainer: { usernameLabel: 'Admin username', passwordLabel: 'Password', note: 'Signs in and creates an access token named Quartermaster.' },
  technitium: { usernameLabel: 'Admin username', passwordLabel: 'Password', note: 'Creates a non-expiring API token named Quartermaster.' },
  truenas: { usernameLabel: 'Username', passwordLabel: 'Password', note: 'Creates an API key named Quartermaster over HTTPS.' },
  proxmox: { usernameLabel: 'Username with realm, e.g. root@pam', passwordLabel: 'Password', note: 'Creates an API token named Quartermaster.' },
  immich: { usernameLabel: 'Email', passwordLabel: 'Password', note: 'Signs in and creates an API key named Quartermaster.' },
  komga: { usernameLabel: 'Email', passwordLabel: 'Password', note: 'Creates an API key named Quartermaster.' },
  qui: { usernameLabel: 'Username', passwordLabel: 'Password', note: 'Signs in and creates an API key named Quartermaster.' },
  arcane: { usernameLabel: 'Username', passwordLabel: 'Password', note: 'Signs in and creates an API key named Quartermaster.' },
};

// Best-effort deep links to each service's key settings page.
const SETTINGS_PATH = {
  radarr: '/settings/general', sonarr: '/settings/general', lidarr: '/settings/general', prowlarr: '/settings/general',
  bazarr: '/settings/general', sabnzbd: '/config/general/', jackett: '/', nzbhydra2: '/config/main',
  tautulli: '/settings', jellyseerr: '/settings/main',
  jellyfin: '/web/#/dashboard/keys', emby: '/web/index.html#!/apikeys', portainer: '/#!/account/tokens',
  technitium: '/', truenas: '/ui/apikeys', proxmox: '/', immich: '/user-settings?isOpen=api-keys',
  komga: '/account/api-keys', qui: '/settings', arcane: '/settings',
  wizarr: '/settings', jellystat: '/settings', tracearr: '/settings', dockhand: '/settings',
  coolify: '/security/api-tokens', dispatcharr: '/settings', unifi: '/', unraid: '/Settings',
  kavita: '/preferences#authentication', audiobookshelf: '/config', readmeabook: '/settings', shelfarr: '/settings',
  homeassistant: '/profile/security',
};

// Derive file-backed kinds directly from discovery rules.
export function missingKeyKinds() {
  return Object.keys(PORTS).filter((kind) => pairingCredentialState(kind) === 'missing-key');
}

function fileRuleFor(kind) {
  const rule = configFileRule(kind);
  if (!rule) return null;
  return {
    sourcePath: rule.sourcePath,
    mountedName: rule.mountedName,
    folder: kind,
    // Container directory shown in mount guidance.
    mountHint: dirname(rule.sourcePath),
    target: `/stack/${kind}`,
  };
}

// Return the single recovery rung for a missing-key kind.
export function ladderFor(kind) {
  if (pairingCredentialState(kind) !== 'missing-key') return null;
  const settingsPath = SETTINGS_PATH[kind];
  const fileRule = fileRuleFor(kind);
  if (fileRule) return { class: 'file', fileRule, settingsPath };
  if (MINT_SPECS[kind]) return { class: 'mint', mint: MINT_SPECS[kind], settingsPath };
  return { class: 'manual', settingsPath };
}

// Mint-class kinds, aligned with mint.js MINT_KINDS.
export const LADDER_MINT_KINDS = Object.keys(MINT_SPECS);
