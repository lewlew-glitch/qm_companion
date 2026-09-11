import { board, shell } from '../chrome.js';

// Load the existing server-rendered form after the document and navigation are usable.
export function pairLoadingRuntime() {
  const root = document.getElementById('pair-content');
  const note = document.getElementById('pair-loading-note');
  const progress = document.getElementById('pair-loading-progress');
  const retry = document.getElementById('pair-loading-retry');
  const signin = document.getElementById('pair-loading-signin');
  const announcement = document.getElementById('pair-load-announcement');
  let active = null, deadline = null, slowHint = null, disposed = false, loaded = false;
  function clearTimers() {
    clearTimeout(deadline); clearTimeout(slowHint);
    deadline = slowHint = null;
  }
  function show(element, visible) {
    element.hidden = !visible;
    element.style.display = visible ? '' : 'none';
  }
  async function load() {
    if (active || disposed || loaded) return;
    const controller = new AbortController();
    active = controller;
    root.setAttribute('aria-busy', 'true');
    note.textContent = 'Finding services and checking their addresses. This can take a moment.';
    show(progress, true); show(retry, false); show(signin, false);
    slowHint = setTimeout(() => {
      if (active === controller && !disposed) {
        note.textContent = 'Still checking your services. You can leave this page and come back.';
      }
    }, 8000);
    deadline = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch('/pair/form', {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { accept: 'application/json' }, signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error('Setup unavailable'), { status: response.status });
      if (!(response.headers.get('content-type') || '').includes('text/html')) throw new Error('Unexpected setup response');
      const content = await response.text();
      if (disposed || active !== controller || controller.signal.aborted) throw new Error('Setup interrupted');
      const template = document.createElement('template');
      template.innerHTML = content;
      const form = template.content.querySelector('[data-pair-loaded]');
      if (!form || form.querySelector('script[src]')) throw new Error('Incomplete setup response');
      // Only this same-origin endpoint supplies the form and its existing inline controller.
      const scripts = Array.from(form.querySelectorAll('script'));
      const source = scripts.map((script) => script.textContent);
      scripts.forEach((script) => script.remove());
      const restoreFocus = root.contains(document.activeElement);
      root.replaceChildren(form);
      root.setAttribute('aria-busy', 'false');
      loaded = true;
      source.forEach((text) => {
        const script = document.createElement('script');
        script.textContent = text;
        root.appendChild(script);
      });
      announcement.textContent = 'Service check complete.';
      if (restoreFocus) {
        const heading = root.querySelector('h1');
        if (heading) { heading.tabIndex = -1; heading.focus(); }
      }
    } catch (error) {
      if (disposed || active !== controller) return;
      root.setAttribute('aria-busy', 'false');
      const expired = error.status === 401;
      note.textContent = expired ? 'Your session expired. Sign in again to continue.'
        : 'The service check could not finish. Try again when Companion is available.';
      announcement.textContent = note.textContent;
      show(progress, false); show(retry, !expired); show(signin, expired);
    } finally {
      if (active === controller) { clearTimers(); active = null; }
    }
  }
  retry.addEventListener('click', load);
  window.addEventListener('pagehide', () => {
    disposed = true;
    clearTimers();
    const previous = active;
    active = null;
    previous?.abort();
  });
  window.addEventListener('pageshow', () => { disposed = false; load(); });
  load();
}

export function pairLoadingPage(csrf) {
  return shell('pair', csrf, null, `
    <div id="pair-load-announcement" class="sr-only" role="status" aria-live="polite"></div>
    <div id="pair-content" aria-busy="true">
      ${board('pair', 'Set up the app', '')}
      <p class="sub">Review the addresses used by the phone. Detected API keys are included in the encrypted transfer. After setup, Quartermaster connects to each service directly.</p>
      <div class="pair-loading">
        <h2>Checking your services</h2>
        <p id="pair-loading-note">Finding services and checking their addresses. This can take a moment.</p>
        <div class="pair-loading-progress" id="pair-loading-progress" role="progressbar" aria-label="Checking services"><span></span></div>
        <button class="btn" id="pair-loading-retry" type="button" hidden style="display:none">Try again</button>
        <a class="btn" id="pair-loading-signin" href="/login" hidden style="display:none">Sign in again</a>
        <noscript><p><a href="/pair?full=1">Open setup without JavaScript</a></p></noscript>
      </div>
    </div>
    <script>(${pairLoadingRuntime.toString()})();</script>`);
}
