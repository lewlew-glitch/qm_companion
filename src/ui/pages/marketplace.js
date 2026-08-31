import { escapeHtml } from '../../http.js';
import { config } from '../../config.js';
import { pairingCredentialState } from '../../kinds.js';
import { MARKETPLACE_CATEGORIES, listMarketplace, marketplacePresentation, reviewedStarterCompose } from '../../marketplace.js';
import { templateCompose, templateProjectUrl } from '../../templates.js';
import { I, badge, tag, jsafe, fmtWhen, lintPanel, LINT_FN, FOCUS_FN, metaOf } from '../bits.js';
import { board, shell } from '../chrome.js';

export function composeStarter(kind) {
  return reviewedStarterCompose(kind);
}

// Template-entry key used by the modal catalogue.
const entryKey = (si, ei) => `src-${si}-${ei}`;

// Keep suggested names valid when Docker appends the "_default" network suffix.
export const STACK_NAME_MAX = 33;
export function suggestedStack(entry) {
  const raw = String(entry.name || entry.title || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  if (!/^[a-z0-9]/.test(raw)) return '';
  return raw.slice(0, STACK_NAME_MAX).replace(/[-_]+$/, '');
}

// Only expose state filters represented by a card on the current page.
const PLANE_LABELS = [
  ['ready', 'Ready for scan'],
  ['attention', 'Needs setup'],
  ['deploy', 'Available to deploy'],
  ['preview', 'Details and previews'],
  ['community', 'Community'],
];

function sourceCompose(entry) {
  if (entry.type === 1) return templateCompose(entry);
  return typeof entry.yaml === 'string' && entry.yaml ? entry.yaml : null;
}

function actionIcon(name) {
  return I[name] || I.list;
}

function cardChips(categories) {
  return (categories || []).slice(0, 3)
    .map((category) => `<span class="market-category-chip">${escapeHtml(category)}</span>`)
    .join('');
}

function projectLink(url, label, name) {
  if (!url) return '';
  return `<a class="market-project" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(name)} ${escapeHtml(label.toLowerCase())}">${I.external}${escapeHtml(label)}</a>`;
}

function marketplaceCard(card) {
  const view = card.presentation;
  return `
    <article class="market-card" data-market-card data-category="${escapeHtml(card.categoryId || '')}" data-source="${escapeHtml(card.sourceId)}" data-plane="${escapeHtml(view.filter)}" data-find="${escapeHtml(card.find.toLowerCase())}">
      <div class="market-card-head">${badge(card.kind, card.label, card.fallback)}<div class="market-card-title"><b>${escapeHtml(card.label)}</b><span>${escapeHtml(card.sourceLabel)}</span></div></div>
      <p>${escapeHtml(card.description)}</p>
      <div class="market-card-tags">${cardChips(card.categories)}${tag(view.badgeTone, view.badgeLabel, view.badgeIcon)}</div>
      <div class="market-card-foot"><button class="market-card-open market-open${view.primary ? ' primary' : ''}" type="button" data-kind="${escapeHtml(card.key)}">${actionIcon(view.actionIcon)}${escapeHtml(view.actionLabel)}</button>${projectLink(card.projectUrl, card.projectLabel, card.label)}</div>
    </article>`;
}

export function cataloguePage(detected, control, csrf, sources = [], tab = 'catalogue', dockerReachable = Array.isArray(detected)) {
  const dockerKnown = dockerReachable === true;
  const detectedRows = Array.isArray(detected) ? detected : [];
  const credentialStates = new Map();
  for (const service of detectedRows) {
    if (!service || !service.kind) continue;
    const kind = String(service.kind).toLowerCase();
    const state = service.credentialState || pairingCredentialState(kind, service.apiKey, service.credentialConflict);
    credentialStates.set(kind, [...(credentialStates.get(kind) || []), state]);
  }
  const entries = listMarketplace({ detectedKinds: detectedRows }).map((entry) => ({
    ...entry,
    presentation: marketplacePresentation(entry, {
      control,
      detectionKnown: dockerKnown,
      credentialStates: credentialStates.get(entry.kind) || [],
    }),
  }));
  const starterCount = entries.filter((entry) => entry.hasStarter).length;
  const sourceEntryCount = sources.reduce((count, source) => count + source.entries.length, 0);
  const totalCards = entries.length + sourceEntryCount;
  const catalogueCountLabel = `${totalCards} shown`;
  const starterCountLabel = `${starterCount} starters`;
  const sourceCountLabel = `${sources.length} source${sources.length === 1 ? '' : 's'}`;
  const sourceEntryCountLabel = `${sourceEntryCount} ${sourceEntryCount === 1 ? 'entry' : 'entries'}`;
  const categoryOptions = MARKETPLACE_CATEGORIES.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.label)}</option>`).join('');
  const cardPlanes = new Set();
  const cards = entries.map((entry) => {
    const view = entry.presentation;
    cardPlanes.add(view.filter);
    return marketplaceCard({
      key: entry.kind,
      kind: entry.kind,
      label: entry.label,
      description: entry.description,
      categoryId: entry.category,
      categories: [entry.categoryLabel],
      sourceId: 'builtin',
      sourceLabel: 'Built in',
      projectUrl: entry.upstreamUrl,
      projectLabel: 'Project',
      presentation: view,
      find: `${entry.kind} ${entry.label} ${entry.description} ${entry.categoryLabel} ${view.badgeLabel} built in`,
    });
  }).join('');

  // Community templates share the browse grid but retain their source and review status.
  const sourceCards = sources.map((source, si) => source.entries.map((entry, ei) => {
      const yaml = sourceCompose(entry);
      const view = marketplacePresentation({ hasStarter: !!yaml }, { community: true, hasStarter: !!yaml, control, detectionKnown: dockerKnown });
      cardPlanes.add(view.filter);
      const upstream = templateProjectUrl(entry);
      return marketplaceCard({
        key: entryKey(si, ei),
        kind: '',
        fallback: 'template',
        label: entry.title,
        description: entry.description || 'No description in the template.',
        categoryId: '',
        categories: entry.categories && entry.categories.length ? entry.categories : ['Community template'],
        sourceId: `src-${si}`,
        sourceLabel: source.name,
        projectUrl: upstream || source.url,
        projectLabel: upstream ? 'Project' : 'Source',
        presentation: view,
        find: `${entry.title} ${entry.description || ''} ${(entry.categories || []).join(' ')} ${source.name} ${view.badgeLabel}`,
      });
    }).join('')).join('');

  const modeNote = !dockerKnown
    ? '<span class="market-mode warn">Docker is unavailable. Detection and deployment are disabled.</span>'
    : control
      ? '<span class="market-mode warn">Management is active. Every deployment still starts with a review.</span>'
      : '<span class="market-mode">Read-only Docker mode. Preview, copy and download remain available.</span>';

  const planeOptions = PLANE_LABELS
    .filter(([id]) => cardPlanes.has(id))
    .map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join('');
  const planeSelect = cardPlanes.size > 1
    ? `<select id="market-plane" class="tbar-sel" aria-label="Filter Marketplace state"><option value="">All states</option>${planeOptions}</select>`
    : '<input type="hidden" id="market-plane" value="">';
  const sourceOptions = sources.map((source, si) => `<option value="src-${si}">${escapeHtml(source.name)}</option>`).join('');
  const sourceSelect = sources.length
    ? `<select id="market-source" class="tbar-sel" aria-label="Filter Marketplace source"><option value="">All sources</option><option value="builtin">Built in</option>${sourceOptions}</select>`
    : '<input type="hidden" id="market-source" value="">';

  const seg = `<div class="seg" id="mseg" role="tablist" aria-label="Marketplace sections"><button id="market-tab-button-cat" type="button" role="tab" aria-controls="market-tab-cat" aria-selected="${tab === 'sources' ? 'false' : 'true'}" data-t="catalogue"${tab === 'sources' ? '' : ' class="on"'}>Catalogue</button><button id="market-tab-button-src" type="button" role="tab" aria-controls="market-tab-src" aria-selected="${tab === 'sources' ? 'true' : 'false'}" data-t="sources"${tab === 'sources' ? ' class="on"' : ''}>Sources</button></div>`;

  return shell('catalogue', csrf, metaOf(), `
    ${board('catalogue', 'Marketplace', `<span class="count-tag" id="market-count" role="status" aria-live="polite">${tab === 'sources' ? sourceCountLabel : catalogueCountLabel}</span><span class="count-tag" id="market-secondary-count">${tab === 'sources' ? sourceEntryCountLabel : starterCountLabel}</span>${seg}`, metaOf())}
    <div id="market-tab-cat" role="tabpanel" aria-labelledby="market-tab-button-cat"${tab === 'sources' ? ' hidden' : ''}>
      <div class="market-browser-tools"><div class="market-tools"><div class="tbar-search">${I.search}<input id="market-search" type="search" placeholder="Search services and templates" autocomplete="off" spellcheck="false"></div><select id="market-category" class="tbar-sel" aria-label="Filter Marketplace category"><option value="">All categories</option>${categoryOptions}</select>${sourceSelect}${planeSelect}<button class="btn market-clear" type="button" hidden>Clear</button></div>${modeNote}</div>
      <div class="market-grid" id="market-grid">${cards}${sourceCards}</div>
      <div class="market-empty-state" id="market-empty" role="status" aria-live="polite" hidden><b>No matching services</b><span id="market-empty-copy"></span><button class="btn market-clear" type="button">Clear filters</button></div>
    </div>
    <div id="market-tab-src" role="tabpanel" aria-labelledby="market-tab-button-src"${tab === 'sources' ? '' : ' hidden'}>
      ${sourcesSection(sources)}
    </div>
    ${marketplaceModal(entries, control, dockerKnown, sources)}`);
}

// Source management writes Companion state and does not require Docker control.
function sourcesSection(sources) {
  const rows = sources.map((source) => `
      <div class="tr t-tpl">
        <div class="svc">${escapeHtml(source.name)}</div>
        <div class="addr mono" title="${escapeHtml(source.url)}">${escapeHtml(source.url)}</div>
        <div class="num">${source.fetchedAt && !source.fetchError ? source.entries.length : '<span class="faint">·</span>'}</div>
        <div>${source.fetchError
    ? `<span class="state bad" title="${escapeHtml(source.fetchError)}"><i></i>Fetch failed</span>`
    : source.fetchedAt
      ? `<span class="addr">${escapeHtml(fmtWhen(source.fetchedAt))}</span>`
      : '<span class="faint">Not fetched yet</span>'}</div>
        <div class="acts"><button type="button" class="btn src-refresh" data-id="${escapeHtml(source.id)}">Refresh</button><button type="button" class="actbtn halt src-remove" data-id="${escapeHtml(source.id)}" data-name="${escapeHtml(source.name)}" title="Remove this source" aria-label="Remove ${escapeHtml(source.name)}">${I.trash}</button></div>
      </div>`).join('');
  return `
    <div class="market-intro"><div><b>Template sources</b><span>Portainer v2 template JSON, fetched over https from public addresses only. Their entries join the catalogue and are not reviewed by Quartermaster.</span></div></div>
    ${sources.length ? `<div class="tscroll"><div class="table srctable">
      <div class="tr t-tpl th"><div class="hc">Name</div><div class="hc">URL</div><div class="hc num">Entries</div><div class="hc">Fetched</div><div class="hc" style="text-align:right">Actions</div></div>
      ${rows}
    </div></div>` : '<div class="empty">No template sources yet. Add one below.</div>'}
    <form class="src-add" id="src-add">
      <input class="in" id="src-name" placeholder="Name" maxlength="60" autocomplete="off" aria-label="Source name">
      <input class="in mono" id="src-url" placeholder="https://example.com/templates.json" maxlength="2048" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="Template file URL">
      <button class="btn primary" type="submit">Add source</button>
      <span class="hint" id="src-note" role="status" aria-live="polite"></span>
    </form>
    <script>
      (function () {
        var csrfv = document.querySelector('meta[name=csrf]').content;
        var note = document.getElementById('src-note');
        function post(path, body) {
          body.csrf = csrfv;
          return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().catch(function () { return {}; }); });
        }
        var form = document.getElementById('src-add');
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var name = document.getElementById('src-name').value.trim();
          var url = document.getElementById('src-url').value.trim();
          if (!name || !url) { note.textContent = 'A name and an https URL, please.'; return; }
          note.textContent = 'Adding\\u2026';
          post('/settings/templates/add', { name: name, url: url }).then(function (d) {
            if (!d.ok) { note.textContent = d.error || 'not added'; return; }
            note.textContent = 'Added. Fetching the template file\\u2026';
            post('/settings/templates/refresh', { id: d.source.id }).then(function () {
              location.href = '/catalogue?tab=sources';
            }).catch(function () { location.href = '/catalogue?tab=sources'; });
          }).catch(function () { note.textContent = 'could not reach the server'; });
        });
        document.querySelectorAll('.src-refresh').forEach(function (b) {
          b.addEventListener('click', function () {
            b.disabled = true;
            note.textContent = 'Fetching\\u2026';
            post('/settings/templates/refresh', { id: b.dataset.id }).then(function () {
              location.href = '/catalogue?tab=sources';
            }).catch(function () { b.disabled = false; note.textContent = 'could not reach the server'; });
          });
        });
        document.querySelectorAll('.src-remove').forEach(function (b) {
          b.addEventListener('click', function () {
            qmConfirm({
              title: 'Remove ' + b.dataset.name, danger: true, confirmLabel: 'Remove',
              what: 'Remove this template source?',
              detail: ['Its entries leave the catalogue. Nothing already deployed is touched.'],
            }).then(function (yes) {
              if (!yes) return;
              post('/settings/templates/remove', { id: b.dataset.id }).then(function () {
                location.href = '/catalogue?tab=sources';
              }).catch(function () { note.textContent = 'could not reach the server'; });
            });
          });
        });
      })();
    </script>`;
}

function marketplaceModal(entries, control, dockerReachable, sources) {
  const starterCount = entries.filter((entry) => entry.hasStarter).length;
  const sourceEntryCount = sources.reduce((count, source) => count + source.entries.length, 0);
  const totalCards = entries.length + sourceEntryCount;
  const deployEnabled = control && dockerReachable && (
    entries.some((entry) => entry.presentation.canDeploy)
    || sources.some((source) => source.entries.some((entry) => !!sourceCompose(entry)))
  );
  const catalogue = Object.fromEntries(entries.map((entry) => [entry.kind, {
    kind: entry.kind,
    label: entry.label,
    category: entry.categoryLabel,
    description: entry.description,
    installed: entry.installed,
    detectionKnown: dockerReachable,
    endpoint: `${entry.scheme}://${config.qmHost || 'server'}:${entry.defaultPort}`,
    upstreamUrl: entry.upstreamUrl,
    upstreamLabel: 'Official project',
    yaml: entry.starter ? entry.starter.yaml : null,
    notes: entry.starter ? entry.starter.reviewNotes : [],
    stack: entry.kind,
    presentation: entry.presentation,
  }]));
  // Retain source and review status throughout the shared review and deploy flow.
  sources.forEach((source, si) => {
    source.entries.forEach((entry, ei) => {
      const yaml = sourceCompose(entry);
      const upstreamUrl = templateProjectUrl(entry);
      const presentation = marketplacePresentation({ hasStarter: !!yaml }, {
        community: true,
        hasStarter: !!yaml,
        control,
        detectionKnown: dockerReachable,
      });
      catalogue[entryKey(si, ei)] = {
        kind: entryKey(si, ei),
        label: entry.title,
        category: (entry.categories && entry.categories[0]) || 'Community template',
        description: entry.description || 'No description in the template.',
        installed: false,
        detectionKnown: dockerReachable,
        endpoint: null,
        upstreamUrl: upstreamUrl || source.url,
        upstreamLabel: upstreamUrl ? 'Project' : 'Template source',
        yaml,
        notes: [],
        hint: `From ${source.name} · not reviewed by Quartermaster`,
        source: source.name,
        stack: suggestedStack(entry),
        presentation,
      };
    });
  });
  const deployFields = deployEnabled ? `<div class="market-deploy-fields" id="market-deploy-fields" hidden>
    <label for="market-stack-name">Stack name</label><input class="in mono" id="market-stack-name" maxlength="${STACK_NAME_MAX}" placeholder="name this stack" autocomplete="off" spellcheck="false">
    <span>Up to ${STACK_NAME_MAX} characters, because Companion creates the &lt;name&gt;_default network from it. Management is active. The installed socket proxy can still refuse this request if its write policy is lower.</span>
  </div>` : '';
  const deployButton = deployEnabled ? `<button class="btn primary" id="market-deploy" type="button" hidden>${I.play}Deploy and start</button>` : '';
  const deployScript = deployEnabled ? `
    var deploy=document.getElementById('market-deploy'), stackName=document.getElementById('market-stack-name');
    var envCells=[], envTimer=null;
    // Collect unresolved \${VAR} values for this deployment without rewriting the Compose file.
    function envWanted(){
      var re=/\\$\\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\\}/g, seen={}, out=[], m;
      while((m=re.exec(yaml.value))){ if(seen[m[1]]) continue; seen[m[1]]=1; out.push({k:m[1],d:m[2]!==undefined?m[3]:null}); }
      return out.slice(0,40);
    }
    function cell(name,text){ var el=document.createElement(name); if(text) el.textContent=text; return el; }
    function addCells(a,b,c){ [a,b,c].forEach(function(el){ deployFields.appendChild(el); envCells.push(el); }); }
    function buildEnv(){
      envCells.forEach(function(el){ if(el.parentNode) el.parentNode.removeChild(el); }); envCells=[];
      var wanted=envWanted(); if(!wanted.length) return;
      var head=cell('label','Values');
      addCells(head, cell('span'), cell('span','Used for this deployment only. Nothing typed here is written into the Compose file.'));
      wanted.forEach(function(v){
        var id='market-env-'+v.k;
        var label=cell('label'); label.htmlFor=id; label.className='mono'; label.textContent=v.k;
        var input=document.createElement('input');
        input.className='in mono'; input.type='text'; input.id=id; input.maxLength=200;
        input.autocomplete='off'; input.spellcheck=false; input.setAttribute('data-env',v.k);
        input.addEventListener('input',function(){ clearTimeout(envTimer); envTimer=setTimeout(function(){ mlint.refresh(); },400); });
        if(!head.htmlFor) head.htmlFor=id;
        addCells(label,input,cell('span',v.d===null?'No default. Left blank, it deploys as an empty value.':'Leave blank to use the default: '+v.d));
      });
    }
    function envValues(){
      var out={};
      envCells.forEach(function(el){ var k=el.getAttribute?el.getAttribute('data-env'):''; if(k&&el.value) out[k]=el.value; });
      return out;
    }
    deploy.addEventListener('click',function(){
      var name=stackName.value.trim();
      if(!/^[a-z0-9][a-z0-9_-]{0,${STACK_NAME_MAX - 1}}$/i.test(name)){
        status.textContent=name
          ? 'Stack names are letters, digits, dashes and underscores, ${STACK_NAME_MAX} characters at most, because Docker builds the network name from this one.'
          : 'Name this stack first. Companion deploys its containers under that name and builds the network name from it.';
        stackName.focus(); return;
      }
      deploy.disabled=true; status.textContent='Starting deployment';
      qmStream('/stacks/deploy',{name:name,yaml:yaml.value,env:envValues(),start:true},function(step){ status.textContent=(step.step||'Working')+(step.note?' : '+step.note:''); }).then(function(result){
        deploy.disabled=false; mlint.sync();
        if(result&&result.ok){ status.textContent='Deployment finished'; window.location.href='/stacks'; return; }
        var steps=result&&Array.isArray(result.steps)?result.steps:[],last=steps.length?steps[steps.length-1]:null;
        var reason=(last&&last.note)||(result&&result.note)||(result&&result.error)||'No reason was returned.';
        status.textContent=result&&result.partial?(result.created||0)+' container(s) were created before deployment stopped. '+reason:'Deployment stopped before completion. '+reason;
      }).catch(function(){ deploy.disabled=false; mlint.sync(); status.textContent='Could not reach Companion.'; });
    });` : '';
  return `<div class="overlay" id="market-overlay" hidden>
    <div class="modal lg market-modal" role="dialog" aria-modal="true" aria-labelledby="market-title">
      <div class="modal-h"><div><b id="market-title"></b><span class="modal-sub" id="market-category-label"></span></div><button class="iconbtn" id="market-close" type="button" aria-label="Close">${I.x}</button></div>
      <div class="modal-b">
        <p class="market-description" id="market-description"></p>
        <p class="market-hint" id="market-hint" hidden></p>
        <div class="market-connect-info" id="market-connect-info" hidden><span class="market-connect-icon">${I.link}</span><div><b id="market-connect-title">Service support</b><span id="market-connect-copy"></span><span class="market-endpoint" id="market-endpoint"></span></div></div>
        <div class="market-compose" id="market-compose" hidden>
          <div class="market-compose-head"><div><b id="market-compose-title">Reviewed Compose starter</b><span>Edit this file for your server before using it.</span></div><span class="badge info">Local preview</span></div>
          <textarea class="market-yaml mono" id="market-yaml" wrap="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Compose starter"></textarea>
          ${lintPanel('market-lint')}
          <ul class="market-notes" id="market-notes"></ul>
        </div>
        ${deployFields}
      </div>
      <div class="modal-f market-modal-foot"><span class="market-status" id="market-status" role="status" aria-live="polite"></span><a class="btn" id="market-upstream" target="_blank" rel="noopener noreferrer" hidden>${I.globe}<span id="market-upstream-label">Official project</span></a><a class="btn" id="market-pair" href="/pair" hidden>${I.link}<span id="market-pair-label">Review setup</span></a><button class="btn" id="market-copy" type="button" hidden>${I.copy}Copy</button><button class="btn" id="market-download" type="button" hidden>${I.down}Download</button>${deployButton}<button class="btn" id="market-done" type="button">Close</button></div>
    </div>
  </div>
  <script>
    (function(){
      ${LINT_FN}
      ${FOCUS_FN}
      var DATA=${jsafe(catalogue)};
      var overlay=document.getElementById('market-overlay'),title=document.getElementById('market-title');
      var category=document.getElementById('market-category-label'),description=document.getElementById('market-description');
      var connect=document.getElementById('market-connect-info'),compose=document.getElementById('market-compose');
      var yaml=document.getElementById('market-yaml'),notes=document.getElementById('market-notes');
      var copy=document.getElementById('market-copy'),download=document.getElementById('market-download');
      var upstream=document.getElementById('market-upstream'),upstreamLabel=document.getElementById('market-upstream-label'),pair=document.getElementById('market-pair'),pairLabel=document.getElementById('market-pair-label'),status=document.getElementById('market-status');
      var connectTitle=document.getElementById('market-connect-title'),connectCopy=document.getElementById('market-connect-copy'),endpoint=document.getElementById('market-endpoint');
      var hint=document.getElementById('market-hint'),composeTitle=document.getElementById('market-compose-title');
      var current='';
      var marketTrap=qmFocusTrap(overlay);
      ${deployEnabled ? "var deployFields=document.getElementById('market-deploy-fields');" : ''}
      function openEntry(kind){
        var entry=DATA[kind]; if(!entry) return;
        var opener=document.activeElement;
        var view=entry.presentation;
        current=kind; title.textContent=entry.label; category.textContent=entry.category; description.textContent=entry.description;
        hint.textContent=entry.hint||''; hint.hidden=!entry.hint;
        var hasCompose=typeof entry.yaml==='string'&&entry.yaml.length>0;
        connect.hidden=!(view.showConnectionPanel||!hasCompose); compose.hidden=!hasCompose; copy.hidden=!hasCompose; download.hidden=!hasCompose;
        pair.hidden=view.actionTarget!=='setup'; pairLabel.textContent=view.actionLabel;
        composeTitle.textContent=view.composeTitle||'Compose file';
        connectTitle.textContent=view.detailTitle;
        connectCopy.textContent=view.detailCopy;
        endpoint.hidden=!entry.endpoint;
        endpoint.textContent=entry.endpoint?'Default endpoint: '+entry.endpoint:'';
        upstream.hidden=!entry.upstreamUrl;
        upstreamLabel.textContent=entry.upstreamLabel||'Official project';
        if(entry.upstreamUrl) upstream.href=entry.upstreamUrl; else upstream.removeAttribute('href');
        yaml.value=hasCompose?entry.yaml:'';
        notes.textContent=''; (entry.notes||[]).forEach(function(text){ var item=document.createElement('li'); item.textContent=text; notes.appendChild(item); });
        status.textContent=view.statusText||'';
        ${deployEnabled ? "deployFields.hidden=!hasCompose||!view.canDeploy; deploy.hidden=!hasCompose||!view.canDeploy; stackName.value=entry.stack||''; buildEnv();" : ''}
        if(hasCompose) mlint.refresh(); else mlint.reset();
        overlay.hidden=false; marketTrap.open(opener,view.actionTarget==='setup'?pair:hasCompose?yaml:document.getElementById('market-done'));
      }
      function close(){
        if(overlay.hidden) return;
        overlay.hidden=true; current=''; yaml.value=''; notes.textContent=''; status.textContent=''; upstream.removeAttribute('href'); mlint.reset();
        ${deployEnabled ? "deploy.disabled=false; stackName.value=''; buildEnv();" : ''}
        marketTrap.close();
      }
      document.querySelectorAll('.market-open').forEach(function(button){ button.addEventListener('click',function(){ openEntry(button.dataset.kind); }); });
      document.getElementById('market-close').addEventListener('click',close);
      document.getElementById('market-done').addEventListener('click',close);
      overlay.addEventListener('click',function(event){ if(event.target===overlay) close(); });
      document.addEventListener('keydown',function(event){ if(event.key==='Escape'&&!overlay.hidden) close(); });
      copy.addEventListener('click',function(){
        function fallback(){ yaml.focus(); yaml.select(); var ok=false; try{ ok=document.execCommand('copy'); }catch(error){} status.textContent=ok?'Copied Compose file':'Select the Compose file and copy it manually.'; }
        if(navigator.clipboard&&window.isSecureContext){ navigator.clipboard.writeText(yaml.value).then(function(){ status.textContent='Copied Compose file'; }).catch(fallback); }
        else fallback();
      });
      download.addEventListener('click',function(){
        if(!current||!yaml.value) return;
        var blob=new Blob([yaml.value],{type:'application/yaml;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
        link.href=url; link.download=current+'.compose.yml'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function(){URL.revokeObjectURL(url);},0); status.textContent='Downloaded Compose file';
      });
      var search=document.getElementById('market-search'),categoryFilter=document.getElementById('market-category'),sourceFilter=document.getElementById('market-source'),plane=document.getElementById('market-plane'),count=document.getElementById('market-count'),secondaryCount=document.getElementById('market-secondary-count'),empty=document.getElementById('market-empty'),emptyCopy=document.getElementById('market-empty-copy'),clearButtons=document.querySelectorAll('.market-clear');
      var catalogueShown=${totalCards},totalCards=${totalCards},sourceCount=${sources.length},sourceEntryCount=${sourceEntryCount};
      function plural(n,one,many){return n+' '+(n===1?one:many);}
      function setHeader(src){
        count.textContent=src?plural(sourceCount,'source','sources'):catalogueShown+' shown';
        secondaryCount.textContent=src?plural(sourceEntryCount,'entry','entries'):${starterCount}+' starters';
      }
      function apply(){
        var term=search.value.trim().toLowerCase(),wantedCategory=categoryFilter.value,wantedSource=sourceFilter.value,wantPlane=plane.value,shown=0;
        var active=!!(term||wantedCategory||wantedSource||wantPlane);
        document.querySelectorAll('[data-market-card]').forEach(function(card){ var visible=(!term||card.dataset.find.indexOf(term)>=0)&&(!wantedCategory||card.dataset.category===wantedCategory)&&(!wantedSource||card.dataset.source===wantedSource)&&(!wantPlane||card.dataset.plane===wantPlane); card.hidden=!visible; if(visible) shown++; });
        catalogueShown=shown; if(!tabCat||!tabCat.hidden) setHeader(false);
        clearButtons.forEach(function(button){ button.hidden=!active; });
        if(!shown) emptyCopy.textContent=term?'Nothing matches "'+term+'" with the selected filters.':'Nothing matches the selected filters.';
        empty.hidden=shown>0;
      }
      function clearFilters(){ search.value=''; categoryFilter.value=''; sourceFilter.value=''; plane.value=''; apply(); search.focus(); }
      search.addEventListener('input',apply); categoryFilter.addEventListener('change',apply); sourceFilter.addEventListener('change',apply); plane.addEventListener('change',apply);
      search.addEventListener('keydown',function(event){ if(event.key==='Escape'&&search.value){ event.preventDefault(); search.value=''; apply(); } });
      clearButtons.forEach(function(button){ button.addEventListener('click',clearFilters); });
      // The two tabs share the page; switching updates the address for reloads and links.
      var seg=document.getElementById('mseg'),tabCat=document.getElementById('market-tab-cat'),tabSrc=document.getElementById('market-tab-src');
      seg.addEventListener('click',function(e){
        var b=e.target.closest('button'); if(!b) return;
        seg.querySelectorAll('button').forEach(function(x){ var on=x===b; x.classList.toggle('on',on); x.setAttribute('aria-selected',on?'true':'false'); });
        var src=b.dataset.t==='sources';
        tabCat.hidden=src; tabSrc.hidden=!src;
        setHeader(src);
        try{ history.replaceState(null,'',src?'/catalogue?tab=sources':'/catalogue'); }catch(err){}
      });
      ${deployScript}
      var mlint=qmLintWire({
        yaml:yaml,
        panel:document.getElementById('market-lint'),
        buttons:${deployEnabled ? '[deploy]' : '[]'},
        env:function(){ return ${deployEnabled ? 'envValues()' : '{}'}; },
        // Check conflicts without excluding any existing stack.
        stack:function(){ return ''; }
      });
    })();
  </script>`;
}
