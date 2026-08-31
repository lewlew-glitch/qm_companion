import { escapeHtml } from '../../http.js';
import { I, tag, searchTools, fmtWhen, metaOf } from '../bits.js';
import { board, shell, noSocket, proxyBlocked } from '../chrome.js';
import { gridHeader, gridOpen, gridClose } from '../columns.js';

// An empty array is a successful Docker response. Do not render volume actions without rows.
function noVolumes(csrf) {
  return shell('volumes', csrf, metaOf(), `
    ${board('volumes', 'Volumes', '<span class="count-tag">0</span>', metaOf())}
    <div class="empty">Docker returned no volumes.
      <br><br>A named volume is created the first time a container that mounts it starts. Add it under
      <code class="mono">volumes:</code> in your compose file, then bring the stack up:
      <code class="mono">docker compose -f docker-compose.example.yml up -d</code>.
      <br>Repeat every <code class="mono">-f</code> file this install already starts with, in the same order.</div>`);
}

export function volumesPage(volumes, control, csrf, usedBy = {}) {
  if (volumes === null) return noSocket('volumes', 'disk', 'Volumes', csrf);
  if (volumes === 'blocked') return proxyBlocked('volumes', 'disk', 'Volumes', 'VOLUMES', csrf);
  if (!volumes.length) return noVolumes(csrf);
  const t = searchTools('Search volumes…');
  const rows = volumes.map((v) => {
    const users = usedBy[v.name] || [];
    // Allow removal only with Docker control and no attached containers.
    const rm = control && users.length === 0
      ? `<div class="acts"><button type="button" class="actbtn halt vol-rm" data-name="${escapeHtml(v.name)}" title="Remove volume" aria-label="Remove volume">${I.trash}</button></div>`
      : '';
    return `<div class="tr t-vol" data-name="${escapeHtml(v.name)}" data-driver="${escapeHtml(v.driver)}" data-created="${Number(v.created) || 0}" data-find="${escapeHtml((v.name + ' ' + (v.stack || '') + ' ' + users.join(' ')).toLowerCase())}">
      <div class="svc mono" style="font-size:12px" title="${escapeHtml(v.name)}" data-col="name">${escapeHtml(v.name)}</div>
      <div data-col="driver">${tag('line', v.driver)}</div>
      <div data-col="stack">${v.stack ? `<a class="badge line stacklink" href="/stacks#${encodeURIComponent(v.stack)}">${escapeHtml(v.stack)}</a>` : '<span class="faint">None</span>'}</div>
      <div class="num" data-col="usedby">${users.length ? `<span class="who" title="${escapeHtml(users.join(', '))}">${users.length}</span>` : '<span class="faint">Unused</span>'}</div>
      <div class="num vsize" data-col="size" data-vol="${escapeHtml(v.name)}">Measuring…</div>
      <div class="addr mono dim" data-col="mount" title="${escapeHtml(v.mountpoint || '')}">${escapeHtml(v.mountpoint || '')}</div>
      <div class="num dim" data-col="created">${escapeHtml(fmtWhen(v.created))}</div>
      <div data-col="actions">${rm}</div>
    </div>`;
  }).join('');
  return shell('volumes', csrf, metaOf(), `
    ${board('volumes', 'Volumes', `<span class="count-tag" id="tcount">${volumes.length}</span>${t.input}
      ${control ? `<button class="btn" id="volprune" type="button">Prune</button>` : ''}
      <a class="btn" href="/volumes">${I.rotate}Refresh</a>
      <span data-grid-gear></span>`, metaOf())}
    ${control ? '' : '<p class="sub">Read only. Choose Management from Docker access in the navigation to remove and prune.</p>'}
    ${gridOpen('volumes', { tableClass: 'voltable' })}
      ${gridHeader('volumes', { rowClass: 't-vol' })}
      ${rows}
    ${gridClose()}
    <div class="empty hidden" id="tempty">Nothing matches that filter.</div>
    <script>
      (function () {
        // Distinguish a filter miss from a list emptied by actions.
        var q = document.getElementById('tsearch'), count = document.getElementById('tcount');
        var empty = document.getElementById('tempty');
        function apply() {
          var term = (q && q.value || '').toLowerCase(), shown = 0, total = 0;
          document.querySelectorAll('.t-vol:not(.th)').forEach(function (r) {
            var ok = !term || r.dataset.find.indexOf(term) >= 0;
            r.style.display = ok ? '' : 'none';
            if (ok) shown++;
            total++;
          });
          if (count) count.textContent = shown;
          empty.textContent = term
            ? 'Nothing matches that filter.'
            : 'No volumes left on this page. Reload to check that against Docker.';
          empty.classList.toggle('hidden', shown > 0);
          // Hide Prune when the page has no rows.
          var prune = document.getElementById('volprune');
          if (prune) prune.classList.toggle('hidden', total === 0);
        }
        if (q) q.addEventListener('input', apply);
        // Initialize the empty state after listeners are attached.
        apply();
        function fmt(n){ if(!n) return '0 B'; var u=['B','KB','MB','GB','TB'],i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return (n<10&&i>0?n.toFixed(1):Math.round(n))+' '+u[i]; }
        // Fetch sizes once per page load and mark unavailable results explicitly.
        fetch('/api/docker/df').then(function (r) { if (!r.ok) throw new Error('df'); return r.json(); }).then(function (d) {
          var vols = d.volumes || {};
          document.querySelectorAll('.vsize').forEach(function (el) {
            var v = vols[el.dataset.vol];
            el.textContent = !v ? 'Unknown' : v.size < 0 ? 'Not measured' : fmt(v.size);
          });
        }).catch(function () {
          document.querySelectorAll('.vsize').forEach(function (el) { el.textContent = 'Unavailable'; });
        });
        ${control ? `var csrf = document.querySelector('meta[name=csrf]').content;
        function post(path, body) {
          return fetch(path, { method: 'POST', headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
            .then(function (r) { return r.json(); });
        }
        document.getElementById('volprune').addEventListener('click', function () {
          qmConfirm({
            title: 'Prune unused volumes', danger: true, confirmLabel: 'Prune',
            what: 'Remove every volume no container references?',
            detail: ['Their data will be permanently deleted. Volumes referenced by stopped containers are kept.'],
          }).then(function (yes) {
            if (!yes) return;
            var t = qmToast('Prune unused volumes');
            t.ops.set('p', { state: 'active', label: 'Removing unused volumes', note: 'working' });
            post('/volumes/prune', {}).then(function (d) {
              t.ops.set('p', { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'done' : 'failed') });
              if (d.ok) t.reloadOnClose();
            }).catch(function () { t.ops.set('p', { state: 'fail', note: 'could not reach the server' }); });
          });
        });
        document.querySelectorAll('.vol-rm').forEach(function (b) {
          b.addEventListener('click', function () {
            var name = b.dataset.name;
            qmConfirm({
              title: 'Remove volume', danger: true, confirmLabel: 'Remove',
              what: 'Delete this volume and everything in it?',
              detail: [{ c: name }, ' and its data will be permanently deleted. Docker refuses while a container still references it.'],
            }).then(function (yes) {
              if (!yes) return;
              b.disabled = true;
              var t = qmToast('Remove ' + name);
              t.ops.set('r', { state: 'active', label: 'Removing ' + name, note: 'working' });
              post('/volumes/remove', { name: name }).then(function (d) {
                t.ops.set('r', { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'removed' : 'failed') });
                if (!d.ok) { b.disabled = false; return; }
                var row = b.closest('.t-vol');
                if (row) row.remove();
                // Recompute the count and empty state after removing a row.
                apply();
              }).catch(function () { b.disabled = false; t.ops.set('r', { state: 'fail', note: 'could not reach the server' }); });
            });
          });
        });` : ''}
      })();
    </script>`);
}
