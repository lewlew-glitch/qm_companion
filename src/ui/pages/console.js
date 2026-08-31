import { escapeHtml } from '../../http.js';
import { config } from '../../config.js';
import { getPrefs } from '../../store.js';
import { I, ESC_FN, jsafe } from '../bits.js';
import { board, shell, noSocket } from '../chrome.js';

// Container logs and optional shell access in a shared view.
export function consolePage(containers, sel, control, csrf, shellAccess = false) {
  if (containers === null) return noSocket('console', 'term', 'Console', csrf);
  const meta = { host: config.qmHost || 'localhost', count: null };
  const seg = `<div class="seg" id="logmode"><button type="button" class="on" data-m="single">Single</button><button type="button" data-m="multi">Multi</button></div>`;
  const head = board('console', 'Console', `<span class="count-tag">${containers.length}</span>${seg}`, meta);
  if (!containers.length) {
    return shell('console', csrf, meta, `${head}
      <div class="empty">No containers yet, so nothing to tail.</div>`);
  }
  const picked = containers.find((c) => c.id === sel) || containers[0];
  const rows = containers.map((c) => {
    const dot = c.state === 'running' ? (c.health === 'unhealthy' ? 'bad' : c.health === 'starting' ? 'warn' : 'ok') : c.state === 'paused' ? 'warn' : '';
    return `<a class="logrow${c.id === picked.id ? ' on' : ''}" href="/console?id=${encodeURIComponent(c.id)}" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}" data-state="${escapeHtml(c.state)}" data-protected="${c.protected ? '1' : ''}" data-find="${escapeHtml(`${c.name} ${c.image}`.toLowerCase())}"><span class="tick"></span><span class="sdot ${dot}"></span><span class="lr-txt"><span class="lr-name">${escapeHtml(c.name)}</span><span class="lr-img">${escapeHtml(c.image)}</span></span></a>`;
  }).join('');

  // Show the shell only for eligible containers.
  const canShell = shellAccess && containers.some((c) => !c.protected);
  const selectedProtected = !!picked.protected;
  const shellChip = canShell ? `<button class="chipbtn off" id="shelltoggle" type="button"${selectedProtected ? ' hidden' : ''}>${I.term}Shell</button>` : '';
  const shellPane = canShell ? `<div class="shellpane" id="shellpane" hidden>
          <div class="shellhead"><span class="sh-note">Running as root. Each command runs on its own, so <code>cd</code> does not carry over.</span></div>
          <pre class="term" id="termout">Pick a running container, then run commands inside it.</pre>
          <form class="termbar" id="termform" autocomplete="off">
            <span class="prompt" id="termprompt">$</span>
            <input id="termin" type="text" placeholder="ls -la /config" autocomplete="off" spellcheck="false">
            <button class="chipbtn" type="submit">${I.play}Run</button>
          </form>
        </div>` : '';

  return shell('console', csrf, meta, `
    ${head}
    <div class="loglayout" id="loglay">
      <div class="logside">
        <div class="tbar-search">${I.search}<input id="cfilter" type="text" placeholder="Filter containers…" autocomplete="off" spellcheck="false"></div>
        <div class="logrows" id="logrows">${rows}</div>
        <div class="lr-count">${containers.length} container${containers.length === 1 ? '' : 's'}</div>
      </div>
      <div class="console logconsole" id="logconsole">
        <div class="console-bar">
          <span class="live" id="loglive"><span class="hdot"></span>Live</span>
          <span class="cname" id="cname"></span><span class="dim" id="cstate" hidden></span>
          <span class="grow"></span>
          <span class="logstatus" id="logstatus"></span>
          <span class="matchcount" id="logmatch" hidden></span>
          <div class="logsearch">${I.search}<input id="logsearch" type="text" placeholder="Filter lines…" autocomplete="off" spellcheck="false"></div>
          <button class="chipbtn" id="loglevels" type="button">${I.list}Levels</button>
          <button class="chipbtn off" id="logtimes" type="button">${I.clock}Times</button>
          ${shellChip}
          <button class="chipbtn" id="logfollow" type="button">${I.pause}Auto-scroll</button>
          <select id="logtail">${['200', '500', '1000', '2000'].map((n) => `<option value="${n}" ${getPrefs().logTail === n ? 'selected' : ''}>Last ${n}</option>`).join('')}</select>
        </div>
        <pre class="logs" id="logpane">Loading…</pre>${shellPane}
      </div>
    </div>

    <script>
      (function () {
        var lay = document.getElementById('loglay'), pane = document.getElementById('logpane');
        var cons = document.getElementById('logconsole');
        var search = document.getElementById('logsearch'), tail = document.getElementById('logtail');
        var follow = document.getElementById('logfollow'), status = document.getElementById('logstatus');
        var live = document.getElementById('loglive'), match = document.getElementById('logmatch');
        var levelsBtn = document.getElementById('loglevels'), timesBtn = document.getElementById('logtimes');
        var cname = document.getElementById('cname'), cfilter = document.getElementById('cfilter');
        var seg = document.getElementById('logmode');
        var rows = Array.prototype.slice.call(document.querySelectorAll('#logrows .logrow'));
        var mode = 'single', sel = ${jsafe(picked.id)}, following = true, seq = 0;
        var levels = true, times = false;
        var picks = [], slots = {}, single = '', merged = [];
        // Optional shell controls.
        var shellToggle = document.getElementById('shelltoggle'), shellPane = document.getElementById('shellpane');
        var termout = document.getElementById('termout'), termform = document.getElementById('termform');
        var termin = document.getElementById('termin'), termprompt = document.getElementById('termprompt');
        var split = false, hist = [], hi = -1;
        var cstate = document.getElementById('cstate');
        // Current shell and log states.
        var shellLocked = false, failed = false;
        function byId(id) { for (var i = 0; i < rows.length; i++) if (rows[i].dataset.id === id) return rows[i]; return null; }
        function nameOf(id) { var r = byId(id); return r ? r.dataset.name : id.slice(0, 12); }
        function stateOf(id) { var r = byId(id); return r ? r.dataset.state : ''; }
        function runningNow(id) { return stateOf(id) === 'running'; }
        function protectedNow(id) { var r = byId(id); return !!r && r.dataset.protected === '1'; }
        ${ESC_FN}
        function pad(s, w) { while (s.length < w) s += ' '; return s; }
        // Normalize timestamp precision.
        function tkey(t) { var m = t.match(/^([^.]+)\\.(\\d+)Z?$/); return m ? m[1] + '.' + (m[2] + '000000000').slice(0, 9) : t; }
        // Highlight levels in escaped log text.
        function tint(s) {
          if (!levels) return s;
          return s.replace(/\\b(ERROR|FATAL|WARN|INFO|DEBUG|TRACE)\\b/gi, function (m) {
            var u = m.toUpperCase();
            var c = u === 'ERROR' || u === 'FATAL' ? 'lvl-err' : u === 'WARN' ? 'lvl-warn' : u === 'INFO' ? 'lvl-info' : 'lvl-dbg';
            return '<span class="' + c + '">' + m + '</span>';
          });
        }
        function paintNames() {
          cname.textContent = mode === 'single' ? nameOf(sel) : (picks.map(nameOf).join(' \\u00b7 ') || 'nothing ticked');
          // Show non-running state.
          var st = mode === 'single' ? stateOf(sel) : '';
          cstate.textContent = st && st !== 'running' ? st : '';
          cstate.hidden = !cstate.textContent;
        }
        // Update the live indicator.
        function liveMark(on) { live.classList.toggle('off', !on || !following); }
        function showMatch(shown, filtered) {
          if (!filtered) { match.hidden = true; return; }
          match.hidden = false;
          match.textContent = shown + (shown === 1 ? ' match' : ' matches');
        }
        function render() {
          if (failed) return;
          var q = search.value.toLowerCase(), shown = 0;
          if (mode === 'single') {
            var lines = single ? single.split('\\n') : [];
            var out = [];
            lines.forEach(function (l) {
              if (q && l.toLowerCase().indexOf(q) < 0) return;
              shown++;
              out.push(tint(esc(l)));
            });
            // Distinguish empty logs from a failed read.
            if (!lines.length && !q) pane.textContent = nameOf(sel) + ' has not written any log lines Docker kept. New lines appear here as they arrive.';
            else pane.innerHTML = out.join('\\n');
          } else {
            var w = 0;
            picks.forEach(function (id) { w = Math.max(w, nameOf(id).length); });
            var out = [];
            merged.forEach(function (e) {
              if (q && (e.name + ' ' + e.text).toLowerCase().indexOf(q) < 0) return;
              shown++;
              out.push('<span class="lp lc' + e.slot + '">' + esc(pad(e.name, w)) + '</span>  ' + tint(esc(e.text)));
            });
            pane.innerHTML = out.join('\\n');
          }
          showMatch(shown, !!q);
          if (following) pane.scrollTop = pane.scrollHeight;
        }
        // Log responses require a text field; all other shapes enter the visible failure state.
        function logFailure(said, subject) {
          failed = true;
          match.hidden = true;
          liveMark(false);
          status.textContent = 'no logs';
          pane.textContent = 'Docker did not return logs for ' + (subject || nameOf(sel)) + '.'
            + (said ? '\\n' + said : '')
            + '\\nOpen Containers to check it still exists. If no Docker page loads, set CONTAINERS: 1 on qm-socket-proxy, then rerun the Compose command for this stack, keeping every -f it already has.';
        }
        function stamp(fails) {
          status.textContent = fails && fails.length ? 'no reply from ' + fails.join(', ') : 'updated ' + new Date().toLocaleTimeString();
        }
        function load() {
          var my = ++seq;
          if (mode === 'single') {
            status.textContent = 'refreshing…';
            fetch('/api/logs?id=' + encodeURIComponent(sel) + '&tail=' + tail.value + (times ? '&ts=1' : ''))
              .then(function (r) {
                return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok, d: d || {} }; });
              })
              .then(function (res) {
                if (my !== seq) return;
                if (!res.ok || typeof res.d.text !== 'string') { logFailure(res.d.error ? String(res.d.error) : ''); return; }
                failed = false;
                single = res.d.text;
                liveMark(true);
                render();
                stamp();
              })
              .catch(function () { if (my === seq) logFailure('Companion did not answer, so nothing here is newer than the last update.'); });
            return;
          }
          if (!picks.length) { pane.textContent = 'Tick containers on the left to merge their logs.'; status.textContent = ''; match.hidden = true; return; }
          status.textContent = 'refreshing…';
          Promise.all(picks.map(function (id) {
            return fetch('/api/logs?id=' + encodeURIComponent(id) + '&tail=' + tail.value + '&ts=1')
              .then(function (r) { return r.json(); })
              .then(function (d) { return { id: id, text: d.text }; })
              .catch(function () { return { id: id, text: null }; });
          })).then(function (res) {
            if (my !== seq) return;
            var entries = [], fails = [], n = 0;
            res.forEach(function (r) {
              if (r.text === null || r.text === undefined) { fails.push(nameOf(r.id)); return; }
              var name = nameOf(r.id), slot = slots[r.id], last = '';
              r.text.split('\\n').forEach(function (line) {
                if (!line) return;
                var m = line.match(/^(\\d{4}-\\d{2}-\\d{2}T\\S+)\\s?(.*)$/);
                if (m) last = tkey(m[1]);
                entries.push({ t: m ? tkey(m[1]) : last, text: m ? m[2] : line, name: name, slot: slot, i: n++ });
              });
            });
            entries.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : a.i - b.i; });
            merged = entries;
            if (fails.length && fails.length === res.length) { logFailure('', 'the ticked containers'); return; }
            failed = false;
            liveMark(true);
            render();
            stamp(fails);
          });
        }
        // Shell controls.
        function twrite(t) { if (termout) { termout.textContent += '\\n' + t; termout.scrollTop = termout.scrollHeight; } }
        // Recheck shell eligibility before each command.
        function canRun() { return !shellLocked && runningNow(sel) && !protectedNow(sel); }
        function syncShell() {
          if (!shellPane) return;
          if (protectedNow(sel)) { setSplit(false); return; }
          var running = runningNow(sel);
          termprompt.textContent = nameOf(sel) + ' $';
          termin.disabled = !canRun();
          termin.placeholder = shellLocked ? 'shell access is off' : running ? 'ls -la /config' : 'this container is not running';
          if (termout.dataset.forId !== sel) {
            termout.dataset.forId = sel;
            termout.textContent = running
              ? "Using " + nameOf(sel) + "'s configured user and privileges. Type a command below and press Enter."
              : nameOf(sel) + ' is ' + (stateOf(sel) || 'not running') + ', so there is nothing to exec into.';
          }
        }
        function setSplit(on) {
          if (!shellPane) return;
          if (on && protectedNow(sel)) on = false;
          split = on;
          cons.classList.toggle('split', on);
          shellPane.hidden = !on;
          shellToggle.classList.toggle('off', !on);
          if (on) { syncShell(); if (!termin.disabled) setTimeout(function () { termin.focus(); }, 0); }
          if (following) pane.scrollTop = pane.scrollHeight;
        }
        function syncShellAvailability() {
          if (!shellToggle) return;
          var unavailable = mode === 'multi' || protectedNow(sel);
          if (unavailable && split) setSplit(false);
          shellToggle.hidden = unavailable;
        }
        if (termform) {
          termform.addEventListener('submit', function (e) {
            e.preventDefault();
            var cmd = termin.value.trim();
            if (!cmd || !canRun()) return;
            hist.push(cmd); hi = hist.length; termin.value = '';
            twrite('$ ' + cmd);
            termin.disabled = true;
            fetch('/api/exec', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-csrf-token': document.querySelector('meta[name=csrf]').content },
              body: JSON.stringify({ id: sel, cmd: cmd }),
            }).then(function (r) {
              return r.json().catch(function () { return null; }).then(function (d) { return { status: r.status, ok: r.ok, d: d || {} }; });
            }).then(function (res) {
              // Show server refusals in the terminal output.
              if (res.ok) {
                if (res.d.output) twrite(res.d.output.replace(/\\n$/, ''));
                else if (!res.d.code) twrite('[no output]');
                if (res.d.code) twrite('[exit ' + res.d.code + ']');
                return;
              }
              twrite('[' + (res.d.error ? String(res.d.error) : 'the server refused this command (' + res.status + ')') + ']');
              if (res.status === 403 && /shell/i.test(String(res.d.error || ''))) {
                shellLocked = true;
                twrite('Choose Management + shell under Docker access in the sidebar. If it is unavailable, recreate with docker compose -f docker-compose.example.yml -f docker-compose.shell.yml up -d, keeping every other -f file this install already starts with, in the same order.');
              } else if (res.status === 401) {
                twrite('Session expired. Reload the page and sign in again.');
              }
            }).catch(function () { twrite('[Companion did not answer. The command was not run.]'); })
              .then(function () { termin.disabled = !canRun(); if (!termin.disabled) termin.focus(); });
          });
          termin.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowUp' && hi > 0) { hi--; termin.value = hist[hi]; e.preventDefault(); }
            else if (e.key === 'ArrowDown') { if (hi < hist.length - 1) { hi++; termin.value = hist[hi]; } else { hi = hist.length; termin.value = ''; } e.preventDefault(); }
          });
          shellToggle.addEventListener('click', function () { if (mode === 'single') setSplit(!split); });
          // Open direct shell links in split view.
          if (/[?&]shell=1/.test(location.search) && mode === 'single' && !protectedNow(sel)) {
            setSplit(true);
            setTimeout(function () {
              if (shellPane) shellPane.scrollIntoView({ block: 'center' });
              if (termin && !termin.disabled) termin.focus();
            }, 50);
          }
        }
        // Event handlers.
        document.getElementById('logrows').addEventListener('click', function (e) {
          var row = e.target.closest('.logrow');
          if (!row) return;
          e.preventDefault();
          if (mode === 'single') {
            if (row.dataset.id === sel) return;
            sel = row.dataset.id;
            rows.forEach(function (r) { r.classList.toggle('on', r === row); });
            try { history.replaceState(null, '', '/console?id=' + encodeURIComponent(sel)); } catch (err) {}
            single = ''; pane.textContent = 'Loading…';
            paintNames(); syncShellAvailability(); if (split) syncShell(); load();
            return;
          }
          var id = row.dataset.id, at = picks.indexOf(id);
          if (at >= 0) {
            picks.splice(at, 1);
            row.classList.remove('picked', 'lc' + slots[id]);
            delete slots[id];
          } else {
            if (picks.length >= 6) { status.textContent = 'up to 6 at a time'; return; }
            var s = 0;
            while (picks.some(function (p) { return slots[p] === s; })) s++;
            slots[id] = s; picks.push(id);
            row.classList.add('picked', 'lc' + s);
          }
          merged = []; pane.textContent = 'Loading…';
          paintNames(); load();
        });
        seg.addEventListener('click', function (e) {
          var b = e.target.closest('button');
          if (!b || b.dataset.m === mode) return;
          mode = b.dataset.m;
          seg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
          lay.classList.toggle('multi', mode === 'multi');
          // Shell access requires a single selected container.
          syncShellAvailability();
          if (mode === 'multi' && !picks.length) {
            var row = byId(sel);
            if (row) { slots[sel] = 0; picks.push(sel); row.classList.add('picked', 'lc0'); }
          }
          pane.textContent = 'Loading…';
          paintNames(); load();
        });
        cfilter.addEventListener('input', function () {
          var t = cfilter.value.toLowerCase();
          rows.forEach(function (r) { r.style.display = !t || r.dataset.find.indexOf(t) >= 0 ? '' : 'none'; });
        });
        follow.addEventListener('click', function () {
          following = !following;
          follow.classList.toggle('off', !following);
          liveMark(!failed);
          if (following) { pane.scrollTop = pane.scrollHeight; load(); }
        });
        levelsBtn.addEventListener('click', function () {
          levels = !levels;
          levelsBtn.classList.toggle('off', !levels);
          render();
        });
        timesBtn.addEventListener('click', function () {
          times = !times;
          timesBtn.classList.toggle('off', !times);
          if (mode === 'single') { single = ''; pane.textContent = 'Loading…'; load(); }
        });
        search.addEventListener('input', render);
        tail.addEventListener('change', load);
        // Keep the selected container visible in the sidebar.
        var start = byId(sel);
        if (start) start.scrollIntoView({ block: 'nearest' });
        // Refresh row state from Docker events after the initial page snapshot.
        var STATE_FOR = { die: 'exited', stop: 'exited', kill: 'exited', destroy: 'gone', start: 'running', restart: 'running', unpause: 'running', pause: 'paused' };
        function byName(n) { for (var i = 0; i < rows.length; i++) if (rows[i].dataset.name === n) return rows[i]; return null; }
        function dotFor(st) { return st === 'running' ? 'ok' : st === 'paused' ? 'warn' : ''; }
        function setRowState(row, next, code) {
          if (!row || row.dataset.state === next) return;
          row.dataset.state = next;
          var d = row.querySelector('.sdot');
          if (d) d.className = 'sdot ' + dotFor(next);
          if (row.dataset.id !== sel) return;
          paintNames();
          syncShell();
          twrite('[' + row.dataset.name + ' is now ' + next + (code ? ', exit code ' + code : '') + ']');
          if (next !== 'running') twrite('[nothing can run in a container that is not running. Start it from Containers, then carry on here.]');
        }
        function applyEvents(list) {
          if (!Array.isArray(list)) return;
          // Apply events oldest first so the latest state wins.
          for (var i = list.length - 1; i >= 0; i--) {
            var e = list[i] || {};
            if (e.type && e.type !== 'container') continue;
            var next = STATE_FOR[String(e.action || '').split(':')[0]];
            if (next && e.name) setRowState(byName(e.name), next, e.exitCode);
          }
        }
        paintNames(); syncShellAvailability(); load();
        setInterval(function () { if (following) load(); }, 3000);
        if (window.qmLive) window.qmLive({ topics: ['events'], onmessage: function (t, d) { applyEvents(d); } });
      })();
    </script>`);
}
