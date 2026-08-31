// Classify secret names and credential-shaped values.
export const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE|SALT|SEED|AUTH|COOKIE|SESSION|(?:^|[_-])DSN(?:$|[_-])|DATABASE_URL|DB_URL|CONNECTION_STRING/i;

// Treat long mixed-alphanumeric values as credential-shaped.
export function secretShapedValue(value) {
  const s = String(value);
  if (/^(?:basic|bearer)\s+\S+/i.test(s)) return true;
  if (/(?:password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s;,]+/i.test(s)) return true;
  try {
    const url = new URL(s);
    if (url.username || url.password) return true;
    for (const [name, item] of url.searchParams) {
      if (item && SECRET_NAME_RE.test(name)) return true;
    }
    if (url.pathname.split('/').some((part) => part.length >= 16 && /^[A-Za-z0-9._~=-]+$/.test(part) && /[A-Za-z]/.test(part) && /[0-9]/.test(part))) return true;
  } catch { /* not a URL */ }
  if (s.length < 16) return false;
  return /^[A-Za-z0-9._+/=~-]{16,}$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s);
}

// Empty values may be shown as present but empty.
export function isSecretValue(name, value) {
  return !!value && (SECRET_NAME_RE.test(String(name)) || secretShapedValue(value));
}

// Only allow-listed operational metadata may reach the browser.
export function isSafeInspectableEnvValue(name, value) {
  const n = String(name).toUpperCase();
  const v = String(value);
  if (!v) return true;
  if (isSecretValue(n, v)) return false;
  if (/^(?:PUID|PGID|UID|GID|PORT|UMASK|UMASK_SET)$/.test(n)) return /^\d{1,10}$/.test(v);
  if (n === 'TZ') return /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+){0,3}$/.test(v) && v.length <= 96;
  if (/^(?:LANG|LANGUAGE|LC_[A-Z_]+)$/.test(n)) return /^[A-Za-z0-9_.:@+-]{1,96}$/.test(v);
  if (/^(?:NODE_ENV|ENVIRONMENT|LOG_LEVEL|TERM|DEBUG)$/.test(n)) return /^[A-Za-z0-9_.:+-]{1,64}$/.test(v);
  if (n === 'PATH') return /^[A-Za-z0-9_./:+-]{1,1024}$/.test(v);
  return false;
}

export function isSafeInspectableLabelValue(name, value) {
  const n = String(name);
  const v = String(value);
  if (!v) return true;
  if (isSecretValue(n, v)) return false;
  if (/^com\.docker\.compose\.(?:project|service)$/.test(n)) return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v);
  if (n === 'com.docker.compose.container-number') return /^\d{1,6}$/.test(v);
  if (n === 'com.docker.compose.oneoff' || n === 'qm.protected') return /^(?:true|false)$/i.test(v);
  if (n === 'com.docker.compose.version') return /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,31}$/.test(v);
  if (n === 'qm.url' && v.length <= 2048) {
    try {
      const url = new URL(v);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }
  return false;
}
