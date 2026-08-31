// Credential-free HTTPS reachability probe that accepts self-signed certificates.

import { request } from 'node:https';

export async function httpsTextBounded(url, { timeoutMs = 3000, maxBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const req = request(url, {
      method: 'GET',
      rejectUnauthorized: false,
      headers: { accept: 'text/html, application/json;q=0.9, */*;q=0.5' },
    }, (response) => {
      // A redirect still confirms that the port answered.
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy();
          finish(null, { status: response.statusCode, server: response.headers.server || '', location: response.headers.location || '', text: Buffer.concat(chunks).toString('utf8') });
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, { status: response.statusCode, server: response.headers.server || '', location: response.headers.location || '', text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', (error) => finish(error));
    });
    const timer = setTimeout(() => { req.destroy(new Error('request timed out')); }, timeoutMs);
    req.on('error', (error) => finish(error));
    req.end();
  });
}
