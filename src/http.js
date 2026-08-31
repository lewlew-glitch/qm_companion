// Small framework-free HTTP helpers.

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (opts.secure) s += '; Secure';
  if (opts.maxAge != null) s += `; Max-Age=${opts.maxAge}`;
  if (opts.expire) s += '; Max-Age=0';
  return s;
}

/** Add one Set-Cookie without discarding any already pending on this response. */
export function appendCookie(res, value) {
  const current = res.getHeader('set-cookie');
  if (current === undefined) res.setHeader('set-cookie', value);
  else if (Array.isArray(current)) res.setHeader('set-cookie', [...current, value]);
  else res.setHeader('set-cookie', [String(current), value]);
}

// Use the TCP peer address for authentication throttling.
export function peerIp(req) {
  const a = req.socket.remoteAddress || '';
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    // Drain oversized bodies so the handler can return a structured response.
    req.on('data', (c) => {
      if (over) return;
      data += c;
      if (data.length > limit) {
        over = true;
        data = '';
        resolve({});
      }
    });
    req.on('end', () => {
      if (over) return;
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) return resolve(JSON.parse(data || '{}'));
        if (type.includes('form-urlencoded')) {
          const o = {};
          for (const [k, v] of new URLSearchParams(data)) o[k] = v;
          return resolve(o);
        }
      } catch {
        return resolve({});
      }
      resolve({});
    });
    req.on('error', () => resolve({}));
  });
}

// Pairing forms report malformed and oversized bodies separately.
export function readFormBody(req, limit = 96 * 1024) {
  return new Promise((resolve) => {
    const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    const chunks = [];
    let bytes = 0;
    let over = false;
    let failed = false;

    req.on('data', (chunk) => {
      if (over || failed) return;
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(part);
    });
    req.on('end', () => {
      if (failed) return;
      if (over) return resolve({ ok: false, reason: 'too-large' });
      if (type !== 'application/x-www-form-urlencoded') return resolve({ ok: false, reason: 'content-type' });
      try {
        const values = Object.create(null);
        let fields = 0;
        for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
          fields += 1;
          if (fields > 512 || Object.hasOwn(values, key)) return resolve({ ok: false, reason: 'malformed' });
          values[key] = value;
        }
        return resolve({ ok: true, value: values });
      } catch {
        return resolve({ ok: false, reason: 'malformed' });
      }
    });
    req.on('error', () => {
      if (failed) return;
      failed = true;
      resolve({ ok: false, reason: 'read' });
    });
  });
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    ...headers,
  });
  res.end(body);
}

export function html(res, status, body, headers = {}) {
  send(res, status, body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
}

export function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), {
    'content-type': 'application/json',
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    ...headers,
  });
}

export function redirect(res, to) {
  send(res, 303, '', { location: to });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
