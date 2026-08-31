import { escapeHtml } from '../../http.js';
import { I, ESC_FN, tag, jsafe, metaOf } from '../bits.js';
import { board, shell, noSocket, proxyBlocked } from '../chrome.js';
import { gridHeader, gridOpen, gridClose } from '../columns.js';

// An empty array is a valid Docker response; null is handled as a socket failure elsewhere.
function noNetworks(csrf) {
  return shell('networks', csrf, metaOf(), `
    ${board('networks', 'Networks', '<span class="count-tag">0</span>', metaOf())}
    <div class="empty">Docker returned no networks.
      <br><br>A normal daemon includes <code class="mono">bridge</code>, <code class="mono">host</code> and
      <code class="mono">none</code>. Run <code class="mono">docker network ls</code> on the server. If
      those networks appear, check the response from <code class="mono">qm-socket-proxy</code>.</div>`);
}

export function networksPage(networks, control, csrf) {
  if (networks === null) return noSocket('networks', 'net', 'Networks', csrf);
  if (networks === 'blocked') return proxyBlocked('networks', 'net', 'Networks', 'NETWORKS', csrf);
  if (!networks.length) return noNetworks(csrf);
  const builtin = (n) => ['bridge', 'host', 'none'].includes(n.name);
  const drivers = [...new Set(networks.map((n) => n.driver).filter(Boolean))].sort();
  const scopes = [...new Set(networks.map((n) => n.scope).filter(Boolean))].sort();
  // Names are always copyable; removal is shown only when available.
  const rowActs = (n) => {
    const copy = `<button class="actbtn net-cp" data-name="${escapeHtml(n.name)}" title="Copy name" aria-label="Copy name">${I.copy}</button>`;
    const canRemove = control && !builtin(n) && !(n.containers > 0);
    const rm = canRemove ? `<button class="actbtn halt net-rm" data-id="${escapeHtml(n.name)}" title="Remove network" aria-label="Remove network">${I.trash}</button>` : '';
    return `<div class="acts">${copy}${rm}</div>`;
  };
  // Show attachment details only for networks with attached containers.
  const rows = networks.map((n, i) => {
    const names = n.containerNames || [];
    const countCell = names.length
      ? `<button type="button" class="chevbtn netx" data-x="nx${i}" aria-expanded="false" aria-controls="nx${i}" title="Show attached containers" aria-label="Show attached containers">${I.chev}</button><span>${n.containers}</span>`
      : `<span>${n.containers}</span>`;
    const foldout = names.length
      ? `<div class="rowx x-nets" id="nx${i}" hidden><div class="xrow xh"><div>Attached containers</div></div>${names.map((name) => `<div class="xrow"><div class="mono">${escapeHtml(name)}</div></div>`).join('')}</div>`
      : '';
    return `<div class="tr t-net" data-find="${escapeHtml((n.name + ' ' + n.driver + ' ' + names.join(' ')).toLowerCase())}" data-name="${escapeHtml(n.name)}" data-driver="${escapeHtml(n.driver)}" data-scope="${escapeHtml(n.scope || '')}" data-attached="${Number(n.containers) || 0}">
      <div class="svc" data-col="name">${escapeHtml(n.name)} ${builtin(n) ? tag('line', 'built-in') : ''} ${n.internal ? tag('line', 'internal') : ''}</div>
      <div data-col="driver">${tag('line', n.driver)}</div>
      <div class="dim" data-col="scope">${escapeHtml(n.scope)}</div>
      <div class="mono dim" data-col="subnet">${escapeHtml(n.subnet || 'Not available')}</div>
      <div class="mono dim" data-col="gateway">${escapeHtml(n.gateway || 'Not available')}</div>
      <div class="num netcount" data-col="attached">${countCell}</div>
      <div data-col="actions">${rowActs(n)}</div>
    </div>${foldout}`;
  }).join('');
  return shell('networks', csrf, metaOf(), `
    ${board('networks', 'Networks', `<span class="count-tag" id="tcount">${networks.length}</span>
      <div class="tbar-search">${I.search}<input id="tsearch" type="text" placeholder="Search networks…" autocomplete="off" spellcheck="false"></div>
      <select id="nfilter" class="tbar-sel"><option value="">All drivers</option>${drivers.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('')}</select>
      <select id="sfilter" class="tbar-sel"><option value="">All scopes</option>${scopes.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}</select>
      ${control ? `<button class="btn" id="netprune">Prune</button>
      <button class="btn primary" id="netcreate">${I.plus}Create</button>` : ''}
      <a class="btn" href="/networks">${I.rotate}Refresh</a>
      <span data-grid-gear></span>
`, metaOf())}
    ${control ? '' : '<p class="sub">Read only. Choose Management from Docker access in the navigation to create, prune and remove.</p>'}
    ${gridOpen('networks', { tableClass: 'nettable' })}
      ${gridHeader('networks', { rowClass: 't-net' })}
      ${rows}
    ${gridClose()}
    <div class="empty hidden" id="tempty">Nothing matches that filter.</div>
    ${control ? `<div class="overlay" id="netov" hidden>
      <div class="modal sm" role="dialog" aria-modal="true" aria-label="Create a network">
        <div class="modal-h"><b>Create a network</b><button class="iconbtn" id="netx" aria-label="Close">${I.x}</button></div>
        <div class="modal-b">
          <label class="hint" for="netname">Name</label>
          <input class="in" id="netname" style="width:100%;margin:6px 0 12px" placeholder="my-network" autocomplete="off" spellcheck="false">
          <label class="hint" for="netdriver">Driver</label>
          <select class="tbar-sel" id="netdriver" style="width:100%;margin:6px 0 12px"><option value="bridge">bridge</option><option value="macvlan">macvlan</option></select>
          <label class="hint" for="netsubnet">Subnet (optional)</label>
          <input class="in" id="netsubnet" style="width:100%;margin-top:6px" placeholder="10.0.5.0/24" autocomplete="off" spellcheck="false">
          <p class="hint" style="margin:10px 0 0">macvlan also needs a parent interface configured on the host - creating one here is not enough on its own.</p>
          <div id="netmnote" style="margin-top:12px"></div>
        </div>
        <div class="modal-f"><button class="btn" id="netcancel">Cancel</button><button class="btn primary" id="netgo">Create</button></div>
      </div>
    </div>` : ''}
    <script>
      (function () {
        var q = document.getElementById('tsearch'), f = document.getElementById('nfilter'), sf = document.getElementById('sfilter');
        var count = document.getElementById('tcount'), empty = document.getElementById('tempty');
        function apply() {
          var term = (q.value || '').toLowerCase(), want = f.value, sc = sf.value, n = 0;
          document.querySelectorAll('.t-net:not(.th)').forEach(function (r) {
            var ok = (!term || r.dataset.find.indexOf(term) >= 0) && (!want || r.dataset.driver === want) && (!sc || r.dataset.scope === sc);
            r.style.display = ok ? '' : 'none';
            // Filter the attached detail row with its parent.
            var x = r.nextElementSibling;
            if (x && x.classList.contains('rowx')) x.style.display = ok ? '' : 'none';
            if (ok) n++;
          });
          count.textContent = n;
          // Distinguish an empty filtered result from an empty network list.
          var filtered = !!(term || want || sc);
          empty.textContent = filtered
            ? 'Nothing matches that filter.'
            : 'No networks left on this page. Reload to check that against Docker.';
          empty.classList.toggle('hidden', n > 0);
        }
        q.addEventListener('input', apply); f.addEventListener('change', apply); sf.addEventListener('change', apply);
        // Settle the initial empty state before the user interacts with the filters.
        apply();
        document.querySelectorAll('.netx').forEach(function (b) {
          b.addEventListener('click', function () {
            var x = document.getElementById(b.dataset.x);
            if (!x) return;
            x.hidden = !x.hidden;
            b.classList.toggle('open', !x.hidden);
            b.setAttribute('aria-expanded', x.hidden ? 'false' : 'true');
          });
        });

        // Use a textarea fallback when the secure-context clipboard API is unavailable.
        var TICK = ${jsafe(I.check)}, COPY = ${jsafe(I.copy)};
        function copyText(t) {
          if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
          return new Promise(function (res, rej) {
            var a = document.createElement('textarea');
            a.value = t; a.setAttribute('readonly', ''); a.style.position = 'fixed'; a.style.top = '-1000px'; a.style.opacity = '0';
            document.body.appendChild(a); a.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
            a.remove();
            if (ok) res(); else rej();
          });
        }
        document.querySelectorAll('.net-cp').forEach(function (b) {
          b.addEventListener('click', function () {
            copyText(b.dataset.name).then(function () {
              b.innerHTML = TICK;
              setTimeout(function () { b.innerHTML = COPY; }, 1200);
            }, function () {
              b.title = 'the browser would not let this page copy - select the name instead';
            });
          });
        });
        ${control ? `var csrf = document.querySelector('meta[name=csrf]').content;
        ${ESC_FN}
        function post(path, body) {
          return fetch(path, { method: 'POST', headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
            .then(function (r) { return r.json(); });
        }
        document.getElementById('netprune').addEventListener('click', function () {
          qmConfirm({
            title: 'Prune unused networks', danger: true, confirmLabel: 'Prune',
            what: 'Remove every network with nothing attached to it?',
            detail: ['Docker\\u2019s own ', { c: 'bridge' }, ', ', { c: 'host' }, ' and ', { c: 'none' }, ' stay. A compose stack recreates its network next time it comes up.'],
          }).then(function (yes) {
            if (!yes) return;
            var t = qmToast('Prune unused networks');
            t.ops.set('p', { state: 'active', label: 'Removing unused networks', note: 'working' });
            post('/networks/prune', {}).then(function (d) {
              t.ops.set('p', { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'done' : 'failed') });
              if (d.ok) t.reloadOnClose();
            }).catch(function () { t.ops.set('p', { state: 'fail', note: 'could not reach the server' }); });
          });
        });
        document.querySelectorAll('.net-rm').forEach(function (b) {
          b.addEventListener('click', function () {
            var id = b.dataset.id;
            qmConfirm({
              title: 'Remove network', danger: true, confirmLabel: 'Remove',
              what: 'Delete this network?',
              detail: [{ c: id }, ' goes. Anything later attached to it by name has to have it recreated first.'],
            }).then(function (yes) {
              if (!yes) return;
              b.disabled = true;
              var t = qmToast('Remove ' + id);
              t.ops.set('r', { state: 'active', label: 'Removing ' + id, note: 'working' });
              post('/networks/remove', { id: id }).then(function (d) {
                t.ops.set('r', { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'removed' : 'failed') });
                if (!d.ok) { b.disabled = false; return; }
                var row = b.closest('.t-net');
                if (row) row.remove();
                apply();
              }).catch(function () { b.disabled = false; t.ops.set('r', { state: 'fail', note: 'could not reach the server' }); });
            });
          });
        });
        var ov = document.getElementById('netov'), mn = document.getElementById('netmnote');
        var name = document.getElementById('netname'), go = document.getElementById('netgo');
        function openM() { ov.hidden = false; mn.innerHTML = ''; name.focus(); }
        function closeM() { ov.hidden = true; }
        document.getElementById('netcreate').addEventListener('click', openM);
        document.getElementById('netx').addEventListener('click', closeM);
        document.getElementById('netcancel').addEventListener('click', closeM);
        ov.addEventListener('click', function (e) { if (e.target === ov) closeM(); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !ov.hidden) closeM(); });
        go.addEventListener('click', function () {
          var v = name.value.trim();
          if (!v) { name.focus(); return; }
          go.disabled = true;
          post('/networks/create', { name: v, driver: document.getElementById('netdriver').value, subnet: document.getElementById('netsubnet').value.trim() }).then(function (d) {
            go.disabled = false;
            if (d.ok) {
              mn.innerHTML = '<span class="state ok"><i></i>Created</span>';
              setTimeout(function () { location.reload(); }, 900);
            } else {
              mn.innerHTML = '<div class="err" style="margin:0">' + esc(d.note || d.error || 'failed') + '</div>';
            }
          }).catch(function () { go.disabled = false; mn.innerHTML = '<div class="err" style="margin:0">could not reach the server</div>'; });
        });` : ''}
      })();
    </script>`);
}
