// Strict Observer v1 scope vocabulary without wildcards or implied grants.

export const OBSERVER_SCOPES = Object.freeze([
  'containers.read',
  'events.read',
  'stacks.read',
  'summary.read',
  'updates.read',
]);

export const MAX_SCOPES = 16;

// Canonical scope lists are known, sorted, unique, non-empty, and bounded.
export function validateScopeList(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'scopes is not a list' };
  if (list.length === 0) return { ok: false, error: 'scopes is empty' };
  if (list.length > MAX_SCOPES) return { ok: false, error: 'scopes exceeds the cap' };
  for (let i = 0; i < list.length; i += 1) {
    const scope = list[i];
    if (!OBSERVER_SCOPES.includes(scope)) return { ok: false, error: `unknown scope ${String(scope)}` };
    if (i > 0 && !(list[i - 1] < scope)) {
      return { ok: false, error: 'scopes must be sorted ascending without duplicates' };
    }
  }
  return { ok: true };
}

// Authorize only known scopes from a canonical grant list.
export function hasScope(granted, needed) {
  if (!OBSERVER_SCOPES.includes(needed)) return false;
  if (!validateScopeList(granted).ok) return false;
  return granted.includes(needed);
}
