// Settings for the all-in-one image, which runs the Docker socket proxy and Companion in one container.
// The proxy runs as root on the loopback address and is the only process that can open the Docker
// socket. Companion runs as the node user and reaches Docker through the proxy with a key generated at
// each start.

import { randomBytes } from 'node:crypto';

import { integerSetting } from '../config-values.js';

export const DOCKER_SOCKET = '/var/run/docker.sock';
// The node user and group in the base image.
export const APP_UID = 1000;
export const APP_GID = 1000;

// The proxy switches from docker-compose.published.yml, plus EVENTS and VERSION, which the upstream
// image turns on by default. POST and EXEC follow DOCKER_ACCESS_MAX.
export const PROXY_SWITCHES = Object.freeze({
  CONTAINERS: '1',
  IMAGES: '1',
  VOLUMES: '1',
  NETWORKS: '1',
  INFO: '1',
  PING: '1',
  SYSTEM: '1',
  EVENTS: '1',
  VERSION: '1',
});

// Matches docker-compose.management.yml and docker-compose.shell.yml.
const ACCESS = {
  read: { POST: '0', EXEC: '0' },
  manage: { POST: '1', EXEC: '0' },
  shell: { POST: '1', EXEC: '1' },
};

/** Installed Docker access and the proxy's POST and EXEC for it. Unset is Read only, as in Companion. */
export function accessPlan(raw) {
  const mode = raw === undefined ? 'read' : raw;
  if (!Object.hasOwn(ACCESS, mode)) throw new Error('DOCKER_ACCESS_MAX must be exactly read, manage or shell');
  return { mode, ...ACCESS[mode] };
}

/** Loopback port for the proxy. Change it when 2375 is taken on a host-network install. */
export function proxyPort(raw) {
  return integerSetting(raw, { name: 'PROXY_PORT', fallback: 2375, min: 1, max: 65535 });
}

/** Why the mounted socket cannot be used, or null when only root and its group can connect. */
export function socketProblem(stats) {
  if (!stats) return 'missing';
  if (!stats.isSocket()) return 'not a socket';
  // Connecting to a Unix socket needs write permission on it.
  const open = (stats.mode & 0o002) !== 0
    || (stats.uid === APP_UID && (stats.mode & 0o200) !== 0)
    || (stats.gid === APP_GID && (stats.mode & 0o020) !== 0);
  return open ? 'open to companion' : null;
}

/** The upstream template with its listener moved to the loopback address. */
export function proxyConfig(template, port) {
  const marker = '${BIND_CONFIG}';
  if (template.split(marker).length !== 2) throw new Error(`The proxy template must contain ${marker} once`);
  return template.replace(marker, `127.0.0.1:${port}`);
}

export function proxyKey() {
  return randomBytes(32).toString('hex');
}

/** The proxy's whole environment. Nothing else from the container reaches it, SECRET_KEY included. */
export function proxyEnvironment({ key, access, path }) {
  return {
    PATH: path,
    // Keeps one line per Docker request out of the Companion log. Warnings and errors still show.
    LOG_LEVEL: 'warning',
    SOCKET_PATH: DOCKER_SOCKET,
    QM_PROXY_KEY: key,
    ...PROXY_SWITCHES,
    POST: access.POST,
    EXEC: access.EXEC,
  };
}

/** The container's environment for Companion, pointed at the loopback proxy. */
export function companionEnvironment(env, { key, access, port }) {
  return {
    ...env,
    HOME: '/home/node',
    DOCKER_HOST: `tcp://127.0.0.1:${port}`,
    QM_PROXY_KEY: key,
    DOCKER_ACCESS_MAX: access.mode,
  };
}
