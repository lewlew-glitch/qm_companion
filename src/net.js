const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Fetch bounded text with one deadline for headers and body; redirects default to errors. */
export async function fetchTextBounded(
  url,
  init = {},
  { timeoutMs = 4000, maxBytes = DEFAULT_MAX_BYTES, fetchImpl = globalThis.fetch, redirect = 'error' } = {},
) {
  const controller = new AbortController();
  let reader;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(Object.assign(new Error('request timed out'), { name: 'AbortError' }));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Handle deadline rejection before invoking an injectable fetch implementation.
    const fetchPromise = Promise.resolve().then(() => fetchImpl(url, {
      ...init,
      redirect,
      signal: controller.signal,
    }));
    const response = await Promise.race([fetchPromise, aborted]);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error('response too large');
    }
    if (!response.body) return { response, text: '' };
    if (typeof response.body.getReader !== 'function') {
      throw new Error('response body is not safely streamable');
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('response too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { response, text };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    if (reader) await reader.cancel().catch(() => {});
  }
}
