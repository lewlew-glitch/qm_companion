// Classify availability from Docker lifecycle state and probe results.
export function availabilityFor(row) {
  const state = typeof row?.dockerState === 'string' ? row.dockerState : '';
  if (!state) return 'unverified';
  if (state !== 'running') return 'not-running';
  if (row.up === true) return 'reachable';
  if (row.up === false) return 'unreachable';
  return 'unverified';
}

// Display label for a non-running Docker lifecycle state.
export function dockerStateWord(dockerState) {
  const state = String(dockerState || '').toLowerCase();
  if (state === 'paused') return 'Paused';
  if (state === 'restarting') return 'Restarting';
  if (state === 'created') return 'Created, never started';
  if (state === 'dead') return 'Dead';
  if (state === 'removing') return 'Being removed';
  return 'Stopped';
}
