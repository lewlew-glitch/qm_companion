// Protect Companion control-plane containers from panel actions.

export const PROTECTED_CONTAINER_NAMES = Object.freeze(['qm-companion', 'qm-socket-proxy']);

// Compose service names protected through their labels.
export const PROTECTED_SERVICE_NAMES = Object.freeze(['companion', 'socket-proxy', 'qm-companion', 'qm-socket-proxy']);

// qm.protected shields a service regardless of its name.
export const PROTECT_LABEL = 'qm.protected';

const NAME_SET = new Set(PROTECTED_CONTAINER_NAMES);
const SERVICE_SET = new Set(PROTECTED_SERVICE_NAMES);

export function isProtectedContainer(name, composeService, labels) {
  if (NAME_SET.has(String(name || '').replace(/^\//, ''))) return true;
  if (SERVICE_SET.has(String(composeService || ''))) return true;
  const flag = labels && typeof labels === 'object' ? labels[PROTECT_LABEL] : '';
  return String(flag || '').toLowerCase() === 'true';
}
