// Read only explicitly posted selections; discovery can add rows but cannot select them.
export function draftFromPairForm(detected, body) {
  const rows = [];
  const posted = new Set();
  // The bounded HTTP reader limits body size and field count. Indexes are form positions,
  // not a service cap: a selected row can appear anywhere in a large detected stack.
  const indexes = Object.keys(body)
    .filter((key) => /^service_(0|[1-9][0-9]*)$/.test(key))
    .map((key) => Number(key.slice('service_'.length)))
    .filter(Number.isSafeInteger)
    .sort((a, b) => a - b);
  for (const i of indexes) {
    const instanceId = String(body[`service_${i}`] || '');
    if (posted.has(instanceId)) {
      rows.push({ instanceId, included: true, baseUrl: '', remoteBaseUrl: '' });
      continue;
    }
    posted.add(instanceId);
    rows.push({
      instanceId,
      included: body[`include_${i}`] === 'on',
      // buildBundle revalidates this reachability override.
      forced: body[`force_${i}`] === 'on',
      baseUrl: String(body[`base_${i}`] || ''),
      remoteBaseUrl: String(body[`remote_${i}`] || ''),
    });
  }

  // Preserve newly discovered rows without selecting them in a stale form submission.
  for (const d of detected) {
    if (d.instanceId && !posted.has(d.instanceId)) {
      rows.push({ instanceId: d.instanceId, included: false, baseUrl: '', remoteBaseUrl: '' });
    }
  }
  return {
    services: rows,
    edgeAccess: {
      domain: String(body.edge_domain || ''),
      clientId: String(body.edge_client_id || ''),
      clientSecret: String(body.edge_client_secret || ''),
    },
  };
}

