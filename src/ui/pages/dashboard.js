import { escapeHtml } from '../../http.js';
import { config } from '../../config.js';
import { availabilityFor, dockerStateWord } from '../../availability.js';
import { dockerAccessState } from '../../docker-access.js';
import { labelFor, schemeFor, PORTS, pairingCredentialState } from '../../kinds.js';
import { ARR_KINDS, DL_KINDS } from '../../live.js';
import { I, ESC_FN, badge, tag, state, credentialTag, EVENT_ICON, jsafe, stackClass } from '../bits.js';
import { board, shell } from '../chrome.js';
import { gridHeader, gridOpen, gridClose } from '../columns.js';

function addressFor(d) {
  if (d.url) return d.url;
  if (!config.qmHost) return `port ${d.port || PORTS[d.kind] || ''}`;
  return `${schemeFor(d.kind)}://${config.qmHost}:${d.port || PORTS[d.kind] || ''}`;
}

// Use the shared service-availability classification.
function availabilityOf(d) {
  return typeof d?.availability === 'string' && d.availability ? d.availability : availabilityFor(d || {});
}

function credentialOf(d) {
  return d.credentialState || pairingCredentialState(d.kind, d.apiKey, d.credentialConflict);
}

const plural = (n) => (n === 1 ? '' : 's');

// Stopped services are neutral; running but unreachable services are warnings.
function statusTag(d) {
  const availability = availabilityOf(d);
  if (availability === 'reachable') return state('ok', 'Reachable');
  if (availability === 'unreachable') return state('warn', 'Unreachable');
  if (availability === 'not-running') return state('off', dockerStateWord(d.dockerState));
  return state('', 'Not checked');
}

// A service is included only when both availability and credential state allow it.
function tally(detected) {
  const t = { reachable: 0, unreachable: 0, stopped: 0, unchecked: 0, included: 0, optional: 0, setup: 0, signIn: 0, conflict: 0, heldBack: 0 };
  for (const service of detected) {
    const availability = availabilityOf(service);
    if (availability === 'reachable') t.reachable += 1;
    else if (availability === 'unreachable') t.unreachable += 1;
    else if (availability === 'not-running') t.stopped += 1;
    else t.unchecked += 1;
    const credential = credentialOf(service);
    if (credential === 'included') {
      if (availability === 'reachable') t.included += 1;
      else t.heldBack += 1;
    } else if (credential === 'not-required') t.optional += 1;
    else if (credential === 'conflict') t.conflict += 1;
    else if (credential === 'sign-in') t.signIn += 1;
    else t.setup += 1;
  }
  return t;
}

// Hold credentials back when their service is not included in the hand-over.
function pairingCell(service, availability) {
  if (credentialOf(service) === 'included' && availability !== 'reachable') return tag('line', 'Key held back');
  return credentialTag(service);
}

// Show a distinct service kind below the label.
function kindSub(kind) {
  const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return flat(kind) === flat(labelFor(kind)) ? '' : `<small>${escapeHtml(kind)}</small>`;
}

function nowPlaying(now) {
  if (!now || now.length === 0) return '';
  const cards = now.map((s) => `
    <div class="np">
      <span class="np-dot ${s.paused ? 'paused' : ''}"></span>
      <div class="np-txt"><b>${escapeHtml(s.title || 'Untitled')}</b><span>${escapeHtml(s.user || '')} · ${escapeHtml(s.service)}${s.paused ? ' · paused' : ''}</span></div>
    </div>`).join('');
  return `<section class="panel qm-media-panel"><div class="p-h">Now playing</div><div class="nowplay">${cards}</div></section>`;
}

function mediaStack(detected, arr) {
  const stackKinds = new Set([...ARR_KINDS, ...DL_KINDS]);
  const svcs = detected.filter((d) => stackKinds.has(d.kind));
  if (svcs.length === 0) return '';

  const rows = Array.isArray(arr) ? arr : [];
  const haveData = rows.some((a) => a.queue != null || a.warnings != null);
  const queue = rows.reduce((n, a) => n + (typeof a.queue === 'number' ? a.queue : 0), 0);
  const warnings = rows.reduce((n, a) => n + (typeof a.warnings === 'number' ? a.warnings : 0), 0);

  const health = !haveData ? ''
    : warnings ? tag('warn', `${warnings} warning${warnings > 1 ? 's' : ''}`, 'alert')
      : tag('ok', 'No warnings', 'check');

  // Explain missing credentials separately from stopped or unreachable services.
  const stopped = svcs.filter((s) => availabilityOf(s) === 'not-running');
  const unreachable = svcs.filter((s) => availabilityOf(s) === 'unreachable');
  const keyless = svcs.filter((s) => !s.apiKey && credentialOf(s) !== 'not-required');
  const notes = [];
  if (stopped.length) {
    notes.push(stopped.length === 1
      ? `${escapeHtml(labelFor(stopped[0].kind))} is ${dockerStateWord(stopped[0].dockerState).toLowerCase()}, so it reports no queue and no warnings. Start it in Docker, then reload this page.`
      : `${stopped.length} of these are not running, so they report no queue and no warnings. Start them in Docker, then reload this page.`);
  }
  if (unreachable.length) {
    notes.push(`Companion could not reach ${unreachable.length === 1 ? 'one of these' : `${unreachable.length} of these`} from inside its own container, so ${unreachable.length === 1 ? 'its' : 'their'} figures are missing. A different Docker network, host networking or a VPN can do that.`);
  }
  if (!haveData && keyless.length) {
    notes.push(`Queue and warnings need an API key for ${keyless.length === 1 ? escapeHtml(labelFor(keyless[0].kind)) : `${keyless.length} of these`}. <a href="/pair">Add one under Phone setup</a>.`);
  }
  if (!haveData && !notes.length) {
    notes.push('Companion has an address and a key for these, but neither queue nor warnings answered.');
  }

  const chips = svcs.map((s) => `<span class="sc-chip${availabilityOf(s) === 'reachable' ? '' : ' off'}">${badge(s.kind, labelFor(s.kind))}${escapeHtml(labelFor(s.kind))}</span>`).join('');

  return `
    <section class="panel qm-media-panel">
      <div class="sc-head"><div class="sc-title">Media services<span class="sc-sub">${svcs.length} detected</span></div>${health}</div>
      <div class="sc-metrics">
        <div><b>${haveData ? queue : '?'}</b><span>in queue</span></div>
        <div><b class="${warnings ? 'warn' : haveData ? 'up' : ''}">${haveData ? warnings : '?'}</b><span>warnings</span></div>
        <div><b>${svcs.length}</b><span>services</span></div>
      </div>
      <div class="sc-chips">${chips}</div>
      ${notes.map((note) => `<div class="sc-note">${note}</div>`).join('')}
    </section>`;
}

function stackSnapshot(containers, connected) {
  if (!Array.isArray(containers)) {
    if (!connected) return '';
    const note = String(config.dockerHost).startsWith('tcp:')
      ? 'Docker did not return the container list, so stacks cannot be grouped. Set <code class="mono">CONTAINERS: 1</code> on <code class="mono">qm-socket-proxy</code>, then bring the stack back up with the same compose command and the same <code class="mono">-f</code> overlays you started it with.'
      : 'Docker did not return the container list, so stacks cannot be grouped. The other Docker figures on this page are still live.';
    return `<section class="panel dash-stacks"><div class="p-h"><span class="p-title"><small>Compose</small>Stacks</span></div><div class="dash-stack-list"><span class="dk-load">${note}</span></div></section>`;
  }
  const grouped = new Map();
  for (const container of containers) {
    if (!container.stack) continue;
    if (!grouped.has(container.stack)) grouped.set(container.stack, { name: container.stack, total: 0, running: 0, unhealthy: 0 });
    const row = grouped.get(container.stack);
    row.total += 1;
    if (container.state === 'running') row.running += 1;
    if (container.health === 'unhealthy') row.unhealthy += 1;
  }
  const stacks = [...grouped.values()].sort((a, b) => b.unhealthy - a.unhealthy || a.name.localeCompare(b.name));
  if (!stacks.length) return '';
  const rows = stacks.slice(0, 5).map((row) => {
    const tone = row.unhealthy ? 'bad' : row.running === row.total ? 'ok' : row.running ? 'warn' : 'off';
    const label = row.unhealthy ? `${row.unhealthy} unhealthy` : row.running === row.total ? 'Running' : row.running ? `${row.running}/${row.total} running` : 'Stopped';
    const pct = row.total ? Math.round((row.running / row.total) * 100) : 0;
    return `<a class="dash-stack-row" href="/stacks#${encodeURIComponent(row.name)}">
      <span class="dash-stack-icon ${stackClass(row.name)}">${I.stack}</span>
      <span class="dash-stack-name"><b>${escapeHtml(row.name)}</b><small>${row.total} container${row.total === 1 ? '' : 's'}</small></span>
      <span class="dash-stack-progress"><i style="width:${pct}%"></i></span>
      ${state(tone, label)}
      ${I.chev}
    </a>`;
  }).join('');
  return `<section class="panel dash-stacks"><div class="p-h"><span class="p-title"><small>Compose</small>Stacks</span><span class="count-tag">${stacks.length}</span><a class="p-more" href="/stacks">View all</a></div><div class="dash-stack-list">${rows}</div></section>`;
}

function recentEventsList(events) {
  if (!events || events === 'blocked' || !events.length) return '';
  const ago = (t) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h`;
  };
  const rows = events.slice(0, 8).map((e) => {
    const base = (e.action || '').split(':')[0];
    const [ico, cls] = EVENT_ICON[base] || ['pulse', 'ec'];
    const name = e.name || e.type || '';
    const label = cls === 'ec bad' ? `<span class="slip">${escapeHtml(base)} · ${escapeHtml(name)}</span>` : escapeHtml(name);
    return `<div class="ev-row"><span class="ev-t">${escapeHtml(ago(e.time))}</span><span class="${cls}">${I[ico]}</span><span class="ev-name">${label}</span></div>`;
  }).join('');
  return `<div class="ev-list">${rows}</div>`;
}

// Readiness requires a service to be running, reachable, and credential-ready.
function phoneSetup(detected, t) {
  if (!detected.length) return '';
  const leftOut = t.stopped + t.unreachable;
  const tone = t.conflict ? 'blocked' : t.setup || leftOut ? 'action' : 'ready';
  const title = t.conflict
    ? `${t.conflict} credential conflict${plural(t.conflict)} need${t.conflict === 1 ? 's' : ''} review`
    : t.setup
      ? `${t.setup} service${plural(t.setup)} need${t.setup === 1 ? 's' : ''} setup before the scan`
      : t.reachable === 0
        ? 'Nothing is reachable to hand over yet'
        : leftOut
          ? `${t.reachable} service${plural(t.reachable)} ready, ${leftOut} left out`
          : 'Ready to create a setup code';
  const guidance = t.stopped && t.unreachable
    ? 'Start what is stopped, and check the network to what Companion cannot reach.'
    : t.stopped
      ? `Start ${t.stopped === 1 ? 'it' : 'them'} in Docker, then reload this page.`
      : 'Companion probes from inside its own container, so a different Docker network, host networking or a VPN can hide a service your phone can reach. The set-up page can include one anyway.';
  const detail = leftOut
    ? `Available credentials are included in the encrypted setup. ${leftOut} service${plural(leftOut)} ${leftOut === 1 ? 'is' : 'are'} not confirmed running and reachable. ${guidance}`
    : 'Available credentials are included in the encrypted setup.';
  const action = t.conflict || t.setup || t.reachable === 0 ? 'Review setup' : 'Create setup code';
  return `<section class="phone-setup ${tone}">
    <span class="phone-mark">${I.link}</span>
    <div class="phone-copy"><span>Phone setup</span><b>${escapeHtml(title)}</b><small>${escapeHtml(detail)}</small></div>
    <div class="phone-facts">
      <span><b>${t.included}</b> included in scan</span>
      <span><b>${t.optional}</b> no key required</span>
      ${t.setup ? `<span class="warn"><b>${t.setup}</b> need${t.setup === 1 ? 's' : ''} setup</span>` : ''}
      ${t.signIn ? `<span><b>${t.signIn}</b> to sign in after pairing</span>` : ''}
      ${t.conflict ? `<span class="bad"><b>${t.conflict}</b> conflict${plural(t.conflict)}</span>` : ''}
      ${t.heldBack ? `<span class="warn"><b>${t.heldBack}</b> with keys, not confirmed reachable</span>` : ''}
    </div>
    <a class="btn primary" href="/pair">${action}${I.arrowR}</a>
  </section>`;
}

// Health and update totals.
function healthLine(c) {
  const checks = c.healthy + c.unhealthy + (c.starting || 0);
  if (c.unhealthy) return `<span class="state bad"><i></i>${c.unhealthy} unhealthy</span><span class="rib-note">across ${checks} reported health checks</span>`;
  if (c.starting) return `<span class="state warn"><i></i>${c.starting} health check${c.starting === 1 ? '' : 's'} starting</span><span class="rib-note">across ${checks} reporting containers</span>`;
  if (c.healthy) return `<span class="state ok"><i></i>Health checks passing</span><span class="rib-note">across ${checks} reporting containers</span>`;
  return '<span class="state off"><i></i>No health checks reporting</span>';
}

function updatesLine(u) {
  if (!u) return '<span class="state off"><i></i>No update check yet</span>';
  const mins = Math.round((Date.now() - u.at) / 60000);
  const when = mins < 1 ? 'just checked' : `checked ${mins}m ago`;
  if (u.count) return `<span class="state warn"><i></i>${u.count} update${u.count === 1 ? '' : 's'} available</span><span class="rib-note">${escapeHtml(when)}</span>`;
  return `<span class="state ok"><i></i>No known updates</span><span class="rib-note">${escapeHtml(when)}</span>`;
}

// Select Docker recovery guidance from the configured proxy or socket transport.
function dockerDownNote() {
  const host = String(config.dockerHost || '');
  if (/^tcp:\/\//i.test(host)) {
    const authority = host.slice(6).split('/')[0];
    const bare = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
    const service = /^[a-z][a-z0-9_-]*$/i.test(bare) && bare.toLowerCase() !== 'localhost' ? bare : '';
    if (!service) return `Nothing is answering at <code class="mono">${escapeHtml(host)}</code>. <code class="mono">DOCKER_HOST</code> points there, so check that address from this container.`;
    return `Nothing is answering at <code class="mono">${escapeHtml(host)}</code>. Start <code class="mono">${escapeHtml(service)}</code> with <code class="mono">docker compose -f docker-compose.example.yml up -d ${escapeHtml(service)}</code>. Include the same <code class="mono">-f</code> overlays in the same order.`;
  }
  const path = host.replace(/^unix:\/\//, '') || '/var/run/docker.sock';
  return `No Docker socket at <code class="mono">${escapeHtml(path)}</code>. Mount <code class="mono">- ${escapeHtml(path)}:${escapeHtml(path)}:ro</code> on the companion service, then run <code class="mono">docker compose -f docker-compose.example.yml up -d companion</code>. Include the same <code class="mono">-f</code> overlays in the same order.`;
}

function environmentPanel(docker) {
  const connected = !!(docker && docker.counts);
  const access = dockerAccessState();
  const mode = access.mode === 'read' ? 'Read-only visibility' : `${access.label} enabled`;
  const transport = String(config.dockerHost).startsWith('tcp:') ? 'through the socket proxy' : 'through the local socket';
  const connection = connected
    ? `<span class="state ok"><i></i>Docker connected</span><small>${mode} ${transport}.</small>`
    : `<span class="state bad"><i></i>Docker unavailable</span><small>${dockerDownNote()}</small>`;
  return `<section class="panel dash-environment">
    <div class="de-identity"><span class="de-icon">${I.server}</span><div><span>Environment</span><b>${escapeHtml(config.qmTitle)}</b><small class="mono">${escapeHtml(config.qmHost || 'localhost')}</small></div></div>
    <div class="de-connection">${connection}</div>
    <div class="de-actions"><span class="badge line">${escapeHtml(access.shortLabel)}</span><a href="/settings">Environment settings${I.arrowR}</a></div>
  </section>`;
}

function metricCard({ href, icon, label, value, key, detail, tone = '', toneKey = '' }) {
  const live = key ? ` data-count="${key}"` : '';
  // Keep the status colour with its live value.
  const toned = toneKey ? ` data-tone="${toneKey}"` : '';
  const body = `<span class="dm-head"><span class="dm-icon ${tone}"${toned}>${I[icon]}</span><span>${escapeHtml(label)}</span></span>
    <b class="dm-value${tone ? ` ${tone}` : ''}"${live}${toned}>${value == null ? '·' : value}</b>
    <small>${detail}</small>`;
  return href ? `<a class="panel dash-metric" href="${href}">${body}</a>` : `<section class="panel dash-metric">${body}</section>`;
}

function environmentMetrics(docker) {
  if (!docker || !docker.counts) {
    return `<section class="panel dash-unavailable" id="ribbon">
      <div class="docker-notice"><span>${I.slash}</span><div><b>Container figures unavailable</b><small>Check the Docker connection above. Service discovery and phone setup remain available.</small></div></div>
    </section>`;
  }
  const c = docker.counts;
  const u = docker.updates || null;
  const inactive = Math.max(0, c.total - c.running);
  const restarting = c.restarting || 0;
  return `<div id="ribbon" class="dash-overview">
    <div class="dash-metrics">
      ${metricCard({ href: '/containers', icon: 'box', label: 'Containers', value: c.total, key: 'total', detail: `<span data-count="running-detail">${c.running}</span> active · <span data-count="inactive">${inactive}</span> inactive` })}
      ${metricCard({ href: '/containers?state=running', icon: 'play', label: 'Running', value: c.running, key: 'running', detail: `<span data-count="paused-detail">${c.paused}</span> paused · <span data-count="restarting-detail">${restarting}</span> restarting · <span data-count="unhealthy-detail">${c.unhealthy}</span> unhealthy`, tone: c.running ? 'ok' : '', toneKey: 'running' })}
      ${metricCard({ icon: 'cpu', label: 'Container CPU', value: '<span data-live="cpu">Collecting</span>', detail: '<span data-live="cpu-detail">100% is one core busy</span>', tone: 'accent' })}
      ${metricCard({ icon: 'mem', label: 'Container memory', value: '<span data-live="mem">Collecting</span>', detail: 'Running share of host RAM', tone: 'teal' })}
      ${metricCard({ icon: 'temp', label: 'Temperatures', value: '<span data-live="temp">Collecting</span>', detail: '<span data-live="temp-detail">Reading host sensors</span>', tone: 'warn' })}
    </div>
    <section class="panel dash-healthline"><span class="rib-fact" id="rib-health">${healthLine(c)}</span><span class="rib-fact" id="rib-updates">${updatesLine(u)}</span><span class="grow"></span><a href="/containers">Open containers${I.arrowR}</a></section>
  </div>`;
}

// Main workspace and right rail.
function hostBand(docker) {
  if (!docker || !docker.counts) return '';
  const i = docker.info || {};
  const events = docker.events;
  const activity = events === 'blocked'
    ? '<span class="dk-load">Activity is unavailable through the socket proxy.</span>'
    : recentEventsList(events) || '<span class="dk-load">No Docker activity in the last 24 hours.</span>';
  const n = (v) => (v == null ? '' : escapeHtml(String(v)));
  return `<div class="band2 dash-workspace">
    <section class="panel hostload">
      <div class="p-h"><span class="p-title"><small>Live workload</small>Performance</span>
        <span class="hl-now"><span>CPU <b data-live="cpu">Collecting</b></span><span>Memory <b data-live="mem">Collecting</b></span></span>
        <span class="r" id="env-chart-state">Collecting samples</span>
      </div>
      <svg class="hl-chart" viewBox="0 0 600 160" preserveAspectRatio="none" aria-label="CPU and memory history">
        <line class="grid-line" x1="0" y1="40" x2="600" y2="40"/>
        <line class="grid-line" x1="0" y1="80" x2="600" y2="80"/>
        <line class="grid-line" x1="0" y1="120" x2="600" y2="120"/>
        <path class="mem-line" id="env-big-mem" d=""/>
        <path class="cpu-line" id="env-big-cpu" d=""/>
      </svg>
      <div class="chart-legend"><span><i style="background:var(--accent)"></i>CPU</span><span><i style="background:var(--teal)"></i>Memory</span></div>
      <div class="hl-top">
        <div class="hl-top-h">Top containers by CPU</div>
        <div class="dk-list" id="env-top"><span class="dk-load">Collecting samples</span></div>
      </div>
    </section>
    <div class="band2-col">
      <section class="panel diskcard">
        <div class="p-h"><span class="p-title"><small>Docker objects</small>Storage footprint</span><span class="r" id="ds-total"></span></div>
        <div id="disk" class="disk" data-images="${n(i.images)}" data-volumes="${n(i.volumes)}" data-networks="${n(i.networks)}"><span class="dk-load">Collecting Docker storage</span></div>
        ${dockerAccessState().canManage ? `<button class="btn" id="prune-build" type="button">Clear build cache</button>` : ''}
      </section>
      <section class="panel actcard">
        <div class="p-h"><span class="p-title"><small>Docker events</small>Recent activity</span>${Array.isArray(events) && events.length ? '<a class="p-more" href="/activity">View all</a>' : ''}</div>
        <div id="dash-events">${activity}</div>
      </section>
    </div>
  </div>`;
}

// Poll stats-only metrics; use live topics for counts, updates, and events.
function dashScript(docker) {
  if (!docker || !docker.counts) return '';
  const eicon = {};
  for (const [k, [ico, cls]] of Object.entries(EVENT_ICON)) eicon[k] = [I[ico], cls];
  return `<script>
      (function () {
        ${ESC_FN}
        var EICON=${jsafe(eicon)}, EDEF=${jsafe([I.pulse, 'ec'])};
        function fmt(n){ if(!n) return '0 B'; var u=['B','KB','MB','GB','TB'],j=0; while(n>=1024&&j<u.length-1){n/=1024;j++;} return (n<10&&j>0?n.toFixed(1):Math.round(n))+' '+u[j]; }
        function txt(id,value){ var el=document.getElementById(id); if(el) el.textContent=value; }
        function live(name,value){ document.querySelectorAll('[data-live="'+name+'"]').forEach(function(el){el.textContent=value;}); }
        function count(name,value){ document.querySelectorAll('[data-count="'+name+'"]').forEach(function(el){el.textContent=value;}); }
      // Keep status colour in sync with the value.
        function tone(name,on){ document.querySelectorAll('[data-tone="'+name+'"]').forEach(function(el){el.classList.toggle('ok',!!on);}); }
        var cpuHistory=[],memoryHistory=[];
        function areaPath(values,width,height,max,limit){
          if(!values.length) return '';
          var step=width/Math.max(limit-1,1);
          var points=values.map(function(value,index){ var y=height-3-Math.min(1,value/max)*(height-10); return (index*step).toFixed(1)+','+y.toFixed(1); });
          var end=((values.length-1)*step).toFixed(1);
          return 'M0,'+height+' L'+points.join(' L')+' L'+end+','+height+' Z';
        }
        function draw(){
          var max=Math.max(20,Math.max.apply(null,cpuHistory.concat(memoryHistory,[1]))*1.15);
          document.getElementById('env-big-cpu').setAttribute('d',areaPath(cpuHistory,600,160,max,90));
          document.getElementById('env-big-mem').setAttribute('d',areaPath(memoryHistory,600,160,max,90));
        }
        function drawDisk(disk){
          var host=document.getElementById('disk');
          if(!host) return;
          if(!disk){ host.innerHTML='<span class="dk-load">Docker storage unavailable</span>'; return; }
          var counts={ images: host.dataset.images, volumes: host.dataset.volumes, networks: host.dataset.networks };
          var parts=[['Images',disk.images,'a','/images',counts.images],['Containers',disk.containers,'b','/containers',''],['Volumes',disk.volumes,'c','/volumes',counts.volumes],['Build cache',disk.build,'d','','']];
          var total=disk.total||1,r=43,circumference=2*Math.PI*r,offset=0;
          var segments='<circle class="r-track" cx="52" cy="52" r="'+r+'" fill="none" stroke-width="9"/>'+parts.map(function(part){
            var fraction=Math.max(0.004,part[1]/total),length=fraction*circumference;
            var item='<circle class="r-'+part[2]+'" cx="52" cy="52" r="'+r+'" fill="none" stroke-width="9" stroke-dasharray="'+length.toFixed(2)+' '+(circumference-length).toFixed(2)+'" stroke-dashoffset="'+(-offset).toFixed(2)+'" transform="rotate(-90 52 52)"/>';
            offset+=length; return item;
          }).join('');
          // Include resource counts and links in the legend.
          var legend=parts.map(function(part){
            var inner='<span class="ds-dot"></span>'+part[0]+(part[4]!==''&&part[4]!=null?'<span class="ds-n">'+esc(part[4])+'</span>':'')+'<span class="ds-sz">'+fmt(part[1])+'</span>';
            return part[3] ? '<a class="ds-row ds-'+part[2]+'" href="'+part[3]+'">'+inner+'</a>' : '<div class="ds-row ds-'+part[2]+'">'+inner+'</div>';
          }).join('');
          if(counts.networks!==''&&counts.networks!=null) legend+='<a class="ds-row ds-x" href="/networks"><span class="ds-dot"></span>Networks<span class="ds-n">'+esc(counts.networks)+'</span></a>';
          txt('ds-total',fmt(disk.total));
          host.innerHTML='<div class="ring-wrap"><div class="ring"><svg viewBox="0 0 104 104">'+segments+'</svg><div class="r-mid"><div><b>'+fmt(disk.total)+'</b><span>accounted</span></div></div></div><div class="ds-legend">'+legend+'</div></div>';
        }
        function poll(){
          fetch('/api/docker/stats').then(function(response){ if(!response.ok) throw new Error('stats'); return response.json(); }).then(function(data){
            if(data.cpu!=null){
              var cores=(data.cores&&data.cores>0)?data.cores:0;
              var hostCpu=cores?data.cpu/cores:data.cpu;
              cpuHistory.push(hostCpu);
              live('cpu',(cores?hostCpu.toFixed(0):data.cpu.toFixed(1))+'%');
              live('cpu-detail',cores?((data.cpu/100).toFixed(1)+' of '+cores+' cores in use'):'100% is one core busy');
            }
            if(data.mem!=null){ memoryHistory.push(data.mem); live('mem',data.mem.toFixed(1)+'%'); }
            if(cpuHistory.length>90){ cpuHistory.shift(); memoryHistory.shift(); }
            if(data.temps&&data.temps.cpuC!=null){
              live('temp',data.temps.cpuC+'\u00B0C');
              var tparts=[];
              if(data.temps.driveC!=null) tparts.push((data.temps.driveCount>1?data.temps.driveCount+' drives up to ':'Drive ')+data.temps.driveC+'\u00B0C');
              if(data.temps.boardC!=null) tparts.push('Board '+data.temps.boardC+'\u00B0C');
              live('temp-detail',tparts.length?tparts.join(' \u00B7 '):'CPU package');
            } else {
              live('temp','Unavailable'); live('temp-detail','No host sensors exposed');
            }
            if(data.cpu==null||data.mem==null){
              live('cpu','Unavailable'); live('mem','Unavailable'); txt('env-chart-state','Container metrics unavailable');
            } else {
              txt('env-chart-state',data.metricsUnavailable ? data.metricsUnavailable+' running container'+(data.metricsUnavailable===1?'':'s')+' unavailable' : 'Live samples since page opened');
              draw();
            }
            var list=document.getElementById('env-top');
            if(list){
              if(data.top&&data.top.length){ list.innerHTML=data.top.map(function(item){ var cpu=Math.max(0,Math.min(100,item.cpu)); var mem=item.mem==null?'-':item.mem.toFixed(1)+'%'; return '<div class="dk-row"><span class="dk-name">'+esc(item.name)+'</span><span class="dk-bar"><i style="width:'+cpu.toFixed(0)+'%"></i></span><span class="dk-val">'+item.cpu.toFixed(1)+'%</span><span class="dk-val dim">'+mem+'</span></div>'; }).join(''); }
              else list.innerHTML=data.cpu==null?'<span class="dk-load">Container metrics unavailable</span>':'<span class="dk-load">No running containers.</span>';
            }
            var disk=document.getElementById('disk'); if(disk&&!disk.dataset.done){ disk.dataset.done='1'; drawDisk(data.disk); }
          }).catch(function(){
            live('cpu','Unavailable'); live('mem','Unavailable'); txt('env-chart-state','Live metrics unavailable');
            var list=document.getElementById('env-top'); if(list) list.innerHTML='<span class="dk-load">Container metrics unavailable</span>';
            var disk=document.getElementById('disk'); if(disk&&!disk.dataset.done) disk.innerHTML='<span class="dk-load">Docker storage unavailable</span>';
          });
        }
        function healthHtml(c){
          var checks=(c.healthy||0)+(c.unhealthy||0)+(c.starting||0);
          if(c.unhealthy) return '<span class="state bad"><i></i>'+c.unhealthy+' unhealthy</span><span class="rib-note">across '+checks+' reported health checks</span>';
          if(c.starting) return '<span class="state warn"><i></i>'+c.starting+' health check'+(c.starting===1?'':'s')+' starting</span><span class="rib-note">across '+checks+' reporting containers</span>';
          if(c.healthy) return '<span class="state ok"><i></i>Health checks passing</span><span class="rib-note">across '+checks+' reporting containers</span>';
          return '<span class="state off"><i></i>No health checks reporting</span>';
        }
        function drawCounts(c){
          count('running',c.running||0); count('total',c.total||0);
          count('running-detail',c.running||0); count('paused-detail',c.paused||0); count('restarting-detail',c.restarting||0);
          count('unhealthy-detail',c.unhealthy||0);
          count('inactive',Math.max(0,(c.total||0)-(c.running||0)));
          tone('running',(c.running||0)>0);
          var health=document.getElementById('rib-health'); if(health) health.innerHTML=healthHtml(c);
        }
        function updatesHtml(u){
          var at=u&&(u.checkedAt||u.at), n=u&&(u.updateCount!=null?u.updateCount:u.count);
          if(!at) return '<span class="state off"><i></i>No update check yet</span>';
          var mins=Math.round((Date.now()-at)/60000), when=mins<1?'just checked':'checked '+mins+'m ago';
          if(n) return '<span class="state warn"><i></i>'+n+' update'+(n===1?'':'s')+' available</span><span class="rib-note">'+esc(when)+'</span>';
          return '<span class="state ok"><i></i>No known updates</span><span class="rib-note">'+esc(when)+'</span>';
        }
        function drawUpdates(u){ var host=document.getElementById('rib-updates'); if(host) host.innerHTML=updatesHtml(u); }
        function ago(t){ var s=Math.max(0,Math.floor(Date.now()/1000-t)); if(s<60) return s+'s'; var m=Math.floor(s/60); if(m<60) return m+'m'; return Math.floor(m/60)+'h'; }
        function drawEvents(list){
          var host=document.getElementById('dash-events'); if(!host||!Array.isArray(list)) return;
          if(!list.length){ host.innerHTML='<span class="dk-load">No Docker activity in the last 24 hours.</span>'; return; }
          host.innerHTML='<div class="ev-list">'+list.slice(0,8).map(function(e){
            var base=String(e.action||'').split(':')[0];
            var pair=EICON[base]||EDEF;
            var name=e.name||e.type||'';
            var label=pair[1]==='ec bad'?'<span class="slip">'+esc(base)+' \\u00b7 '+esc(name)+'</span>':esc(name);
            return '<div class="ev-row"><span class="ev-t">'+esc(ago(e.time))+'</span><span class="'+pair[1]+'">'+pair[0]+'</span><span class="ev-name">'+label+'</span></div>';
          }).join('')+'</div>';
        }
        var pruneBuild=document.getElementById('prune-build');
        if(pruneBuild) pruneBuild.addEventListener('click', function(){
          qmConfirm({
            title: 'Clear the build cache', danger: true, confirmLabel: 'Clear',
            what: 'Remove every cached build layer?',
            detail: ['The next image build starts from scratch. Images, containers and volumes are untouched.'],
          }).then(function(yes){
            if(!yes) return;
            var t=qmToast('Clear the build cache');
            t.ops.set('p',{ state: 'active', label: 'Clearing the build cache', note: 'working' });
            fetch('/images/prune',{ method: 'POST', headers: { 'x-csrf-token': document.querySelector('meta[name=csrf]').content, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'build' }) })
              .then(function(r){ return r.json(); })
              .then(function(d){ t.ops.set('p',{ state: d.ok?'ok':'fail', note: d.note||d.error||(d.ok?'done':'failed') }); })
              .catch(function(){ t.ops.set('p',{ state: 'fail', note: 'could not reach the server' }); });
          });
        });
        // Start live updates after the shared runtime loads.
        window.addEventListener('DOMContentLoaded', function(){
          if(window.qmLive){
            qmLive({ topics: ['counts','events','updates'], always: true, fallbackPoll: poll, fallbackMs: 5000,
              onmessage: function(topic,data){ if(topic==='counts') drawCounts(data); else if(topic==='events') drawEvents(data); else if(topic==='updates') drawUpdates(data); } });
          } else { poll(); setInterval(poll, 5000); }
        });
      })();
    </script>`;
}

// QM_HOST changes service addresses, not service detection.
function noServices(docker) {
  const dir = `<code class="mono">${escapeHtml(config.stackDir)}</code>`;
  const counts = docker && docker.counts;
  const total = counts ? counts.total : 0;
  const looked = counts
    ? `Docker returned ${total} container${plural(total)}, with no recognised service or config under ${dir}.`
    : `Docker is unavailable and no recognised service config was found under ${dir}.`;
  const fix = `Mount service config files under ${dir}, or set <code class="mono">QM_STACK</code> to their mounted location. Recreate Companion with your usual Compose command, repeating every <code class="mono">-f</code> overlay in the same order.`;
  return `<div class="empty first-run"><b>No services detected</b><span>${looked}</span><span>${fix}</span><a class="btn" href="/settings">Open settings${I.arrowR}</a></div>`;
}

export function dashboardPage(detected, live, docker, csrf) {
  const t = tally(detected);
  const checked = t.reachable + t.unreachable + t.stopped;
  const connected = !!(docker && docker.counts);
  const meta = { host: config.qmHost || 'localhost', count: detected.length, online: checked ? t.reachable : null };
  const rows = detected.map((service) => {
    const address = addressFor(service);
    const availability = availabilityOf(service);
    const pairing = credentialOf(service);
    // Suppress links for stopped services; browser reachability may differ for other states.
    const route = /^https?:\/\//i.test(address) && availability !== 'not-running'
      ? `<a class="service-route mono" href="${escapeHtml(address)}" target="_blank" rel="noopener">${escapeHtml(address)}${I.arrowR}</a>`
      : `<span class="addr mono">${escapeHtml(address)}</span>`;
    return `<div class="tr t-svc svc-row ${availability === 'reachable' ? 'is-online' : `is-${availability}`}" data-state="${escapeHtml(availability)}" data-service="${escapeHtml(labelFor(service.kind))}" data-route="${escapeHtml(address)}" data-pairing="${escapeHtml(pairing)}">
      <div class="td" data-col="state">${statusTag(service)}</div>
      <div class="td svc-main" data-col="service">${badge(service.kind, labelFor(service.kind))}<div class="svc">${escapeHtml(labelFor(service.kind))}${kindSub(service.kind)}</div></div>
      <div class="td" data-col="route">${route}</div>
      <div class="td kcell" data-col="pairing">${pairingCell(service, availability)}</div>
    </div>`;
  }).join('');
  const table = detected.length
    ? `${gridOpen('services', { tableClass: 'svc-table' })}${gridHeader('services', { rowClass: 't-svc' })}${rows}${gridClose()}`
    : noServices(docker);
  // Assign one availability state per service.
  const facts = [`<span>${t.reachable} reachable</span>`];
  if (t.unreachable) facts.push(`<span class="warn-text">${t.unreachable} unreachable</span>`);
  if (t.stopped) facts.push(`<span>${t.stopped} not running</span>`);
  if (t.unchecked) facts.push(`<span>${t.unchecked} not checked</span>`);
  facts.push(`<span>${t.included} included in scan</span>`);
  const serviceFacts = facts.join('');
  const mediaParts = [mediaStack(detected, live && live.arr), nowPlaying(live && live.now)].filter(Boolean);
  const contextParts = [stackSnapshot(docker && docker.containers, connected), ...mediaParts].filter(Boolean);

  return shell('dash', csrf, meta, `
    ${board('dash', 'Dashboard', '', meta)}
    ${environmentPanel(docker)}
    ${phoneSetup(detected, t)}
    ${environmentMetrics(docker)}
    ${contextParts.length ? `<div class="dash-context${contextParts.length === 1 ? ' single' : ''}">${contextParts.join('')}</div>` : ''}
    ${hostBand(docker)}
    <div class="section-head"><div><span>Connections</span><h2>Services</h2></div><div class="section-facts">${serviceFacts}<span data-grid-gear></span></div></div>
    ${table}
    ${dashScript(docker)}`);
}
