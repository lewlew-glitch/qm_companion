import { escapeHtml } from '../../http.js';
import { I, ESC_FN, searchTools, EVENT_ICON, jsafe, metaOf, fmtWhen } from '../bits.js';
import { board, shell, noSocket, proxyBlocked } from '../chrome.js';
import { gridHeader, gridOpen, gridClose } from '../columns.js';

const EVENT_TONE = { start: 'ok', create: 'ok', unpause: 'ok', die: 'bad', kill: 'warn', stop: 'warn', restart: 'warn', pause: 'warn' };

// Render credential-free Companion audit entries before Docker events.
function companionActivity(audit) {
  const rows = (audit || []).slice(0, 200).map((row) => `
    <div class="tr t-audit">
      <div class="dim">${escapeHtml(fmtWhen(row.at))}</div>
      <div>${I.link}${escapeHtml(row.line)}</div>
    </div>`).join('');
  return `
    <div class="sec-h">Companion activity</div>
    <div class="tscroll"><div class="table audittable">
      ${rows || '<div class="empty">No Companion activity yet. Minting a key, reading one from a container or creating a transfer is recorded here.</div>'}
    </div></div>`;
}

export function activityPage(events, csrf, range, audit = []) {
  if (events === null) return noSocket('activity', 'pulse', 'Activity', csrf);
  if (events === 'blocked') return proxyBlocked('activity', 'pulse', 'Activity', 'EVENTS', csrf);
  const fmt = (t) => (t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(5, 19) : '');
  const t = searchTools('Search events…');
  const actions = [...new Set(events.map((e) => (e.action || '').split(':')[0]))].sort();
  const rows = events.slice().sort((a, b) => (b.time || 0) - (a.time || 0)).map((e) => {
    const raw = e.action || '';
    const base = raw.split(':')[0];
    const tone = EVENT_TONE[base] || '';
    const [ico] = EVENT_ICON[base] || ['pulse'];
    const open = e.type === 'container' && e.name
      ? `<a class="actbtn" href="/containers?sel=${encodeURIComponent(e.name)}" title="Open container" aria-label="Open ${escapeHtml(e.name)} on the containers page">${I.box}</a>`
      : '';
    return `<div class="tr t-act" data-key="${escapeHtml(`${e.time || 0}|${raw}|${e.name || ''}`)}" data-find="${escapeHtml(((e.name || '') + ' ' + raw + ' ' + (e.image || '') + ' ' + (e.type || '')).toLowerCase())}" data-action="${escapeHtml(base)}" data-ts="${Number(e.time) || 0}" data-cname="${escapeHtml(e.name || '')}">
      <div class="dim" data-col="when">${escapeHtml(fmt(e.time))}</div>
      <div data-col="action"><span class="ev-act ${tone}" title="${escapeHtml(raw)}">${I[ico]}${escapeHtml(base)}</span></div>
      <div class="svc" data-col="container">${escapeHtml(e.name || '')}</div>
      <div class="addr mono" data-col="image">${escapeHtml(e.image || '')}</div>
      <div class="num ${e.exitCode && e.exitCode !== '0' ? '' : 'dim'}" data-col="exit" style="${e.exitCode && e.exitCode !== '0' ? 'color:var(--bad)' : ''}">${escapeHtml(e.exitCode || 'Not available')}</div>
      <div class="acts" data-col="link">${open}</div>
    </div>`;
  }).join('');
  const ranges = [['1', 'Last hour'], ['6', '6 hours'], ['24', '24 hours'], ['72', '3 days']];
  // Render an explicit empty state when Docker returns no events.
  const WINDOW = { 1: 'the last hour', 6: 'the last 6 hours', 24: 'the last 24 hours', 72: 'the last 3 days' };
  const windowText = WINDOW[String(range)] || 'this window';
  const noEvents = `<div class="empty">No Docker events in ${windowText}. Choose a longer range or use Follow for new events.</div>`;
  const eicon = {};
  for (const [k, [ico, cls]] of Object.entries(EVENT_ICON)) eicon[k] = [I[ico], cls];
  return shell('activity', csrf, metaOf(), `
    ${board('activity', 'Activity', `<span class="count-tag" id="tcount">${events.length}</span>${t.input}
      <select id="afilter" class="tbar-sel"><option value="">All actions</option>${actions.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('')}</select>
      <select id="arange" class="tbar-sel">${ranges.map(([v, l]) => `<option value="${v}" ${String(range) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn" id="follow" type="button" aria-pressed="false"><span class="followdot"></span>Follow</button>
      <span data-grid-gear></span>`, metaOf())}
    <div class="err hidden" id="followlost" role="status">Live updates stopped. Reload the page or press Follow to retry.</div>
    ${companionActivity(audit)}
    <div class="sec-h">Docker events</div>
    ${gridOpen('activity', { id: 'acttable', tableClass: 'acttable' })}
      ${gridHeader('activity', { rowClass: 't-act' })}
      ${rows}
    ${gridClose()}${events.length ? '' : noEvents}${t.script}
    <script>
      (function () {
        ${ESC_FN}
        var f = document.getElementById('afilter'), r = document.getElementById('arange');
        var count = document.getElementById('tcount'), empty = document.getElementById('tempty');
        var q = document.getElementById('tsearch');
        function apply() {
          var want = f.value, term = (q.value || '').toLowerCase(), n = 0;
          document.querySelectorAll('.t-act:not(.th)').forEach(function (row) {
            var ok = (!want || row.dataset.action === want) && (!term || row.dataset.find.indexOf(term) >= 0);
            row.style.display = ok ? '' : 'none'; if (ok) n++;
          });
          count.textContent = n; if (empty) empty.classList.toggle('hidden', n > 0);
        }
        f.addEventListener('change', apply);
        r.addEventListener('change', function () { location.href = '/activity?range=' + r.value; });

        var EICON = ${jsafe(eicon)}, EDEF = ${jsafe([I.pulse, 'ec'])};
        var TONE = ${jsafe(EVENT_TONE)};
        var follow = document.getElementById('follow'), table = document.getElementById('acttable');
        var live = null;
        var seen = {};
        document.querySelectorAll('.t-act[data-key]').forEach(function (row) { seen[row.dataset.key] = 1; });
        function fmtTs(t) {
          return t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(5, 19) : '';
        }
        function rowHtml(e) {
          var raw = String(e.action || ''), base = raw.split(':')[0];
          var pair = EICON[base] || EDEF;
          var tone = TONE[base] || '';
          var exit = e.exitCode && e.exitCode !== '0';
          var open = e.type === 'container' && e.name
            ? '<a class="actbtn" href="/containers?sel=' + encodeURIComponent(e.name) + '" title="Open container">' + ${jsafe(I.box)} + '</a>'
            : '';
          return '<div class="dim" data-col="when">' + esc(fmtTs(e.time)) + '</div>'
            + '<div data-col="action"><span class="ev-act ' + tone + '" title="' + esc(raw) + '">' + pair[0] + esc(base) + '</span></div>'
            + '<div class="svc" data-col="container">' + esc(e.name || '') + '</div>'
            + '<div class="addr mono" data-col="image">' + esc(e.image || '') + '</div>'
            + '<div class="num ' + (exit ? '' : 'dim') + '" data-col="exit"' + (exit ? ' style="color:var(--bad)"' : '') + '>' + esc(e.exitCode || 'Not available') + '</div>'
            + '<div class="acts" data-col="link">' + open + '</div>';
        }
        function prepend(list) {
          if (!Array.isArray(list)) return;
          var head = table.querySelector('.t-act.th');
          // Prepend in reverse iteration to preserve newest-first order.
          for (var i = list.length - 1; i >= 0; i--) {
            var e = list[i];
            var key = (e.time || 0) + '|' + (e.action || '') + '|' + (e.name || '');
            if (seen[key]) continue;
            seen[key] = 1;
            var row = document.createElement('div');
            row.className = 'tr t-act act-new';
            row.dataset.key = key;
            row.dataset.action = String(e.action || '').split(':')[0];
            row.dataset.ts = e.time || 0;
            row.dataset.cname = e.name || '';
            row.dataset.find = ((e.name || '') + ' ' + (e.action || '') + ' ' + (e.image || '') + ' ' + (e.type || '')).toLowerCase();
            row.innerHTML = rowHtml(e);
            head.after(row);
          }
          if (window.qmGrid) qmGrid.refresh(table);
          apply();
        }
        var lost = document.getElementById('followlost');
        function stopFollow() {
          if (live) { live.close(); live = null; }
          follow.setAttribute('aria-pressed', 'false');
          follow.classList.remove('on');
          lost.classList.add('hidden');
        }
        var lostLive = false;
        function paintLive() {
          if (!live) return;
          follow.classList.toggle('on', !lostLive);
          lost.classList.toggle('hidden', !lostLive);
        }
        function liveUp() { lostLive = false; paintLive(); }
        function liveDown() { lostLive = true; paintLive(); }
        follow.addEventListener('click', function () {
          if (live) { stopFollow(); return; }
          if (!window.qmLive) { lost.classList.remove('hidden'); return; }
          follow.setAttribute('aria-pressed', 'true');
          lostLive = false;
          live = window.qmLive({
            topics: ['events'],
            fallbackMs: 15000,
            fallbackPoll: liveDown,
            onmessage: function (topic, data) { liveUp(); prepend(data); },
          });
          paintLive();
        });
      })();
    </script>`);
}
