import { escapeHtml } from '../../http.js';
import { widelyBoundFromListing } from '../../wide-bindings.js';
import { config } from '../../config.js';
import { labelFor, schemeFor } from '../../kinds.js';
import { marketplaceEntry } from '../../marketplace.js';
import { I, badge, cState, healthDot, jsafe, stackClass } from '../bits.js';
import { board, shell, noSocket } from '../chrome.js';
import { gridHeader, gridOpen, gridClose } from '../columns.js';

// Accept only HTTP(S) URLs or plain hostnames from container labels.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function publicUrlFromLabels(labels) {
  if (!labels || typeof labels !== 'object') return null;
  try {
    const declared = labels['qm.url'];
    if (typeof declared === 'string' && declared) {
      const u = new URL(declared);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !u.search && !u.hash) return u.toString();
    }
  } catch { /* junk stays junk */ }
  try {
    for (const [key, value] of Object.entries(labels)) {
      if (!/^traefik\.http\.routers\.[^.]+\.rule$/.test(key) || typeof value !== 'string') continue;
      const m = /Host\(\s*[`'"]([^`'"]+)[`'"]/.exec(value);
      if (m && HOSTNAME_RE.test(m[1])) return `https://${m[1]}`;
    }
    for (const [key, value] of Object.entries(labels)) {
      if (!(key === 'caddy' || /^caddy_\d+$/.test(key)) || typeof value !== 'string') continue;
      const host = value.trim().split(/[\s,]/)[0].replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
      if (HOSTNAME_RE.test(host)) return `https://${host}`;
    }
  } catch { /* a hostile label map never takes the page down */ }
  return null;
}

// Use a dash for empty cells; titles explain ambiguous values.
const off = () => '<span class="faint">-</span>';

// Render published ports and any reverse-proxy URL.
function portChip(c, p) {
  const hostPort = String(p).split(':')[0];
  if (!config.qmHost || !/^\d+$/.test(hostPort) || /udp/i.test(p)) {
    return `<span class="badge port">${escapeHtml(p)}</span>`;
  }
  const scheme = c.kind ? schemeFor(c.kind) : 'http';
  const href = `${scheme}://${config.qmHost}:${hostPort}`;
  const out = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
  return `<a class="badge port portlink" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="Open ${escapeHtml(href)}">${escapeHtml(p)}${out}</a>`;
}

function portsCell(c) {
  const chips = c.ports.slice(0, 2).map((p) => portChip(c, p)).join('');
  const extra = c.ports.length > 2
    ? `<span class="badge line" title="${escapeHtml(c.ports.slice(2).join('  '))}">+${c.ports.length - 2}</span>`
    : '';
  const url = publicUrlFromLabels(c.labels);
  const urlChip = url
    ? `<a class="badge line urlchip" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(url)}">${I.globe}${escapeHtml(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`
    : '';
  return chips || extra || urlChip ? `<span class="ep-chips">${chips}${extra}${urlChip}</span>` : off();
}

// Render read actions for all users and lifecycle actions only with Docker control.
function actions(c, control, shellAccess) {
  const b = (action, label, ico, cls) => `<button class="actbtn ${cls}" data-id="${escapeHtml(c.id)}" data-action="${action}" title="${label}" aria-label="${label}">${I[ico]}</button>`;
  const go = (href, label, ico) => `<a class="actbtn" href="${href}" title="${label}" aria-label="${label}">${I[ico]}</a>`;
  const id = encodeURIComponent(c.id);
  const logs = go(`/console?id=${id}`, 'Logs', 'list');
  const eye = `<button class="actbtn ct-eye" type="button" title="Details" aria-label="Details">${I.eye}</button>`;
  if (!control) return `<div class="acts">${logs}${eye}</div>`;
  if (c.protected) {
    return `<div class="acts">${logs}${eye}<span class="actguard" title="Protected control-plane container" aria-label="Protected control-plane container">${I.shield}</span></div>`;
  }
  const shellBtn = shellAccess ? go(`/console?id=${id}&shell=1`, 'Shell', 'term') : '';
  const upd = `<button class="actbtn upd ct-update hidden" data-id="${escapeHtml(c.id)}" title="Update image" aria-label="Update image">${I.rotate}</button>`;
  const running = c.state === 'running' || c.state === 'restarting';
  const lifecycle = running
    ? `${b('pause', 'Pause', 'pause', 'halt')}${b('stop', 'Stop', 'stop', 'halt')}`
    : c.state === 'paused'
      ? `${b('unpause', 'Resume', 'play', 'go')}${b('stop', 'Stop', 'stop', 'halt')}`
      : b('start', 'Start', 'play', 'go');
  return `<div class="acts">${upd}${logs}${shellBtn}${eye}${lifecycle}${b('restart', 'Restart', 'rotate', 'spin')}${b('remove', 'Delete', 'trash', 'halt')}</div>`;
}

// An empty array is a successful Docker response. Do not render actions without container rows.
function noContainers(csrf, meta) {
  return shell('containers', csrf, meta, `
    ${board('containers', 'Containers', '<span class="count-tag">0</span>', meta)}
    <div class="empty">Docker returned no containers, including stopped containers.
      <br><br>Bring a stack up from the directory holding its compose file:
      <code class="mono">docker compose -f docker-compose.example.yml up -d</code>.
      <br>Repeat every <code class="mono">-f</code> file this install already starts with, in the same
      order.</div>`);
}

// Restarting containers are active and have no stats sample until they are running again.
const LOOPING = 'Docker keeps restarting this container. Restart counts are read alongside container '
  + 'stats, and a container that is not up has none, so there is no number to show here. Its log says why it exits.';

export function containersPage(containers, control, csrf, shellAccess = false) {
  if (containers === null) return noSocket('containers', 'box', 'Containers', csrf);
  const meta = { host: config.qmHost || 'localhost', count: null };
  if (!containers.length) return noContainers(csrf, meta);

  const running = containers.filter((c) => c.state === 'running').length;
  const paused = containers.filter((c) => c.state === 'paused').length;
  const restarting = containers.filter((c) => c.state === 'restarting').length;
  const inactive = containers.length - running - paused - restarting;
  const unhealthy = containers.filter((c) => c.health === 'unhealthy').length;

  // Wide bindings require container recreation; image updates preserve existing port bindings.
  const wide = widelyBoundFromListing(containers);
  const wideNotice = wide.length === 0 ? '' : `
    <div class="note warn" data-wide-bindings>
      <strong>${wide.length} container${wide.length === 1 ? '' : 's'} reachable on every network interface.</strong>
      ${escapeHtml(wide.map((c) => c.name).join(', '))}.
      Updating an image does not change this: Docker fixes port bindings when a container is created.
      Add the host address to the published ports in that stack's Compose file
      (${escapeHtml(`"${config.qmHost || '127.0.0.1'}:8080:80"`)} instead of "8080:80") and recreate that stack.
      ${wide.some((c) => c.hostNetwork) ? 'Containers on the host network cannot be fixed this way: they have no port mapping at all.' : ''}
    </div>`;

  // Rows mirror the column registry. Live metrics populate sort attributes after polling.
  const rows = containers.map((c) => {
    const upstream = c.kind ? marketplaceEntry(c.kind)?.upstreamUrl : null;
    const image = upstream
      ? `<a class="addr image-source" href="${escapeHtml(upstream)}" target="_blank" rel="noopener noreferrer" title="Open the official ${escapeHtml(labelFor(c.kind))} project">${escapeHtml(c.image)}${I.globe}</a>`
      : `<span class="addr" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}</span>`;
    return `
    <div class="tr t-ctr" data-cid="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}" data-image="${escapeHtml(c.image)}" data-upstream="${escapeHtml(upstream || '')}"
      data-ip="${escapeHtml(c.ip || '')}" data-ports="${escapeHtml(c.ports.join(', '))}" data-stack="${escapeHtml(c.stack || '')}"
      data-status="${escapeHtml(c.status || '')}" data-kind="${escapeHtml(c.kind || '')}" data-health="${escapeHtml(c.health || '')}"
      data-cpu="" data-mem="" data-restarts="" data-protected="${c.protected ? '1' : ''}"
      data-find="${escapeHtml((c.name + ' ' + c.image + ' ' + (c.stack || '') + ' ' + (c.ip || '')).toLowerCase())}" data-state="${escapeHtml(c.state || '')}">
      ${control ? `<div class="td selc" data-col="sel">${c.protected
        ? `<span class="rowguard" title="Protected control-plane container" aria-label="Protected control-plane container">${I.shield}</span>`
        : `<input type="checkbox" class="rowsel" aria-label="Select ${escapeHtml(c.name)}">`}</div>` : ''}
      <div class="td ctr-ident" data-col="name">
        ${badge(c.kind, c.kind ? labelFor(c.kind) : c.name)}
        <div class="ctr-copy"><div class="svc" title="${escapeHtml(c.name)}"><span>${escapeHtml(c.name)}</span></div></div>
      </div>
      <div class="td imgcell" data-col="image">${image}</div>
      <div class="td ctr-status" data-col="state">${cState(c)}</div>
      <div class="td" data-col="health">${healthDot(c.health, c.state)}</div>
      <div class="td addr" data-col="uptime">${c.state === 'running' && c.uptime ? escapeHtml(c.uptime.replace(/^Up\s*/i, '')) : off()}</div>
      <div class="td num dim rst" data-col="restarts" data-cid="${escapeHtml(c.id)}">${c.state === 'running'
        ? '·'
        : c.state === 'restarting'
          ? `<a href="/console?id=${encodeURIComponent(c.id)}" title="${escapeHtml(LOOPING)}">Looping</a>`
          : off()}</div>
      <div class="td num v cpu" data-col="cpu" data-cid="${escapeHtml(c.id)}">${c.state === 'running' ? '·' : off()}</div>
      <div class="td num dim mem" data-col="mem" data-cid="${escapeHtml(c.id)}">${c.state === 'running' ? '·' : off()}</div>
      <div class="td io" data-col="netio"><span class="io net" data-cid="${escapeHtml(c.id)}">${c.state === 'running' ? '·' : off()}</span></div>
      <div class="td io" data-col="diskio"><span class="io disk" data-cid="${escapeHtml(c.id)}">${c.state === 'running' ? '·' : off()}</span></div>
      <div class="td addr" data-col="ip">${c.ip ? escapeHtml(c.ip) : off()}</div>
      <div class="td ctr-endpoint" data-col="ports">${portsCell(c)}</div>
      <div class="td" data-col="update"><button type="button" class="upflag hidden" data-ref="${escapeHtml(c.image)}" title="Update available. Click to re-check this image" aria-label="Re-check this image for updates"><i></i>Update</button><span class="faint updash">-</span></div>
      <div class="td" data-col="stack">${c.stack ? `<a class="badge stacktint ${stackClass(c.stack)} stacklink" href="/stacks#${encodeURIComponent(c.stack)}">${escapeHtml(c.stack)}</a>` : off()}</div>
      <div class="td" data-col="actions">${actions(c, control, shellAccess)}</div>
    </div>`;
  }).join('');

  const header = gridHeader('containers', { control, rowClass: 't-ctr' });

  // Render bulk actions only when at least one row is selected.
  const bulkButtons = control
    ? `<span class="bulkrail hidden" id="bulkrail"><span class="selchip" id="selchip"><b id="selcount">0</b> selected · <button type="button" class="sel-clear" id="selclear">clear</button></span>
        ${['start', 'stop', 'restart', 'pause', 'update', 'delete'].map((v) => `<button class="btn bulkv" data-verb="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</span>
        <span class="tool-sep"></span>`
    : '';

  return shell('containers', csrf, meta, `
    ${board('containers', 'Containers', `<span class="count-tag" id="ccount">${containers.length}</span><span class="hint fleet-line">${running} running · ${inactive} inactive${paused ? ` · ${paused} paused` : ''}${restarting ? ` · <b class="bad-text">${restarting} restarting</b>` : ''}${unhealthy ? ` · <b class="bad-text">${unhealthy} unhealthy</b>` : ''}</span>`, meta)}
    ${wideNotice}
    <div class="page-tools">
      <div class="tool-primary">
        <div class="tbar-search">${I.search}<input id="csearch" type="text" placeholder="Search containers…" autocomplete="off" spellcheck="false"></div>
        <select id="cstatus" class="tbar-sel" aria-label="Filter by container status">
          <option value="">All statuses</option><option value="running">Running</option>
          <option value="inactive">Inactive</option><option value="paused">Paused</option>
          <option value="restarting">Restarting</option><option value="unhealthy">Unhealthy</option>
          <option value="updates">Update available</option>
        </select>
      </div>
      <div class="tool-actions">
        ${bulkButtons}
        <button class="btn" id="chkupd" type="button" title="Check for updates now">${I.rotate}Check updates</button>
        ${control ? `<span class="updcluster hidden" id="updcluster"><button class="btn" id="updall" type="button"><i class="updot"></i><span class="updlbl">Update all (<span id="updn">0</span>)</span></button><button class="iconbtn" id="upddis" type="button" title="Dismiss these updates until their images change again" aria-label="Dismiss these updates">${I.x}</button></span>
        <button class="btn" id="cprune" type="button">Prune</button>` : ''}
        <span data-grid-gear></span>
      </div>
      <div class="tool-note"><span class="hint" id="upsum"></span><span class="hint" id="updself"></span><span class="hint" id="cnote"></span>
        ${control ? '' : '<span class="mode-note">Read-only mode</span>'}</div>
    </div>
    ${gridOpen('containers', { control, tableClass: `ctable2${control ? ' ctl' : ''}`, rowClick: true })}
      ${header}
      ${rows}
    ${gridClose()}
    <div class="empty hidden" id="cempty">Nothing matches that filter.</div>
    <aside class="detail wide" id="detail" aria-label="Container detail" aria-hidden="true" inert>
      <div class="d-head"><span id="d-logo"></span><b id="d-name"></b><button type="button" class="upflag d-upnote hidden" id="d-upnote" title="A newer image is available"><i></i>Update available</button><button class="iconbtn d-close" id="d-close" aria-label="Close">${I.x}</button></div>
      <div class="d-state" id="d-state"></div>
      <div class="d-tabs" role="tablist" aria-label="Container detail sections">
        <button type="button" class="d-tab on" role="tab" aria-selected="true" data-dtab="overview">Overview</button>
        <button type="button" class="d-tab" role="tab" aria-selected="false" data-dtab="env">Environment</button>
        <button type="button" class="d-tab" role="tab" aria-selected="false" data-dtab="mounts">Mounts</button>
        <button type="button" class="d-tab" role="tab" aria-selected="false" data-dtab="adv">Advanced</button>
      </div>
      <div class="d-pane" data-dpane="overview">
        <div class="d-charts">
          <div class="d-chart"><div class="lbl">CPU <b id="d-cpu">Waiting</b></div><svg viewBox="0 0 140 44" preserveAspectRatio="none"><path class="cpu-line" id="d-cpu-path" d=""/></svg></div>
          <div class="d-chart"><div class="lbl">Memory <b id="d-mem">Waiting</b></div><svg viewBox="0 0 140 44" preserveAspectRatio="none"><path class="mem-line" id="d-mem-path" d=""/></svg></div>
        </div>
        <div class="d-kv">
          <div class="kv"><span>Image</span><b id="d-image"></b></div>
          <div class="kv" id="d-upstream-row" hidden><span>Project</span><a class="image-source" id="d-upstream" target="_blank" rel="noopener noreferrer">Official project${I.globe}</a></div>
          <div class="kv"><span>IP</span><b id="d-ip"></b></div>
          <div class="kv"><span>Ports</span><b id="d-ports"></b></div>
          <div class="kv"><span>Stack</span><b id="d-stack"></b></div>
          <div class="kv"><span>Health</span><b id="d-health"></b></div>
          <div class="kv"><span>Status</span><b id="d-status"></b></div>
        </div>
      </div>
      <div class="d-pane hidden" data-dpane="env">
        <div class="d-list" id="d-envs"><span class="d-wait">Fetching</span></div>
      </div>
      <div class="d-pane hidden" data-dpane="mounts">
        <div class="d-list" id="d-mounts"></div>
      </div>
      <div class="d-pane hidden" data-dpane="adv">
        <div class="d-adv"><span>Advanced</span></div>
        <div class="d-sec">Labels</div>
        <div class="d-list" id="d-labels"></div>
        <div class="d-sec">Limits</div>
        <div class="d-kv" id="d-limits"></div>
      </div>
      <div class="d-actions">
        <span class="d-guard hidden" id="d-guard">${I.shield}Protected control plane</span>
        <span class="d-guard hidden" id="d-gone">Docker no longer has this container. Reload for the current list.</span>
        <a class="btn" id="d-console" href="#">Console</a>
        ${control ? `<button class="btn" id="d-restart">Restart</button>
        <button class="btn hidden" id="d-update">Update</button>` : ''}
      </div>
    </aside>
    <script>
      (function () {
        function fb(n){ if(!n) return '0'; var u=['B','K','M','G','T'],i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return (n<10&&i>0?n.toFixed(1):Math.round(n))+u[i]; }
        // Accumulate chart samples while the page is open.
        var hist = {};
        function push(id, cpu, mem) {
          var h = hist[id] || (hist[id] = { cpu: [], mem: [] });
          h.cpu.push(cpu); h.mem.push(mem);
          if (h.cpu.length > 60) { h.cpu.shift(); h.mem.shift(); }
        }
        function areaPath(vals, w, hgt, max, cap) {
          if (!vals.length) return '';
          var step = w / Math.max(cap - 1, 1);
          var pts = vals.map(function (v, i) {
            var y = hgt - 2 - Math.min(1, v / max) * (hgt - 6);
            return (i * step).toFixed(1) + ',' + y.toFixed(1);
          });
          var endX = ((vals.length - 1) * step).toFixed(1);
          return 'M0,' + hgt + ' L' + pts.join(' L') + ' L' + endX + ',' + hgt + ' Z';
        }
        var open = null;
        // Containers without stats history receive an explicit state instead of stale values.
        var METRIC_WORD = { running: 'Waiting', restarting: 'None while it restarts', paused: 'None while paused' };
        function drawDetail() {
          if (!open) return;
          var h = hist[open] || { cpu: [], mem: [] };
          document.getElementById('d-cpu-path').setAttribute('d', areaPath(h.cpu, 140, 44, Math.max(10, Math.max.apply(null, h.cpu.concat([1])) * 1.2), 60));
          document.getElementById('d-mem-path').setAttribute('d', areaPath(h.mem, 140, 44, 100, 60));
          if (h.cpu.length) {
            document.getElementById('d-cpu').textContent = h.cpu[h.cpu.length - 1].toFixed(1) + '%';
            document.getElementById('d-mem').textContent = h.mem[h.mem.length - 1].toFixed(1) + '%';
            return;
          }
          var row = document.querySelector('.t-ctr[data-cid="' + open + '"]');
          var word = row ? (METRIC_WORD[row.dataset.state] || 'Not running') : 'Not available';
          document.getElementById('d-cpu').textContent = word;
          document.getElementById('d-mem').textContent = word;
        }
        function poll() {
          fetch('/api/containers/stats').then(function(r){if(!r.ok) throw new Error('stats'); return r.json();}).then(function(d){
            var m = {}; (d.stats || []).forEach(function(s){ m[s.id] = s; push(s.id, s.cpu, s.mem); });
            var note=document.getElementById('cnote');
            if(note) note.textContent=d.unavailable ? d.unavailable + (d.unavailable === 1 ? ' running container has no metrics' : ' running containers have no metrics') : '';
            // Update metrics and sort attributes without reordering. Flash changed values briefly.
            function setTxt(el, v) {
              if (el.textContent === v) return;
              el.textContent = v;
              el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
            }
            document.querySelectorAll('.t-ctr[data-cid]').forEach(function(r){
              var s = m[r.dataset.cid];
              if (!s) {
                if (r.dataset.state === 'running') r.querySelectorAll('.cpu,.mem,.rst,.net,.disk').forEach(function(el){ if(el.textContent==='·') el.textContent='-'; });
                return;
              }
              r.dataset.cpu = s.cpu; r.dataset.mem = s.mem;
              if (s.restarts != null) r.dataset.restarts = s.restarts;
            });
            document.querySelectorAll('.cpu[data-cid]').forEach(function(el){
              var s = m[el.dataset.cid]; if (!s) return;
              setTxt(el, s.cpu.toFixed(1) + '%');
              // Mark high CPU usage.
              el.classList.toggle('hot', s.cpu >= 80);
            });
            document.querySelectorAll('.mem[data-cid]').forEach(function(el){
              var s = m[el.dataset.cid]; if (!s) return;
              // Display memory bytes and expose the percentage in the title.
              if (s.memLimit) { setTxt(el, fb(s.memUsed) + '/' + fb(s.memLimit)); el.title = s.mem.toFixed(1) + '%'; }
              else setTxt(el, s.mem.toFixed(1) + '%');
            });
            // Display network and disk bytes on separate lines.
            document.querySelectorAll('.net[data-cid]').forEach(function(el){ var s = m[el.dataset.cid]; if (s && s.net) el.innerHTML = '<span class="d">&#8595;'+fb(s.net.rx)+'</span> <span class="u">&#8593;'+fb(s.net.tx)+'</span>'; });
            document.querySelectorAll('.disk[data-cid]').forEach(function(el){ var s = m[el.dataset.cid]; if (s && s.disk) el.innerHTML = '<span class="d">r '+fb(s.disk.read)+'</span> <span class="u">w '+fb(s.disk.write)+'</span>'; });
            // Render zero restarts as a dash.
            document.querySelectorAll('.rst[data-cid]').forEach(function(el){
              var s = m[el.dataset.cid]; if (!s) return;
              var n = typeof s.restarts === 'number' ? s.restarts : null;
              el.textContent = n ? n : '-';
              el.classList.toggle('warm', !!n);
              el.classList.toggle('faint', !n);
            });
            drawDetail();
          }).catch(function(){
            var note=document.getElementById('cnote'); if(note) note.textContent='Live metrics unavailable';
            document.querySelectorAll('.cpu[data-cid],.mem[data-cid],.rst[data-cid]').forEach(function(el){ if(el.textContent==='·') el.textContent='-'; });
          });
        }
        poll(); setInterval(poll, 5000);

        var panel = document.getElementById('detail'), table = document.querySelector('.ctable2'), detailOpener = null;
        function sel(name) { return '.t-ctr[data-name="' + String(name).replace(/[^a-zA-Z0-9_.-]/g, '') + '"]'; }
        function openDetail(row) {
          var wasOpen = panel.classList.contains('open');
          if (!wasOpen) detailOpener = document.activeElement;
          open = row.dataset.cid;
          document.querySelectorAll('.t-ctr.sel').forEach(function (r) { r.classList.remove('sel'); });
          row.classList.add('sel');
          document.getElementById('d-logo').innerHTML = row.querySelector('.logo') ? row.querySelector('.logo').outerHTML : '';
          document.getElementById('d-name').textContent = row.dataset.name;
          var sc = row.querySelector('.state');
          document.getElementById('d-state').innerHTML = sc ? sc.outerHTML : '';
          document.getElementById('d-image').textContent = row.dataset.image;
          var upstreamRow = document.getElementById('d-upstream-row'), upstream = document.getElementById('d-upstream');
          upstreamRow.hidden = !row.dataset.upstream;
          if (row.dataset.upstream) upstream.href = row.dataset.upstream; else upstream.removeAttribute('href');
          document.getElementById('d-ip').textContent = row.dataset.ip || 'None';
          document.getElementById('d-ports').textContent = row.dataset.ports || 'None';
          document.getElementById('d-stack').textContent = row.dataset.stack || 'None';
          document.getElementById('d-health').textContent = row.dataset.health || (row.dataset.state === 'running' ? 'No health check' : 'Health not reported');
          document.getElementById('d-status').textContent = row.dataset.status || 'Not available';
          document.getElementById('d-console').href = '/console?id=' + encodeURIComponent(open);
          panel.removeAttribute('inert');
          panel.setAttribute('aria-hidden', 'false');
          panel.classList.add('open');
          loadInspect(open);
          syncDetail();
          drawDetail();
          if (!wasOpen) document.getElementById('d-close').focus();
        }
        function closeDetail() {
          open = null; panel.classList.remove('open'); panel.setAttribute('inert', ''); panel.setAttribute('aria-hidden', 'true');
          document.querySelectorAll('.t-ctr.sel').forEach(function (r) { r.classList.remove('sel'); });
          if (detailOpener && detailOpener.isConnected && typeof detailOpener.focus === 'function') detailOpener.focus();
          detailOpener = null;
        }

        // Tab switches are local; inspection data is fetched once.
        panel.querySelectorAll('.d-tab').forEach(function (t) {
          t.addEventListener('click', function () {
            panel.querySelectorAll('.d-tab').forEach(function (x) { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
            panel.querySelectorAll('.d-pane').forEach(function (p) { p.classList.toggle('hidden', p.dataset.dpane !== t.dataset.dtab); });
          });
        });

        // Fetch inspection data once. Only allowlisted configuration values reach the client.
        var COPYICON = ${jsafe(I.copy)};
        var inspCache = {};
        function dNote(host, text) {
          host.textContent = '';
          var s = document.createElement('span');
          s.className = 'd-wait';
          s.textContent = text;
          host.appendChild(s);
        }
        function iconBtn(icon, label) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'iconbtn d-ibtn';
          b.innerHTML = icon;
          b.title = label;
          b.setAttribute('aria-label', label);
          return b;
        }
        function envRow(host, name, value, hidden) {
          var row = document.createElement('div');
          row.className = 'd-envrow';
          var k = document.createElement('span'); k.className = 'd-ek'; k.textContent = name;
          var v = document.createElement('span'); v.className = 'd-ev';
          row.appendChild(k); row.appendChild(v);
          if (hidden) {
            // The value remains server-side and is not available to reveal on this page.
            v.classList.add('faint'); v.textContent = 'hidden';
            var b = document.createElement('span'); b.className = 'badge line'; b.textContent = 'server-held';
            b.title = 'Not sent to this page. Revealing this value will need re-authentication.';
            row.appendChild(b);
            host.appendChild(row);
            return;
          }
          if (!value) { v.classList.add('faint'); v.textContent = 'empty'; host.appendChild(row); return; }
          v.textContent = value;
          var cp = iconBtn(COPYICON, 'Copy the value of ' + name);
          cp.addEventListener('click', function () {
            if (navigator.clipboard && window.isSecureContext) {
              navigator.clipboard.writeText(value).then(function () { cnote.textContent = 'Copied ' + name; })
                .catch(function () { cnote.textContent = 'The browser refused the copy.'; });
            } else cnote.textContent = 'Copying needs a secure context.';
          });
          row.appendChild(cp);
          host.appendChild(row);
        }
        function kvRow(host, label, value) {
          var row = document.createElement('div'); row.className = 'kv';
          var k = document.createElement('span'); k.textContent = label;
          var v = document.createElement('b'); v.textContent = value;
          row.appendChild(k); row.appendChild(v);
          host.appendChild(row);
        }
        function paintInspect(d, why) {
          var envs = document.getElementById('d-envs'), mounts = document.getElementById('d-mounts');
          var labels = document.getElementById('d-labels'), limits = document.getElementById('d-limits');
          envs.textContent = ''; mounts.textContent = ''; labels.textContent = ''; limits.textContent = '';
          // Populate all inspection tabs from one request.
          if (!d) {
            var gone = why === '404';
            var line = gone
              ? 'Container not found. Reload the page for the current list.'
              : 'Configuration unavailable' + (why ? ' (Docker returned ' + why + ')' : '') + '. Logs and status are unchanged. Close and reopen this panel to retry.';
            dNote(envs, line);
            dNote(mounts, line);
            dNote(labels, line);
            dNote(limits, gone ? 'Not read: the container is gone.' : 'Not read.');
            return;
          }
          if (!d.env.length) dNote(envs, 'None');
          d.env.forEach(function (e) { envRow(envs, e.name, e.value, e.secret); });
          if (!d.mounts.length) dNote(mounts, 'None');
          d.mounts.forEach(function (m) {
            var row = document.createElement('div'); row.className = 'd-mountrow';
            var src = document.createElement('span'); src.className = 'd-ev d-src'; src.textContent = m.source; src.title = m.source;
            var arr = document.createElement('span'); arr.className = 'd-arrow'; arr.textContent = '\\u2192';
            var dst = document.createElement('span'); dst.className = 'd-ev d-src'; dst.textContent = m.target; dst.title = m.target;
            row.appendChild(src); row.appendChild(arr); row.appendChild(dst);
            if (m.ro) { var ro = document.createElement('span'); ro.className = 'badge line'; ro.textContent = 'ro'; row.appendChild(ro); }
            mounts.appendChild(row);
          });
          if (!d.labels.length) dNote(labels, 'None');
          d.labels.forEach(function (l) { envRow(labels, l.k, l.v, l.secret); });
          kvRow(limits, 'CPU limit', d.limits.cpus ? d.limits.cpus + ' CPUs' : 'Unlimited');
          kvRow(limits, 'Memory limit', d.limits.memBytes ? fb(d.limits.memBytes) : 'Unlimited');
          kvRow(limits, 'Restart policy', d.limits.restart + (d.limits.maxRetries ? ' (max ' + d.limits.maxRetries + ')' : ''));
          kvRow(limits, 'Network mode', d.limits.networkMode);
        }
        // Keep reads available for stale rows, but remove writes after Docker reports 404.
        var goneIds = {};
        function loadInspect(id) {
          if (inspCache[id]) { paintInspect(inspCache[id]); return; }
          dNote(document.getElementById('d-envs'), 'Fetching');
          dNote(document.getElementById('d-mounts'), 'Fetching');
          dNote(document.getElementById('d-labels'), 'Fetching');
          dNote(document.getElementById('d-limits'), 'Fetching');
          fetch('/api/containers/inspect?id=' + encodeURIComponent(id))
            .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
            .then(function (d) { inspCache[id] = d; if (open === id) paintInspect(d); })
            .catch(function (err) {
              var why = String((err && err.message) || '');
              if (why === '404') { goneIds[id] = 1; syncDetail(); }
              if (open === id) paintInspect(null, why);
            });
        }
        // Delegate row events so refreshed rows remain interactive.
        table.addEventListener('click', function (e) {
          if (e.target.closest('button, a, input')) return;
          var row = e.target.closest('.t-ctr:not(.th)');
          if (row) openDetail(row);
        });
        // The detail button performs the same action as the row.
        table.addEventListener('click', function (e) {
          var eye = e.target.closest('.ct-eye');
          if (!eye) return;
          e.stopPropagation();
          var row = eye.closest('.t-ctr');
          if (row) openDetail(row);
        });
        document.getElementById('d-close').addEventListener('click', closeDetail);
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });
        // Activity links select by name; other callers may use a container ID.
        var want = new URLSearchParams(location.search).get('sel');
        if (want) {
          var wanted = want.replace(/[^a-zA-Z0-9_.-]/g, '');
          var r = document.querySelector('.t-ctr[data-cid="' + wanted + '"]') || document.querySelector('.t-ctr[data-name="' + wanted + '"]');
          if (r) openDetail(r);
        }

        var q = document.getElementById('csearch'), st = document.getElementById('cstatus');
        var empty = document.getElementById('cempty'), count = document.getElementById('ccount');
        function apply() {
          var term = (q.value || '').toLowerCase(), sv = st.value, shown = 0, total = 0;
          document.querySelectorAll('.t-ctr:not(.th)').forEach(function (r) {
            var stateMatches = !sv || (sv === 'inactive' ? r.dataset.state !== 'running' && r.dataset.state !== 'paused'
              : sv === 'unhealthy' ? r.dataset.health === 'unhealthy'
                : sv === 'updates' ? r.dataset.update === '1'
                  : r.dataset.state === sv);
            var ok = (!term || r.dataset.find.indexOf(term) >= 0) && stateMatches;
            r.style.display = ok ? '' : 'none'; if (ok) shown++;
            total++;
          });
          count.textContent = shown;
          // Distinguish a filter miss from a list emptied by actions.
          empty.textContent = (term || sv)
            ? 'Nothing matches that filter.'
            : 'No containers left on this page. Reload to check that against Docker.';
          empty.classList.toggle('hidden', shown > 0);
          // Hide Prune when the page has no rows.
          var prune = document.getElementById('cprune');
          if (prune) prune.classList.toggle('hidden', total === 0);
        }
        q.addEventListener('input', apply); st.addEventListener('change', apply);
        // Initialize the count and empty state after listeners are attached.
        apply();
        // Apply a recognized state filter from the query string.
        var preset = new URLSearchParams(location.search).get('state');
        if (preset) { st.value = preset; apply(); }

        // Refresh by name to preserve current UI state.
        function swapRows(names, doc) {
          names.forEach(function (name) {
            var live = document.querySelector(sel(name));
            if (!live) return;
            var next = doc.querySelector(sel(name));
            var was = live.classList.contains('sel');
            ${control ? `// Preserve row selection.
            var box = live.querySelector('.rowsel'), ticked = !!(box && box.checked);` : ''}
            if (!next) { live.remove(); return; }
            live.replaceWith(next);
            ${control ? `var nbox = next.querySelector('.rowsel');
            if (nbox && ticked) nbox.checked = true;` : ''}
            if (was) openDetail(next);
          });
          // Reapply the saved layout and keyboard behavior to refreshed rows.
          if (window.qmGrid) qmGrid.refresh(table);
          stampRows();
          apply();
          ${control ? 'syncSel();' : ''}
        }
        function refreshRows(names) {
          return fetch('/containers', { headers: { accept: 'text/html' } })
            .then(function (r) { return r.text(); })
            .then(function (txt) { swapRows(names, new DOMParser().parseFromString(txt, 'text/html')); })
            .catch(function () { cnote.textContent = 'the rows could not be refreshed - reload to be sure'; });
        }
        function refreshRow(name) { return refreshRows([name]); }

        // Refresh stale update results on the cache interval.
        var chk = document.getElementById('chkupd'), upsum = document.getElementById('upsum'), cnote = document.getElementById('cnote');
        var updall = document.getElementById('updall'), updcluster = document.getElementById('updcluster');
        var pending = [], byRef = {}, checkedAt = 0, cacheMs = 45 * 60 * 1000, timer = null;
        function syncDetail() {
          var row = open && document.querySelector('.t-ctr[data-cid="' + open + '"]');
          var available = !!(row && row.dataset.update === '1');
          var protectedRow = !!(row && row.dataset.protected === '1');
          var missing = !!(open && goneIds[open]);
          var actionable = available && !protectedRow && !missing;
          // Mirror update-check progress in the workspace header.
          var note = document.getElementById('d-upnote');
          if (note) note.classList.toggle('hidden', !actionable);
          var du = document.getElementById('d-update');
          if (du) du.classList.toggle('hidden', !actionable);
          var dr = document.getElementById('d-restart');
          if (dr) dr.classList.toggle('hidden', protectedRow || missing);
          var guard = document.getElementById('d-guard');
          if (guard) guard.classList.toggle('hidden', !protectedRow);
          var goneNote = document.getElementById('d-gone');
          if (goneNote) goneNote.classList.toggle('hidden', !missing);
        }
        function stampRows() {
          pending = [];
          // Separate protected containers from dismissible update references.
          var held = [], dismissable = [];
          var cur = 0, upd = 0, unk = 0, dis = 0;
          document.querySelectorAll('.t-ctr:not(.th)').forEach(function (r) {
            var s = byRef[r.dataset.image];
            var flagged = s && s.status === 'update' && !s.dismissed;
            if (flagged) {
              upd++;
              if (dismissable.indexOf(r.dataset.image) < 0) dismissable.push(r.dataset.image);
              if (r.dataset.protected === '1') {
                if (held.indexOf(r.dataset.name) < 0) held.push(r.dataset.name);
              } else if (pending.indexOf(r.dataset.name) < 0) pending.push(r.dataset.name);
            }
            else if (s && s.status === 'update') dis++;
            else if (s && s.status === 'current') cur++;
            else unk++;
            r.dataset.update = flagged ? '1' : '';
            var chip = r.querySelector('.upflag'); if (chip) chip.classList.toggle('hidden', !flagged);
            var dash = r.querySelector('.updash'); if (dash) dash.classList.toggle('hidden', flagged);
            var ub = r.querySelector('.ct-update'); if (ub) ub.classList.toggle('hidden', !flagged);
          });
          // Report current, pending, unknown, and dismissed update counts separately.
          if (checkedAt) {
            var mins = Math.round((Date.now() - checkedAt) / 60000);
            upsum.textContent = cur + ' up to date, ' + upd + (upd === 1 ? ' update, ' : ' updates, ') + unk + ' unknown'
              + (dis ? ', ' + dis + ' dismissed' : '') + ' \\u00b7 '
              + (mins < 1 ? 'just checked' : 'checked ' + mins + 'm ago');
          }
          if (updcluster) {
            // Update controls for the current filter.
            updcluster.classList.toggle('hidden', pending.length === 0 && dismissable.length === 0);
            if (updall) updall.classList.toggle('hidden', pending.length === 0);
            var n = document.getElementById('updn'); if (n) n.textContent = pending.length;
          }
          // Companion updates require an external Compose recreate.
          var self = document.getElementById('updself');
          if (self) {
            self.textContent = '';
            if (held.length) {
              self.appendChild(document.createTextNode(held.join(', ') + (held.length === 1 ? ' runs' : ' run')
                + ' the panel, so it will not update ' + (held.length === 1 ? 'it' : 'them') + ' from inside itself. On the server: '));
              var cmd = document.createElement('code');
              cmd.className = 'mono';
              cmd.textContent = 'docker compose -f docker-compose.example.yml up -d --pull always';
              self.appendChild(cmd);
              self.appendChild(document.createTextNode(', repeating every -f file this install already starts with, in the same order.'));
            }
          }
          // Keep the navigation update count synchronized without changing health status.
          var nf = document.getElementById('navfig');
          if (nf && nf.getAttribute('data-kind') !== 'bad') {
            nf.className = 'nav-fig warn' + (upd ? '' : ' hidden');
            nf.innerHTML = '<i></i>' + upd;
          }
          // Reapply the active updates filter as results arrive.
          if (st.value === 'updates') apply();
          syncDetail();
        }
        function take(d) {
          (d.results || []).forEach(function (x) { byRef[x.image] = { status: x.status, dismissed: !!x.dismissed }; });
          if (d.cacheMs) cacheMs = d.cacheMs;
          if (d.checkedAt) checkedAt = d.checkedAt;
          stampRows();
        }
        function later(ms) { clearTimeout(timer); timer = setTimeout(function () { check(false); }, Math.max(60000, ms)); }
        function check(force) {
          chk.disabled = true;
          return fetch('/api/updates' + (force ? '?refresh=1' : ''))
            .then(function (r) { if (!r.ok) throw new Error('updates'); return r.json(); })
            .then(function (d) { chk.disabled = false; take(d); later(cacheMs); })
            .catch(function () { chk.disabled = false; cnote.textContent = 'Image update check unavailable'; later(cacheMs); });
        }
        fetch('/api/updates?cached=1').then(function (r) { return r.json(); }).then(function (d) {
          take(d);
          var refs = {};
          document.querySelectorAll('.t-ctr:not(.th)').forEach(function (r) { refs[r.dataset.image] = 1; });
          var blank = Object.keys(refs).some(function (k) { return byRef[k] === undefined; });
          var age = checkedAt ? Date.now() - checkedAt : cacheMs;
          if (blank || age >= cacheMs) check(false); else later(cacheMs - age);
        }).catch(function () { check(false); });
        chk.addEventListener('click', function () { cnote.textContent = ''; check(true); });
        var csrf2 = document.querySelector('meta[name=csrf]').content;
        function post(path, body) {
          return fetch(path, { method: 'POST', headers: { 'x-csrf-token': csrf2, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
            .then(function (r) { return r.json(); });
        }
        // Recheck only this image reference. This read is available in read-only mode.
        table.addEventListener('click', function (e) {
          var chip = e.target.closest('.upflag');
          if (!chip) return;
          e.stopPropagation();
          chip.disabled = true;
          post('/api/updates/check', { ref: chip.dataset.ref }).then(function (d) {
            chip.disabled = false;
            if (!d.result) { cnote.textContent = d.error || 'the re-check failed'; return; }
            byRef[d.result.image] = { status: d.result.status, dismissed: !!d.result.dismissed };
            checkedAt = Date.now();
            stampRows();
          }).catch(function () { chip.disabled = false; cnote.textContent = 'could not reach the server'; });
        });
        ${control ? `var VERB = { start: 'Start', stop: 'Stop', restart: 'Restart', pause: 'Pause', unpause: 'Resume' };
        var ASKS = {
          start: 'Start it with the settings it already has?',
          stop: 'Stop it now? Anything it serves goes offline until it is started again.',
          restart: 'Stop it and start it again? Anything it serves is offline for a moment.',
          pause: 'Pause every process in this container?',
          unpause: 'Resume every process in this container?',
        };
        // Stream each update step to show progress for long pulls.
        function runUpdate(ops, name, id) {
          ops.set(name + '/head', { state: 'active', label: 'Update ' + name, note: 'starting' });
          return qmStream('/containers/' + id + '/update', {}, function (e) {
            ops.set(name + '/' + e.id, { state: e.state, label: e.label, note: e.note, mono: e.mono, pct: e.pct });
          }).then(function (d) {
            ops.set(name + '/head', { state: d.ok ? 'ok' : 'fail', label: 'Update ' + name, note: d.note || (d.ok ? 'done' : 'failed') });
            return refreshRow(name).then(function () {
              // Recheck the registry after a pull so the cached update flag can clear.
              if (d.ok) {
                var r = document.querySelector('.t-ctr[data-cid="' + id + '"]');
                var ref = r && r.dataset.image;
                if (ref) return post('/api/updates/check', { ref: ref }).then(function (res) {
                  if (res && res.result) byRef[res.result.image] = { status: res.result.status, dismissed: !!res.result.dismissed };
                  else delete byRef[ref];
                  stampRows();
                  return d;
                }).catch(function () { delete byRef[ref]; stampRows(); return d; });
              }
              return d;
            });
          });
        }
        function askUpdate(name, id) {
          return qmConfirm({
            title: 'Update ' + name,
            what: 'Pull the newer image and recreate this container on it?',
            detail: ['It is stopped, recreated with the same settings and started again. The old container is kept as ', { c: name + '__old' }, ' until the new one is up, so a failure rolls back.'],
            confirmLabel: 'Update',
          }).then(function (yes) {
            if (!yes) return null;
            return runUpdate(qmToast('Update ' + name).ops, name, id);
          });
        }
        // Container deletion always requires confirmation and lists its effects.
        function askRemove(name, id, row) {
          qmConfirm({
            title: 'Delete ' + name, danger: true, confirmLabel: 'Delete',
            what: 'Remove this container from the host?',
            detail: ['Its writable layer goes too, so anything ', { c: name }, ' wrote outside a volume is lost. The image and its volumes stay. Docker refuses while it is still running.'],
          }).then(function (yes) {
            if (!yes) return;
            var t = qmToast('Delete ' + name);
            t.ops.set('d', { state: 'active', label: 'Removing ' + name, note: 'working' });
            fetch('/containers/' + id + '/remove', { method: 'POST', headers: { 'x-csrf-token': csrf2 } })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                t.ops.set('d', { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'removed' : 'failed') });
                if (!d.ok) return;
                row.remove();
                apply();
                syncSel();
                if (open === id) closeDetail();
              }).catch(function () { t.ops.set('d', { state: 'fail', note: 'could not reach the server' }); });
          });
        }
        table.addEventListener('click', function (e) {
          var b = e.target.closest('button[data-action], button.ct-update');
          if (!b) return;
          e.stopPropagation();
          var row = b.closest('.t-ctr');
          if (!row) return;
          var name = row.dataset.name, id = row.dataset.cid;
          if (b.classList.contains('ct-update')) { askUpdate(name, id); return; }
          var act = b.dataset.action;
          if (act === 'remove') { askRemove(name, id, row); return; }
          qmConfirm({ pref: true, title: VERB[act] + ' ' + name, what: ASKS[act], confirmLabel: VERB[act] }).then(function (yes) {
            if (!yes) return;
            b.disabled = true;
            fetch('/containers/' + id + '/' + act, { method: 'POST', headers: { 'x-csrf-token': csrf2 } })
              .then(function (response) { return response.json().catch(function () { return {}; }).then(function (body) { return { response: response, body: body }; }); })
              .then(function (result) {
                if (!result.response.ok || !result.body.ok) {
                  cnote.textContent = result.body.note || result.body.error || 'Docker refused that action.';
                  b.disabled = false;
                  return null;
                }
                cnote.textContent = result.body.note || '';
                return refreshRow(name);
              })
              .catch(function () { cnote.textContent = 'could not reach the server'; b.disabled = false; });
          });
        });

        // Selection controls: header checkbox, shift-click ranges, and bulk actions.
        var selall = document.getElementById('selall'), selchip = document.getElementById('selchip');
        var selcount = document.getElementById('selcount'), lastBox = null;
        function boxes() { return Array.prototype.slice.call(document.querySelectorAll('.t-ctr:not(.th) .rowsel')); }
        function picked() {
          return boxes().filter(function (b) { return b.checked; }).map(function (b) { return b.closest('.t-ctr'); });
        }
        function syncSel() {
          var rows = picked();
          var rail = document.getElementById('bulkrail');
          if (rail) rail.classList.toggle('hidden', rows.length === 0);
          selcount.textContent = rows.length;
          var all = boxes();
          selall.checked = all.length > 0 && rows.length === all.length;
          selall.indeterminate = rows.length > 0 && rows.length < all.length;
        }
        table.addEventListener('click', function (e) {
          var box = e.target.closest('.rowsel');
          if (!box) return;
          var all = boxes();
          if (e.shiftKey && lastBox && lastBox !== box) {
            var a = all.indexOf(lastBox), b2 = all.indexOf(box);
            if (a >= 0 && b2 >= 0) {
              var from = Math.min(a, b2), to = Math.max(a, b2);
              for (var i = from; i <= to; i++) all[i].checked = box.checked;
            }
          }
          lastBox = box;
          syncSel();
        });
        selall.addEventListener('change', function () {
          // Header selection applies only to visible rows.
          boxes().forEach(function (b) {
            var row = b.closest('.t-ctr');
            if (row.style.display !== 'none') b.checked = selall.checked;
          });
          syncSel();
        });
        document.getElementById('selclear').addEventListener('click', function () {
          boxes().forEach(function (b) { b.checked = false; });
          lastBox = null;
          syncSel();
        });

        // Run bulk actions sequentially and report progress per container.
        var BULK_ASKS = {
          start: ['Start each selected container with the settings it already has?', ''],
          stop: ['Stop every selected container?', 'Anything they serve goes offline until they are started again.'],
          restart: ['Stop and start every selected container?', 'Anything they serve is offline for a moment.'],
          pause: ['Pause every process in the selected containers?', ''],
        };
        function bulkLifecycle(verb, rows) {
          var names = rows.map(function (r) { return r.dataset.name; });
          var t = qmToast(VERB[verb] + ' ' + names.length + (names.length === 1 ? ' container' : ' containers'));
          var i = 0, bad = 0;
          (function next() {
            if (i >= rows.length) {
              t.ops.set('zz', { state: bad ? 'fail' : 'ok', label: 'Finished', note: bad ? bad + ' of ' + rows.length + ' refused' : 'all ' + rows.length + ' done' });
              refreshRows(names);
              return;
            }
            var row = rows[i++], name = row.dataset.name;
            t.ops.set(name, { state: 'active', label: VERB[verb] + ' ' + name, note: 'working' });
            fetch('/containers/' + row.dataset.cid + '/' + verb, { method: 'POST', headers: { 'x-csrf-token': csrf2 } })
              .then(function (r) { return r.json().catch(function () { return {}; }); })
              .then(function (d) {
                if (!d.ok) bad++;
                t.ops.set(name, { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'done' : 'refused') });
                next();
              })
              .catch(function () { bad++; t.ops.set(name, { state: 'fail', note: 'could not reach the server' }); next(); });
          })();
        }
        function bulkUpdate(rows) {
          var t = qmToast('Update ' + rows.length + (rows.length === 1 ? ' container' : ' containers'));
          var i = 0, bad = 0;
          (function next() {
            if (i >= rows.length) {
              t.ops.set('zz', { state: bad ? 'fail' : 'ok', label: 'Finished', note: bad ? bad + ' of ' + rows.length + ' failed' : 'all ' + rows.length + ' done' });
              return;
            }
            var row = rows[i++];
            runUpdate(t.ops, row.dataset.name, row.dataset.cid).then(function (d) { if (!d || !d.ok) bad++; next(); });
          })();
        }
        function bulkDelete(rows) {
          var t = qmToast('Delete ' + rows.length + (rows.length === 1 ? ' container' : ' containers'));
          var i = 0, bad = 0;
          (function next() {
            if (i >= rows.length) {
              t.ops.set('zz', { state: bad ? 'fail' : 'ok', label: 'Finished', note: bad ? bad + ' of ' + rows.length + ' refused' : 'all ' + rows.length + ' removed' });
              apply();
              syncSel();
              return;
            }
            var row = rows[i++], name = row.dataset.name;
            t.ops.set(name, { state: 'active', label: 'Delete ' + name, note: 'working' });
            fetch('/containers/' + row.dataset.cid + '/remove', { method: 'POST', headers: { 'x-csrf-token': csrf2 } })
              .then(function (r) { return r.json().catch(function () { return {}; }); })
              .then(function (d) {
                if (d.ok) { row.remove(); if (open === row.dataset.cid) closeDetail(); } else bad++;
                t.ops.set(name, { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'removed' : 'refused') });
                next();
              })
              .catch(function () { bad++; t.ops.set(name, { state: 'fail', note: 'could not reach the server' }); next(); });
          })();
        }
        document.querySelectorAll('.bulkv').forEach(function (b) {
          b.addEventListener('click', function () {
            var rows = picked();
            if (!rows.length) return;
            var names = rows.map(function (r) { return r.dataset.name; }).join(', ');
            var verb = b.dataset.verb;
            if (verb === 'delete') {
              qmConfirm({
                title: 'Delete ' + rows.length + (rows.length === 1 ? ' container' : ' containers'), danger: true, confirmLabel: 'Delete ' + rows.length,
                what: 'Remove every selected container from the host?',
                detail: ['One after the other: ' + names + '. Writable layers go with them; images and volumes stay. Docker refuses any that are still running.'],
              }).then(function (yes) { if (yes) bulkDelete(rows); });
              return;
            }
            if (verb === 'update') {
              qmConfirm({
                title: 'Update ' + rows.length + (rows.length === 1 ? ' container' : ' containers'),
                what: 'Pull the newer image for each one and recreate it?',
                detail: ['They go one after the other: ' + names + '. Each old container is kept until its replacement is up, so a failure rolls back.'],
                confirmLabel: 'Update ' + rows.length,
              }).then(function (yes) { if (yes) bulkUpdate(rows); });
              return;
            }
            qmConfirm({
              pref: true, title: VERB[verb] + ' ' + rows.length + (rows.length === 1 ? ' container' : ' containers'),
              what: BULK_ASKS[verb][0],
              detail: [BULK_ASKS[verb][1] ? BULK_ASKS[verb][1] + ' ' : '', 'One after the other: ' + names + '.'],
              confirmLabel: VERB[verb],
            }).then(function (yes) { if (yes) bulkLifecycle(verb, rows); });
          });
        });

        updall.addEventListener('click', function () {
          if (!pending.length) return;
          var rows = pending.map(function (name) { return document.querySelector(sel(name)); }).filter(Boolean);
          qmConfirm({
            title: 'Update ' + rows.length + (rows.length === 1 ? ' container' : ' containers'),
            what: 'Pull the newer image for each one and recreate it?',
            detail: ['They go one after the other: ' + rows.map(function (r) { return r.dataset.name; }).join(', ') + '. Each old container is kept until its replacement is up.'],
            confirmLabel: 'Update ' + rows.length,
          }).then(function (yes) { if (yes) bulkUpdate(rows); });
        });
        document.getElementById('upddis').addEventListener('click', function () {
          var refs = [];
          document.querySelectorAll('.t-ctr:not(.th)').forEach(function (r) {
            var s = byRef[r.dataset.image];
            if (s && s.status === 'update' && !s.dismissed && refs.indexOf(r.dataset.image) < 0) refs.push(r.dataset.image);
          });
          if (!refs.length) return;
          post('/api/updates/dismiss', { refs: refs }).then(function (d) {
            take(d);
            cnote.textContent = 'Dismissed until the image digest changes.';
          }).catch(function () { cnote.textContent = 'could not reach the server'; });
        });
        document.getElementById('cprune').addEventListener('click', function () {
          qmConfirm({
            title: 'Prune stopped containers', danger: true, confirmLabel: 'Prune',
            what: 'Remove every container that is not running?',
            detail: ['Their writable layers go with them, so anything a stopped container wrote outside a volume is lost. Images and volumes are left alone.'],
          }).then(function (yes) {
            if (!yes) return;
            var t = qmToast('Prune stopped containers');
            t.ops.set('p', { state: 'active', label: 'Removing stopped containers', note: 'working' });
            fetch('/containers/prune', { method: 'POST', headers: { 'x-csrf-token': csrf2 } })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                t.ops.set('p', { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'done' : 'failed') });
                if (d.ok) t.reloadOnClose();
              }).catch(function () { t.ops.set('p', { state: 'fail', note: 'could not reach the server' }); });
          });
        });
        var dr = document.getElementById('d-restart');
        if (dr) dr.addEventListener('click', function () {
          if (!open) return;
          var row = document.querySelector('.t-ctr[data-cid="' + open + '"]');
          if (!row) return;
          qmConfirm({ pref: true, title: 'Restart ' + row.dataset.name, what: ASKS.restart, confirmLabel: 'Restart' }).then(function (yes) {
            if (!yes) return;
            dr.disabled = true;
            fetch('/containers/' + row.dataset.cid + '/restart', { method: 'POST', headers: { 'x-csrf-token': csrf2 } })
              .then(function () { return refreshRow(row.dataset.name); })
              .catch(function () { cnote.textContent = 'could not reach the server'; })
              .then(function () { dr.disabled = false; });
          });
        });
        var du2 = document.getElementById('d-update');
        if (du2) du2.addEventListener('click', function () {
          if (!open) return;
          var row = document.querySelector('.t-ctr[data-cid="' + open + '"]');
          if (row) askUpdate(row.dataset.name, row.dataset.cid);
        });
        var dn2 = document.getElementById('d-upnote');
        if (dn2) dn2.addEventListener('click', function () {
          if (!open) return;
          var row = document.querySelector('.t-ctr[data-cid="' + open + '"]');
          if (row) askUpdate(row.dataset.name, row.dataset.cid);
        });
        syncSel();` : ''}
      })();
    </script>`);
}
