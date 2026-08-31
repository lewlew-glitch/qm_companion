import { escapeHtml } from '../../http.js';
import { I, ESC_FN, LINT_FN, FOCUS_FN, lintPanel, badge, state, searchTools, cState, healthDot, metaOf, stackClass } from '../bits.js';
import { board, shell, noSocket } from '../chrome.js';
import { gridHeader, gridOpen, gridClose } from '../columns.js';

// Derive the stack status marker.
function stackState(s) {
  if (s.unhealthy) return state('bad', `${s.unhealthy} unhealthy`);
  if (s.total && s.running === s.total) return state('ok', 'Running');
  if (s.running === 0) return state('off', 'Stopped');
  return state('warn', `${s.total - s.running} down`);
}

function stackStateKey(s) {
  if (s.unhealthy) return 'attention';
  if (s.total && s.running === s.total) return 'running';
  if (s.running === 0) return 'stopped';
  return 'attention';
}

export function stacksPage(stacks, control, csrf, managed = []) {
  if (stacks === null) return noSocket('stacks', 'stack', 'Stacks', csrf);
  const t = searchTools('Search stacks…');
  const managedSet = new Set(managed);
  const totalContainers = stacks.reduce((n, s) => n + s.total, 0);
  const runningContainers = stacks.reduce((n, s) => n + s.running, 0);
  const unhealthyContainers = stacks.reduce((n, s) => n + s.unhealthy, 0);
  // Unknown resource counts contribute zero to totals and remain unknown in their row.
  const totalNetworks = stacks.reduce((n, s) => n + (typeof s.networks === 'number' ? s.networks : 0), 0);

  const rows = stacks.map((s, stackIndex) => {
    const isManaged = managedSet.has(s.name);
    const source = isManaged ? 'managed' : 'observed';
    const sourceLabel = isManaged ? 'Managed' : 'Observed';
    const sourceNote = isManaged
      ? 'Companion holds the editable Compose copy.'
      : 'Detected from Docker Compose labels. Adopt it to keep an editable copy in Companion.';
    const statusKey = stackStateKey(s);
    const foldId = `stack-work-${stackIndex}`;
    const hasProtectedService = s.services.some((svc) => svc.protected);
    // Populate folded service meters from one stats response keyed by container id.
    const svcCards = s.services.map((svc) => {
      const port = (svc.ports && svc.ports[0]) ? `<span class="badge mono port">${escapeHtml(svc.ports[0])}</span>` : '';
      const ip = svc.ip ? `<span class="badge line mono">${escapeHtml(svc.ip)}</span>` : '';
      const run = svc.state === 'running';
      const meter = (cls, label) => `<div class="meter ${cls}"><div class="m-row"><span>${label}</span><b data-cid="${escapeHtml(svc.id)}">${run ? '·' : 'Off'}</b></div><div class="m-bar"><i data-cid="${escapeHtml(svc.id)}"></i></div></div>`;
      const tone = svc.health === 'unhealthy' ? ' is-unhealthy' : run ? ' is-running' : ' is-stopped';
      return `<article class="svccard${tone}" data-img="${escapeHtml(svc.image || '')}">
        <div class="svc-top">${badge(svc.kind, svc.name)}<div class="svc-name"><b>${escapeHtml(svc.name)}</b>${svc.image ? `<span>${escapeHtml(svc.image)}</span>` : ''}${run && svc.uptime ? `<span class="svc-age">${escapeHtml(svc.uptime)}</span>` : ''}</div><div class="svc-state">${cState(svc)}${healthDot(svc.health, svc.state)}</div></div>
        <div class="meters">
          ${meter('m-cpu', 'CPU')}
          ${meter('m-mem', 'Mem')}
          ${meter('m-net', 'Net')}
          ${meter('m-dsk', 'Disk')}
        </div>
        <div class="svc-foot"><div class="svc-tags">${port}${ip}<span class="svc-upd hidden"><i></i>Update</span></div><a href="/containers?sel=${encodeURIComponent(svc.id)}">Open details${I.arrowR}</a></div>
      </article>`;
    }).join('');
    const refs = [...new Set(s.services.map((x) => x.image).filter(Boolean))].join(',');
    const composeAction = isManaged
      ? `<button type="button" class="btn editbtn" data-stack="${escapeHtml(s.name)}">${I.pencil}Edit Compose</button>`
      : `<button type="button" class="btn stack-adopt" data-stack="${escapeHtml(s.name)}">${I.plus}Adopt Compose</button>`;
    const dockerActions = control && !hasProtectedService ? `<span class="tool-sep" aria-hidden="true"></span>
        ${s.running < s.total ? '<button type="button" class="btn sv" data-verb="start">Up</button>' : ''}
        ${s.running > 0 ? '<button type="button" class="btn sv" data-verb="restart">Restart</button>' : ''}
        ${s.running > 0 ? '<button type="button" class="btn sv" data-verb="stop">Stop</button>' : ''}
        <button type="button" class="btn sv" data-verb="redeploy"><i class="updot quiet"></i>Redeploy</button>
        <button type="button" class="btn sv sv-down" data-verb="remove">Down</button>` : hasProtectedService
      ? `<span class="mode-note">${I.shield} Protected control plane</span>`
      : '';
    const commandBar = `<div class="stack-commandbar" data-stack="${escapeHtml(s.name)}" data-volumes="${s.volumes === null || s.volumes === undefined ? '' : s.volumes}" data-protected="${hasProtectedService ? '1' : ''}">${composeAction}${dockerActions}</div>`;
    const find = (s.name + ' ' + sourceLabel + ' ' + s.services.map((x) => `${x.name} ${x.image || ''}`).join(' ')).toLowerCase();
    return `<div class="tr t-stack stack-row" id="${escapeHtml(s.name)}" data-fold="${foldId}" data-open="0" data-find="${escapeHtml(find)}" data-name="${escapeHtml(s.name.toLowerCase())}" data-source="${source}" data-protected="${hasProtectedService ? '1' : ''}" data-running="${s.running}" data-state="${statusKey}" data-cpu="0" data-mem="0" data-update="" data-resources="${(typeof s.networks === 'number' ? s.networks : 0) + (typeof s.volumes === 'number' ? s.volumes : 0)}" data-imgs="${escapeHtml(refs)}">
        <div class="td stack-exp" data-col="exp"><span class="stack-grid-chevron" aria-hidden="true">${I.chev}</span></div>
        <div class="td stack-grid-name" data-col="stack"><span class="stack-symbol ${stackClass(s.name)}">${I.stack}</span><span class="stack-identity"><b>${escapeHtml(s.name)}</b><small>${s.total} container${s.total === 1 ? '' : 's'}</small></span></div>
        <div class="td" data-col="source"><span class="badge ${isManaged ? 'info' : 'line'}">${sourceLabel}</span></div>
        <div class="td num" data-col="running" title="${s.running} running of ${s.total}">${s.running}/${s.total}</div>
        <div class="td st-state" data-col="state">${stackState(s)}</div>
        <div class="td num agg-cpu" data-col="cpu" data-ids="${escapeHtml(s.ids.join(','))}">Collecting</div>
        <div class="td num agg-mem" data-col="mem" data-ids="${escapeHtml(s.ids.join(','))}">Collecting</div>
        <div class="td stack-update-cell" data-col="updates"><span class="state off stack-update"><i></i><span>Not checked</span></span></div>
        <div class="td stack-resources" data-col="resources"><span>${typeof s.networks === 'number' ? `${s.networks} net` : 'net unknown'}</span><span>${typeof s.volumes === 'number' ? `${s.volumes} vol` : 'vol unknown'}</span></div>
        <div class="td acts" data-col="actions"><button type="button" class="btn stack-open-btn" aria-expanded="false" aria-controls="${foldId}">Open</button></div>
      </div>
      <section class="stack-workspace" id="${foldId}" aria-label="${escapeHtml(s.name)} workspace" hidden>
        <div class="stack-work-head"><div><span class="stack-work-kicker">${sourceLabel} Compose stack</span><b>${escapeHtml(s.name)}</b><small>${sourceNote}</small></div>${commandBar}</div>
        <div class="stack-work-facts"><span>${s.running}/${s.total} running</span><span>${typeof s.networks === 'number' ? `${s.networks} network${s.networks === 1 ? '' : 's'}` : 'networks unknown'}</span><span>${typeof s.volumes === 'number' ? `${s.volumes} volume${s.volumes === 1 ? '' : 's'}` : 'volumes unknown'}</span><span>${s.services.length} service${s.services.length === 1 ? '' : 's'}</span></div>
        <div class="svcgrid">${svcCards}</div>
      </section>`;
  }).join('');

  // Saving writes Companion state; redeploying additionally requires Docker control.
  const editor = `<div class="overlay" id="sed" hidden>
      <div class="modal lg" role="dialog" aria-modal="true" aria-labelledby="sed-t">
        <div class="modal-h"><div><b id="sed-t"></b><span class="modal-sub" id="sed-src"></span></div><button type="button" class="iconbtn" id="sed-x" aria-label="Close">${I.x}</button></div>
        <div class="modal-b">
          <textarea class="market-yaml mono" id="sed-yaml" wrap="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Compose file"></textarea>
          <div class="varchips" id="sed-vars"></div>
          ${lintPanel('sed-lint')}
          <div id="sed-ops"></div>
        </div>
        <div class="modal-f"><span class="market-status" id="sed-note" role="status" aria-live="polite"></span><button type="button" class="btn" id="sed-cancel">Cancel</button><button type="button" class="btn primary" id="sed-save">Save</button>${control ? '<button type="button" class="btn hidden" id="sed-redeploy">Save &amp; redeploy</button>' : ''}</div>
      </div>
    </div>`;

  return shell('stacks', csrf, metaOf(), `
    ${board('stacks', 'Compose stacks', `<span class="count-tag" id="tcount">${stacks.length}</span>${stacks.length ? `<span class="hint fleet-line">${runningContainers}/${totalContainers} running · ${totalNetworks} networks${unhealthyContainers ? ` · <b class="bad-text">${unhealthyContainers} unhealthy</b>` : ''}</span>` : ''}`, metaOf())}
    ${stacks.length ? `<div class="page-tools stack-tools"><div class="tool-primary">${t.input}<select class="tbar-sel" id="stack-state" aria-label="Filter stacks by state"><option value="all">All states</option><option value="running">Running</option><option value="attention">Needs attention</option><option value="stopped">Stopped</option><option value="updates">Updates available</option></select><select class="tbar-sel" id="stack-source" aria-label="Filter stacks by source"><option value="all">All sources</option><option value="managed">Managed</option><option value="observed">Observed</option></select></div><div class="tool-actions"><span data-grid-gear></span><button class="btn" type="button" id="stack-expand">Expand all</button></div><div class="tool-note"><span class="hint" id="stack-metric-note">Live container use is collecting.</span><span class="hint" id="stack-update-note">Image updates have not been checked yet.</span></div></div>` : ''}
    ${stacks.length ? `${gridOpen('stacks', { tableClass: 'stack-grid', rowClick: true })}${gridHeader('stacks', { rowClass: 't-stack' })}${rows}${gridClose()}<div class="empty hidden" id="tempty">Nothing matches those filters.</div>` : '<div class="empty">No compose stacks found.</div>'}
    ${editor}
    <script>
      (function () {
        ${ESC_FN}
        ${LINT_FN}
        ${FOCUS_FN}
        var stackRows = Array.from(document.querySelectorAll('.stack-row'));
        var expand = document.getElementById('stack-expand'), stackSearch = document.getElementById('tsearch');
        var stateFilter = document.getElementById('stack-state'), sourceFilter = document.getElementById('stack-source');
        var empty = document.getElementById('tempty'), count = document.getElementById('tcount');
        function workspace(row) { return document.getElementById(row.dataset.fold); }
        function openRow(row, open) {
          var fold = workspace(row), button = row.querySelector('.stack-open-btn');
          row.dataset.open = open ? '1' : '0';
          row.classList.toggle('open', open);
          if (fold) fold.hidden = !open || row.style.display === 'none';
          if (button) { button.setAttribute('aria-expanded', open ? 'true' : 'false'); button.textContent = open ? 'Close' : 'Open'; }
        }
        function applyFilters() {
          var term = String(stackSearch && stackSearch.value || '').toLowerCase();
          var wantedState = stateFilter ? stateFilter.value : 'all';
          var wantedSource = sourceFilter ? sourceFilter.value : 'all';
          var shown = 0;
          stackRows.forEach(function (row) {
            var stateOk = wantedState === 'all' || (wantedState === 'updates' ? Number(row.dataset.update || 0) > 0 : row.dataset.state === wantedState);
            var sourceOk = wantedSource === 'all' || row.dataset.source === wantedSource;
            var ok = (!term || row.dataset.find.indexOf(term) >= 0) && stateOk && sourceOk;
            row.style.display = ok ? '' : 'none';
            var fold = workspace(row); if (fold) fold.hidden = !ok || row.dataset.open !== '1';
            if (ok) shown += 1;
          });
          if (count) count.textContent = shown;
          if (empty) empty.classList.toggle('hidden', shown > 0);
        }
        stackRows.forEach(function (row) {
          row.addEventListener('click', function (e) {
            if (e.target.closest('button,a,input,select')) return;
            openRow(row, row.dataset.open !== '1');
          });
          var button = row.querySelector('.stack-open-btn');
          if (button) button.addEventListener('click', function () { openRow(row, row.dataset.open !== '1'); });
        });
        [stackSearch, stateFilter, sourceFilter].forEach(function (field) { if (field) field.addEventListener('input', applyFilters); });
        if (expand) expand.addEventListener('click', function () {
          var visible = stackRows.filter(function (row) { return row.style.display !== 'none'; });
          var shouldOpen = visible.some(function (row) { return row.dataset.open !== '1'; });
          visible.forEach(function (row) { openRow(row, shouldOpen); });
          expand.textContent = shouldOpen ? 'Collapse all' : 'Expand all';
        });
        if (location.hash) {
          try { var hashRow = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (hashRow && hashRow.classList.contains('stack-row')) openRow(hashRow, true); } catch (e) {}
        }
        function fb(n){ if(!n) return '0'; var u=['B','K','M','G','T'],i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return (n<10&&i>0?n.toFixed(1):Math.round(n))+u[i]; }
        function pollStats() { fetch('/api/containers/stats').then(function(r){if(!r.ok) throw new Error('stats'); return r.json();}).then(function(d){
          var m = {}; (d.stats || []).forEach(function(s){ m[s.id] = s; });
          function fill(bar, pct){ bar.style.transform = 'scaleX(' + (Math.min(100, Math.max(0, pct)) / 100) + ')'; }
          // Scale cumulative network and disk totals against the busiest visible container.
          var maxNet = 0, maxDsk = 0;
          (d.stats || []).forEach(function(s){
            if (s.net) maxNet = Math.max(maxNet, s.net.rx + s.net.tx);
            if (s.disk) maxDsk = Math.max(maxDsk, s.disk.read + s.disk.write);
          });
          document.querySelectorAll('.m-cpu').forEach(function(el){
            var b=el.querySelector('b'), bar=el.querySelector('i'), s=m[b.dataset.cid]; if(!s) { if (b.textContent === '·') b.textContent = 'Unavailable'; return; }
            b.textContent = s.cpu.toFixed(1)+'%'; fill(bar, s.cpu);
          });
          document.querySelectorAll('.m-mem').forEach(function(el){
            var b=el.querySelector('b'), bar=el.querySelector('i'), s=m[b.dataset.cid]; if(!s) { if (b.textContent === '·') b.textContent = 'Unavailable'; return; }
            b.textContent = s.mem.toFixed(1)+'%'; fill(bar, s.mem);
          });
          document.querySelectorAll('.m-net').forEach(function(el){
            var b=el.querySelector('b'), bar=el.querySelector('i'), s=m[b.dataset.cid]; if(!s||!s.net) { if (b.textContent === '·') b.textContent = 'Unavailable'; return; }
            var v = s.net.rx + s.net.tx;
            b.textContent = fb(v); fill(bar, maxNet ? v / maxNet * 100 : 0);
          });
          document.querySelectorAll('.m-dsk').forEach(function(el){
            var b=el.querySelector('b'), bar=el.querySelector('i'), s=m[b.dataset.cid]; if(!s||!s.disk) { if (b.textContent === '·') b.textContent = 'Unavailable'; return; }
            var v = s.disk.read + s.disk.write;
            b.textContent = fb(v); fill(bar, maxDsk ? v / maxDsk * 100 : 0);
          });
          function values(el, pick){
            var ids = (el.dataset.ids || '').split(',').filter(Boolean), missing = 0;
            var value = ids.reduce(function (n, id) { var s = m[id]; if (!s) { missing++; return n; } return n + pick(s); }, 0);
            return { value: value, missing: missing };
          }
          document.querySelectorAll('.agg-cpu').forEach(function(el){
            var answer = values(el, function(s){return s.cpu;}); el.textContent = answer.value.toFixed(1)+'%' + (answer.missing ? ' partial' : ''); el.closest('.stack-row').dataset.cpu = String(answer.value);
          });
          // Aggregate memory in bytes because container limits may differ.
          document.querySelectorAll('.agg-mem').forEach(function(el){
            var answer = values(el, function(s){return s.memUsed || 0;}); el.textContent = fb(answer.value) + (answer.missing ? ' partial' : ''); el.closest('.stack-row').dataset.mem = String(answer.value);
          });
          var note=document.getElementById('stack-metric-note'); if(note) note.textContent=d.unavailable ? 'Live container use, ' + d.unavailable + ' unavailable' : 'Live container use';
        }).catch(function(){
          var note=document.getElementById('stack-metric-note'); if(note) note.textContent='Live resource use unavailable.';
          document.querySelectorAll('.meter b').forEach(function(el){ if(el.textContent==='·') el.textContent='Unavailable'; });
          document.querySelectorAll('.agg-cpu,.agg-mem').forEach(function(el){ el.textContent='Unavailable'; });
        }); }
        pollStats(); setInterval(pollStats, 5000);

        // Read update state from the shared cache without inferring missing values.
        fetch('/api/updates?cached=1').then(function (r) { return r.json(); }).then(function (d) {
          var byRef = {};
          (d.results || []).forEach(function (x) { byRef[x.image] = x; });
          function stampUpdate(row, tone, label, n) {
            var mark = row.querySelector('.stack-update'), word = mark && mark.querySelector('span');
            if (mark) mark.className = 'state stack-update ' + tone;
            if (word) word.textContent = label;
            row.dataset.update = String(n);
            row.setAttribute('data-update', n > 0 ? '1' : '');
            var fold = workspace(row), dot = fold && fold.querySelector('.updot');
            if (dot) dot.classList.toggle('quiet', n === 0);
          }
          stackRows.forEach(function (row) {
            var refs = (row.dataset.imgs || '').split(',').filter(Boolean);
            var available = 0, current = 0, unknown = 0, dismissed = 0;
            refs.forEach(function (ref) {
              var answer = byRef[ref];
              if (!answer || answer.status === 'unknown') unknown += 1;
              else if (answer.status === 'update' && answer.dismissed) dismissed += 1;
              else if (answer.status === 'update') available += 1;
              else if (answer.status === 'current') current += 1;
              else unknown += 1;
            });
            // Derive stack counts and service markers from the same cached image result.
            var fold = workspace(row);
            if (fold) {
              Array.prototype.forEach.call(fold.querySelectorAll('.svccard'), function (card) {
                var answer = byRef[card.dataset.img];
                var flagged = !!(answer && answer.status === 'update' && !answer.dismissed);
                var chip = card.querySelector('.svc-upd');
                if (chip) chip.classList.toggle('hidden', !flagged);
                card.classList.toggle('has-update', flagged);
              });
            }
            if (!refs.length) stampUpdate(row, 'off', 'No images', 0);
            else if (available) stampUpdate(row, 'warn', available + (available === 1 ? ' update' : ' updates'), available);
            else if (unknown) stampUpdate(row, 'off', unknown + ' unknown', 0);
            else if (dismissed) stampUpdate(row, 'off', dismissed + ' dismissed', 0);
            else if (current === refs.length) stampUpdate(row, 'ok', 'Current', 0);
            else stampUpdate(row, 'off', 'Not checked', 0);
          });
          var updateNote = document.getElementById('stack-update-note');
          if (updateNote) updateNote.textContent = d.checkedAt ? 'Image status from the shared update cache.' : 'Image updates have not been checked yet.';
          applyFilters();
        }).catch(function () {
          var updateNote = document.getElementById('stack-update-note'); if (updateNote) updateNote.textContent = 'Image update status unavailable.';
        });

        var csrfv = document.querySelector('meta[name=csrf]').content;
        function post(path, body) {
          return fetch(path, { method: 'POST', headers: { 'x-csrf-token': csrfv, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
            .then(function (r) { return r.json(); });
        }

        // Adopt an untracked stack or edit a stored one.
        var sed = document.getElementById('sed'), sedT = document.getElementById('sed-t'), sedSrc = document.getElementById('sed-src');
        var sedYaml = document.getElementById('sed-yaml'), sedVars = document.getElementById('sed-vars');
        var sedNote = document.getElementById('sed-note'), sedOps = document.getElementById('sed-ops');
        var sedSave = document.getElementById('sed-save'), sedRedeploy = document.getElementById('sed-redeploy');
        var sedStack = '', sedDirty = false, sedProtected = false;
        var sedTrap = qmFocusTrap(sed);
        // Lint before Docker writes.
        var sedLint = qmLintWire({
          yaml: sedYaml,
          panel: document.getElementById('sed-lint'),
          buttons: sedRedeploy ? [sedRedeploy] : [],
          stack: function () { return sedStack; },
        });
        var SRC_LINE = { managed: 'the copy Companion holds', file: 'seeded from the mounted compose file', skeleton: 'generated skeleton - environment and mounts are not recoverable, add them by hand' };
        function chips() {
          var re = /\\$\\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\\}/g, seen = {}, out = [], m;
          while ((m = re.exec(sedYaml.value))) { if (seen[m[1]]) continue; seen[m[1]] = 1; out.push({ k: m[1], d: m[2] ? m[3] : null }); }
          sedVars.innerHTML = out.length ? out.map(function (v) {
            return '<span class="varchip"><span class="vk">' + esc(v.k) + '</span>' + (v.d === null ? '<em class="vunset">unset</em>' : '<code>' + esc(v.d) + '</code>') + '</span>';
          }).join('') : '';
          sedVars.hidden = !out.length;
        }
        var chipTimer = null;
        sedYaml.addEventListener('input', function () { sedDirty = true; clearTimeout(chipTimer); chipTimer = setTimeout(chips, 300); });
        function openEditor(name, managed, protectedStack) {
          var opener = document.activeElement;
          sedStack = name; sedDirty = false; sedProtected = !!protectedStack;
          sedT.textContent = (managed ? 'Edit ' : 'Adopt ') + name;
          sedSrc.textContent = ''; sedNote.textContent = ''; sedOps.textContent = '';
          sedYaml.value = 'Fetching\\u2026'; sedYaml.disabled = true;
          sedLint.reset();
          if (sedRedeploy) sedRedeploy.classList.toggle('hidden', !managed || sedProtected);
          sed.hidden = false;
          sedTrap.open(opener, document.getElementById('sed-x'));
          fetch('/stacks/' + encodeURIComponent(name) + '/seed').then(function (r) { return r.json(); }).then(function (d) {
            sedYaml.disabled = false;
            if (!d.yaml) { sedYaml.value = ''; sedNote.textContent = d.error || 'nothing could be seeded'; return; }
            sedYaml.value = d.yaml;
            sedSrc.textContent = SRC_LINE[d.source] || '';
            chips();
            sedLint.refresh();
            sedYaml.focus();
          }).catch(function () { sedYaml.disabled = false; sedYaml.value = ''; sedNote.textContent = 'could not reach the server'; });
        }
        function closeEditorNow() { if (sed.hidden) return; sed.hidden = true; sedStack = ''; sedDirty = false; sedProtected = false; sedTrap.close(); }
        function closeEditor() {
          if (!sedDirty) { closeEditorNow(); return; }
          qmConfirm({
            title: 'Discard Compose changes?',
            what: 'Close the editor without saving your changes?',
            detail: ['The stored Compose copy is unchanged.'],
            confirmLabel: 'Discard changes',
            danger: true,
          }).then(function (yes) { if (yes) closeEditorNow(); });
        }
        document.getElementById('sed-x').addEventListener('click', closeEditor);
        document.getElementById('sed-cancel').addEventListener('click', closeEditor);
        sed.addEventListener('click', function (e) { if (e.target === sed) closeEditor(); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !sed.hidden) closeEditor(); });
        window.addEventListener('beforeunload', function (e) { if (!sed.hidden && sedDirty) { e.preventDefault(); e.returnValue = ''; } });
        function saveStack() {
          sedSave.disabled = true;
          return post('/stacks/adopt', { name: sedStack, yaml: sedYaml.value }).then(function (d) {
            sedSave.disabled = false;
            if (!d.ok) { sedNote.textContent = d.error || 'not saved'; return false; }
            sedDirty = false;
            sedNote.textContent = 'Saved. Companion now holds this compose file.';
            return true;
          }).catch(function () { sedSave.disabled = false; sedNote.textContent = 'could not reach the server'; return false; });
        }
        sedSave.addEventListener('click', function () {
          saveStack().then(function (ok) { if (ok) setTimeout(function () { location.reload(); }, 700); });
        });
        if (sedRedeploy) sedRedeploy.addEventListener('click', function () {
          saveStack().then(function (ok) {
            if (!ok) return;
            var ops = qmOps(sedOps);
            sedRedeploy.disabled = true;
            qmStream('/stacks/deploy', { name: sedStack, yaml: sedYaml.value, env: {}, start: true }, function (e) {
              ops.set(e.step || e.id || 'step', { state: e.ok === false || e.state === 'fail' ? 'fail' : e.ok === true || e.state === 'ok' ? 'ok' : 'active', label: e.label || e.step, note: e.note });
            }).then(function (d) {
              sedRedeploy.disabled = false;
              sedLint.sync();
              sedNote.textContent = d.ok ? 'Deployed.' : d.partial ? 'Partly deployed - the steps say where it stopped.' : 'Deployment stopped - the steps say why.';
              if (d.ok) setTimeout(function () { location.reload(); }, 900);
            }).catch(function () { sedRedeploy.disabled = false; sedLint.sync(); sedNote.textContent = 'could not reach the server'; });
          });
        });
        document.querySelectorAll('.stack-adopt').forEach(function (b) {
          b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); var bar = b.closest('.stack-commandbar'); openEditor(b.dataset.stack, false, bar && bar.dataset.protected === '1'); });
        });
        document.querySelectorAll('.editbtn').forEach(function (b) {
          b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); var bar = b.closest('.stack-commandbar'); openEditor(b.dataset.stack, true, bar && bar.dataset.protected === '1'); });
        });

        // Run stack commands serially and report each step in the operation toast.
        var ASKS = {
          start: { title: 'Up', what: 'Start every container in this stack?', label: 'Up', pref: true },
          restart: { title: 'Restart', what: 'Restart every container in this stack, one after the other?', label: 'Restart', pref: true },
          stop: { title: 'Stop', what: 'Stop every container in this stack?', label: 'Stop', pref: true },
          redeploy: { title: 'Redeploy', what: 'Pull the newest image for each container and recreate it?', label: 'Redeploy' },
          remove: { title: 'Down', what: 'Stop and remove every container in this stack?', label: 'Down', danger: true },
        };
        function runVerb(name, verb, volumes) {
          var a = ASKS[verb];
          var detail = verb === 'redeploy'
            ? ['Containers are replaced one at a time. A failed rollback stops the redeploy.']
            : verb === 'remove'
              ? ['Volumes and networks are kept. ' + (volumes === null ? 'Volume ownership could not be determined. Type the stack name to confirm.' : volumes > 0 ? 'This stack has ' + volumes + ' volume' + (volumes === 1 ? '' : 's') + '. Type the stack name to confirm.' : 'The Compose file can recreate the stack.')]
              : [''];
          qmConfirm({
            title: a.title + ' ' + name, what: a.what, detail: detail, confirmLabel: a.label,
            danger: !!a.danger, pref: !!a.pref,
            typed: verb === 'remove' && (volumes === null || volumes > 0) ? name : undefined,
          }).then(function (yes) {
            if (!yes) return;
            var t = qmToast(a.title + ' ' + name);
            qmStream('/stacks/' + encodeURIComponent(name) + '/' + verb, {}, function (e) {
              t.ops.set(e.id, { state: e.state, label: e.label, note: e.note, mono: e.mono, pct: e.pct });
            }).then(function (d) {
              t.ops.set('zz', { state: d.ok ? 'ok' : 'fail', label: 'Finished', note: d.note || (d.ok ? 'done' : 'failed') });
              if (d.ok || d.halted) t.reloadOnClose();
            }).catch(function () { t.ops.set('zz', { state: 'fail', label: 'Finished', note: 'could not reach the server' }); });
          });
        }
        document.querySelectorAll('.stack-commandbar .sv').forEach(function (b) {
          b.addEventListener('click', function () {
            var wrap = b.closest('.stack-commandbar');
            var volRaw = wrap.dataset.volumes;
            var volCount = volRaw === '' || volRaw === undefined ? null : Number(volRaw);
            if (volCount !== null && !isFinite(volCount)) volCount = null;
            runVerb(wrap.dataset.stack, b.dataset.verb, volCount);
          });
        });
      })();
    </script>`);
}
