// Detect containers published on every host interface.

/** A published port with no host address, or one bound to every interface. */
function isWideBinding(port) {
  if (!port || !port.PublicPort) return false;
  const ip = typeof port.IP === 'string' ? port.IP.trim() : '';
  // Docker reports an unspecified binding as '0.0.0.0' or '::'; some daemons report it as empty.
  return ip === '' || ip === '0.0.0.0' || ip === '::';
}

/** Host-network containers expose no Docker port mappings but may listen on every interface. */
function isHostNetwork(container) {
  const mode = container?.HostConfig?.NetworkMode;
  return typeof mode === 'string' && mode.toLowerCase() === 'host';
}

/** Return wildcard-published ports from a raw container list. */
export function widelyBoundContainers(containers) {
  const out = [];
  for (const c of containers || []) {
    const hostNetwork = isHostNetwork(c);
    const wide = (c.Ports || []).filter(isWideBinding);
    if (!hostNetwork && wide.length === 0) continue;
    const name = (c.Names && c.Names[0] ? String(c.Names[0]) : '').replace(/^\//, '');
    out.push({
      id: typeof c.Id === 'string' ? c.Id.slice(0, 12) : '',
      name: name || (typeof c.Id === 'string' ? c.Id.slice(0, 12) : 'unknown'),
      hostNetwork,
      ports: wide.map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type || 'tcp'}`).sort(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Build remediation text for containers with wildcard port bindings. */
export function wideBindingAdvice(affected, bindAddress) {
  if (!affected || affected.length === 0) return null;
  const names = affected.map((c) => c.name).join(', ');
  const onHostNetwork = affected.filter((c) => c.hostNetwork).map((c) => c.name);
  const address = bindAddress || '127.0.0.1';
  return {
    count: affected.length,
    names,
    summary:
      `${affected.length} container${affected.length === 1 ? '' : 's'} publish${affected.length === 1 ? 'es' : ''} on every host interface `
      + `(${names}), including VPN and public interfaces.`,
    updateNote:
      'Image updates keep the existing port bindings. Change the Compose mapping and recreate the container.',
    hostNetwork: onHostNetwork,
    hostNetworkNote:
      onHostNetwork.length === 0
        ? null
        : `${onHostNetwork.join(', ')} use network_mode: host and may listen on every host interface. `
          + 'Move the stack to a bridged network to limit its exposure.',
    remedy:
      `Add the host address to each published port in that stack's Compose file, for example `
      + `"${address}:8080:80" instead of "8080:80", then recreate only that stack:\n`
      + `  docker compose -f <that stack's compose file> up -d --force-recreate\n`
      + 'Volumes and bind mounts remain; files in the container writable layer do not. Back up any '
      + 'unmounted data first.\n'
      + 'For a Companion-managed stack, edit its Compose text in Stacks and redeploy.',
  };
}

/** Apply the same check to the normalized container-listing shape. */
export function widelyBoundFromListing(rows) {
  const out = [];
  for (const row of rows || []) {
    const wide = Array.isArray(row?.widePorts) ? row.widePorts : [];
    const hostNetwork = row?.hostNetwork === true;
    if (!hostNetwork && wide.length === 0) continue;
    out.push({ id: row.id || '', name: row.name || row.id || 'unknown', hostNetwork, ports: [...wide].sort() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
