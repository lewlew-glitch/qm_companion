import { escapeHtml } from '../../http.js';

// Shared liveness strip for setup pages.

export const LIVE_CHECK_LOADED = 'Checked when this page loaded.';

// A 401 adds the sign-in action; other failures show retry only.
export function liveCheckMarkup(id, loaded = LIVE_CHECK_LOADED) {
  return `<div class="pair-live" id="${escapeHtml(id)}">
      <div class="err" data-live-banner hidden role="alert"><span data-live-msg></span>
        <a class="btn" href="/login" target="_blank" rel="noopener" data-live-signin hidden style="display:none">Sign in again</a>
        <button class="btn" type="button" data-live-retry hidden style="display:none">Check now</button>
      </div>
      <small class="cc-hint" data-live-stamp>${escapeHtml(loaded)}</small>
    </div>`;
}

// Client-side liveness state.
export const LIVE_CHECK_SCRIPT = `
        function qmLiveCheck(rootId, copy) {
          var root = document.getElementById(rootId);
          function part(name) { return root ? root.querySelector('[data-live-' + name + ']') : null; }
          var banner = part('banner'), msg = part('msg'), stamp = part('stamp');
          var signin = part('signin'), retry = part('retry');
          var misses = 0;
          // .btn carries its own display, which beats the [hidden] attribute, so both are toggled.
          function show(el, on) { if (!el) return; el.hidden = !on; el.style.display = on ? '' : 'none'; }
          return {
            ok: function () {
              misses = 0;
              if (banner) banner.hidden = true;
              if (stamp) stamp.textContent = 'Last successful check at ' + new Date().toTimeString().slice(0, 8) + '.';
            },
            fail: function (status) {
              misses += 1;
              if (misses < 2 || !banner) return;
              var expired = status === 401;
              if (msg) msg.textContent = expired ? copy.expired : copy.unreachable;
              show(signin, expired);
              show(retry, true);
              banner.hidden = false;
            },
            onRetry: function (fn) { if (retry) retry.addEventListener('click', fn); },
          };
        }
`;
