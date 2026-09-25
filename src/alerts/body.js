// Bounded webhook and mobile request bodies.

export function readAlertBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      chunks.length = 0;
      resolve(result);
    }
    req.on('data', (chunk) => {
      if (done) return;
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > limit) return finish({ ok: false, status: 413 });
      chunks.push(part);
    });
    req.on('end', () => {
      if (!done) finish({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on('error', () => finish({ ok: false, status: 400 }));
    req.on('aborted', () => finish({ ok: false, status: 400 }));
  });
}

export async function parseWebhookBody(bytes, contentType, kind) {
  const text = bytes.toString('utf8');
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  try {
    const parsed = JSON.parse(text);
    if (kind === 'custom' && type !== 'application/json' && (parsed === null || typeof parsed !== 'object')) return text;
    return parsed;
  } catch { /* services sometimes omit their content type */ }
  try {
    let fields;
    if (type === 'application/x-www-form-urlencoded') fields = new URLSearchParams(text);
    else if (type === 'multipart/form-data') {
      fields = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
    }
    if (fields) {
      if (fields.has('payload')) {
        const payload = fields.getAll('payload');
        return payload.length === 1 && typeof payload[0] === 'string' ? JSON.parse(payload[0]) : null;
      }
      const body = Object.create(null);
      for (const [key, value] of fields) {
        if (typeof value !== 'string' || Object.hasOwn(body, key)) return null;
        body[key] = value;
      }
      return body;
    }
  } catch { return null; }
  return kind === 'custom' && type !== 'application/json' ? text : null;
}
