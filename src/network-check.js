// A container on a macvlan or ipvlan network (Unraid's br0) takes its own address on the LAN, and an
// address that clashes with another device can knock that device offline. Companion and its proxy
// only need their own bridge network, so find either of them attached that way and say so.

const CHECK_MS = 10 * 60_000;
const LAN_DRIVERS = new Set(['macvlan', 'ipvlan']);

// The proxy's container name from DOCKER_HOST, e.g. tcp://qm-socket-proxy:2375.
export function proxyName(dockerHost) {
  const match = /^tcp:\/\/([^:/]+)(?::\d+)?\/?$/u.exec(String(dockerHost || ''));
  return match && !/^[\d.]+$/u.test(match[1]) ? match[1] : '';
}

// Docker sets a container's hostname to its short id unless the template names one.
export function ownId(name) {
  return /^[a-f0-9]{12,64}$/u.test(String(name || '')) ? name : '';
}

export function lanAttachments(containers, networks, { selfId = '', proxy = '' } = {}) {
  const drivers = new Map();
  for (const network of Array.isArray(networks) ? networks : []) {
    if (network && typeof network.Name === 'string') drivers.set(network.Name, String(network.Driver || ''));
  }
  const found = [];
  for (const container of Array.isArray(containers) ? containers : []) {
    const name = String(container?.Names?.[0] || '').replace(/^\//, '');
    const id = typeof container?.Id === 'string' ? container.Id : '';
    if (!(selfId && id.startsWith(selfId)) && !(proxy && name === proxy)) continue;
    const attached = container.NetworkSettings?.Networks;
    for (const network of Object.keys(attached && typeof attached === 'object' ? attached : {})) {
      const driver = drivers.get(network);
      if (!LAN_DRIVERS.has(driver)) continue;
      const ip = attached[network]?.IPAddress;
      found.push({ container: name, network, driver, ip: typeof ip === 'string' ? ip : '' });
    }
  }
  return found;
}

export function createLanCheck({ read, identity, now = Date.now }) {
  let at = -Infinity, found = [], inFlight = null;
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = new Promise((resolve) => resolve(read()))
      .then(([containers, networks]) => lanAttachments(containers, networks, identity)).catch(() => [])
      .then((rows) => {
        found = rows;
        at = now();
        return rows;
      }).finally(() => { inFlight = null; });
    return inFlight;
  }
  return {
    current() {
      if (now() - at >= CHECK_MS) refresh();
      return found;
    },
    refresh,
  };
}
