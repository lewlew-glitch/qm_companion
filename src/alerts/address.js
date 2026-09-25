// The plain listener address services use for webhooks.

import { hostname } from 'node:os';
import { config } from '../config.js';
import { inspectContainer } from '../docker.js';

export async function alertIntakeAddress({ settings = config, inspect = inspectContainer, containerId = hostname() } = {}) {
  let port = settings.port;
  if (settings.qmHost) {
    try {
      const self = await inspect(containerId);
      const published = self?.NetworkSettings?.Ports?.[`${settings.port}/tcp`]?.[0]?.HostPort;
      if (typeof published === 'string' && /^\d+$/.test(published)) {
        const value = Number(published);
        if (Number.isInteger(value) && value >= 1 && value <= 65535) port = value;
      }
    } catch { /* use the listener port when Docker cannot report its mapping */ }
  }
  return {
    baseUrl: settings.qmHost ? `http://${settings.qmHost}:${port}` : null,
    localOnly: settings.bind === '127.0.0.1' || settings.bind === '::1',
  };
}
