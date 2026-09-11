import { I } from './bits.js';

export function companionUpdateNotice() {
  return `<a class="companion-update" id="companion-update" href="/settings?tab=about" hidden>
    ${I.rotate}<span><b>Update available</b><small id="companion-update-version"></small></span>${I.chev}
  </a>`;
}

export function companionUpdateRuntime() {
  return `<script>
  (function () {
    var notice = document.getElementById('companion-update');
    var version = document.getElementById('companion-update-version');
    var status = document.getElementById('companion-release-status');
    var lastAttempt = 0, busy = false;
    function paint(data) {
      var available = data.status === 'available' && typeof data.latestVersion === 'string';
      if (notice) notice.hidden = !available;
      if (version) version.textContent = available ? 'Companion v' + data.latestVersion : '';
      if (status) status.textContent = available ? 'Companion v' + data.latestVersion + ' is available.'
        : data.status === 'current' ? 'No newer stable release found.'
        : data.status === 'disabled' ? 'Automatic release checks are turned off.'
        : 'Could not check for updates. You can view releases below.';
    }
    function check() {
      if (document.hidden || busy || (lastAttempt && Date.now() - lastAttempt < 30 * 60 * 1000)) return;
      busy = true; lastAttempt = Date.now();
      fetch('/api/companion-release', { credentials: 'same-origin' }).then(function (response) {
        if (!response.ok) throw new Error('Release check unavailable');
        return response.json();
      }).then(paint).catch(function () { paint({ status: 'unknown' }); }).finally(function () { busy = false; });
    }
    document.addEventListener('visibilitychange', check);
    var timer = null;
    function resume() {
      if (timer === null) timer = setInterval(check, 30 * 60 * 1000);
      check();
    }
    resume();
    window.addEventListener('pageshow', resume);
    window.addEventListener('pagehide', function () {
      if (timer !== null) clearInterval(timer);
      timer = null;
    });
  })();
</script>`;
}
