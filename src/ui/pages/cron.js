import { escapeHtml } from '../../http.js';
import { I, tag, state, jsafe, fmtWhen, metaOf } from '../bits.js';
import { board, shell } from '../chrome.js';
import { gridHeader, gridOpen, gridClose } from '../columns.js';

// Cron jobs share one table, with history opened beneath each row.
export function cronPage(jobs, containers, control, csrf, err, shellAccess = false) {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = (n) => String(n).padStart(2, '0');
  const schedText = (s) => s.type === 'every' ? `Every ${s.hours}h`
    : s.type === 'daily' ? `Daily at ${pad(s.hour)}:${pad(s.minute)}`
      : `${DAYS[s.day]}s at ${pad(s.hour)}:${pad(s.minute)}`;
  const PRUNE_DOES = {
    images: 'Prunes dangling images.', 'images-all': 'Prunes every image no container uses.',
    containers: 'Prunes stopped containers.', networks: 'Prunes unused networks.',
    volumes: 'Prunes unused volumes.', build: 'Prunes the build cache.',
  };
  const nameOf = (ref) => {
    const c = containers.find((x) => x.id.startsWith(ref));
    return c ? c.name : String(ref).slice(0, 12);
  };
  const currentMode = shellAccess ? 'shell' : control ? 'manage' : 'read';
  const modeRank = { read: 0, manage: 1, shell: 2 };
  const modeLabel = { read: 'Read only', manage: 'Management', shell: 'Management + shell' };
  const requiredMode = (job) => job.kind === 'custom'
    ? job.action && job.action.type === 'exec' ? 'shell' : 'manage'
    : job.action === 'updates.check' ? 'read' : 'manage';
  const canActOn = (job) => modeRank[currentMode] >= modeRank[requiredMode(job)];
  const doesOf = (j) => {
    if (j.kind !== 'custom') return j.does;
    const a = j.action;
    if (a.type === 'prune') return PRUNE_DOES[a.what] || '';
    if (a.type === 'container') return `${{ restart: 'Restarts', stop: 'Stops', start: 'Starts' }[a.op]} ${nameOf(a.ref)}.`;
    if (a.type === 'pull') return `Pulls the image ${nameOf(a.ref)} runs.`;
    return `Runs a command in ${nameOf(a.ref)}.`;
  };
  // Determine the highest access level required by locked jobs.
  const lockedJobs = jobs.filter((j) => !canActOn(j));
  const neededMode = lockedJobs.some((j) => requiredMode(j) === 'shell') ? 'shell' : 'manage';
  const overlayFile = neededMode === 'shell' ? 'docker-compose.shell.yml' : 'docker-compose.management.yml';
  const lockedNote = lockedJobs.length
    ? `<p class="sub">${lockedJobs.length} job${lockedJobs.length === 1 ? '' : 's'} here need${lockedJobs.length === 1 ? 's' : ''} more Docker access than this Companion has. Choose ${modeLabel[neededMode]} under Docker access. If that mode is unavailable, recreate with <code class="mono">docker compose -f docker-compose.example.yml -f ${overlayFile} up -d --build</code>. Keep the same <code class="mono">-f</code> files in the same order.</p>`
    : '';
  const hid = (id) => `<input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  const rows = jobs.map((j) => {
    const custom = j.kind === 'custom';
    const required = requiredMode(j);
    const canAct = canActOn(j);
    const editLabel = custom && canAct ? 'Edit job' : 'Edit schedule';
    const lockLabel = `${modeLabel[required]} mode required`;
    const hist = j.history || [];
    // A start without a result is treated as interrupted.
    const recorded = hist.length ? Number(hist[0].at) === Number(j.lastRunAt) : !!j.lastResult;
    const openClaim = !!j.lastRunAt && !recorded;
    const last = openClaim ? null : (j.lastResult || hist[0] || null);
    const openNote = 'Companion recorded this run starting but no result, so it may still be running or may have been interrupted.';
    // Refreshed rows carry the latest result used by the live status dialog.
    return `<div class="tr t-cron" data-jid="${escapeHtml(j.id)}" data-jname="${escapeHtml(j.name)}" data-job="${escapeHtml(j.name.toLowerCase())}" data-enabled="${j.enabled ? '1' : '0'}" data-required-mode="${required}" data-can-act="${canAct ? '1' : '0'}" data-last="${Number(j.lastRunAt) || 0}" data-next="${Number(j.nextRunAt) || 0}"
      data-lastok="${j.lastRunAt && !openClaim ? (last && last.ok ? '1' : '0') : ''}" data-lastnote="${escapeHtml((last && last.note) || '')}" data-open-claim="${openClaim ? '1' : ''}">
      <div data-col="exp"><button class="chevbtn j-x" data-x="x-${escapeHtml(j.id)}" title="Run history" aria-label="Run history" aria-expanded="false">${I.chev}</button></div>
      <div data-col="job"><div class="svc">${escapeHtml(j.name)} ${custom ? tag('line', 'custom') : ''}</div><div class="jobdoes">${escapeHtml(doesOf(j))}</div></div>
      <div class="dim" data-col="schedule">${escapeHtml(schedText(j.schedule))}</div>
      <div data-col="last">${!j.lastRunAt ? '<span class="faint">Never</span>'
      : openClaim ? `<span class="state warn" title="${escapeHtml(openNote)}"><i></i>Interrupted</span><span class="runms">started ${escapeHtml(fmtWhen(j.lastRunAt))}</span>`
        : `<span class="state ${last && last.ok ? 'ok' : 'bad'}"><i></i>${escapeHtml(fmtWhen(j.lastRunAt))}</span><span class="runms">in ${last ? Number(last.ms) || 0 : 0}ms</span>`}</div>
      <div class="dim" data-col="next">${j.nextRunAt ? escapeHtml(fmtWhen(j.nextRunAt)) : 'Not scheduled'}</div>
      <div data-col="status">${j.enabled ? state('ok', 'On') : state('off', 'Off')}</div>
      <div class="acts" data-col="actions">
        ${canAct ? `<form method="post" action="/cron/run">${hid(j.id)}<button class="actbtn go" type="submit" title="Run now" aria-label="Run now">${I.play}</button></form>` : ''}
        <button class="actbtn spin j-edit" type="button" data-id="${escapeHtml(j.id)}" title="${editLabel}" aria-label="${editLabel}">${I.pencil}</button>
        ${j.enabled || canAct ? `<form method="post" action="/cron/toggle">${hid(j.id)}<input type="hidden" name="enabled" value="${j.enabled ? 'false' : 'true'}"><button class="actbtn" type="submit" title="${j.enabled ? 'Turn off' : 'Turn on'}" aria-label="${j.enabled ? 'Turn off' : 'Turn on'}">${I.power}</button></form>` : ''}
        ${custom ? `<form method="post" action="/cron/delete" class="j-del" data-name="${escapeHtml(j.name)}">${hid(j.id)}<button class="actbtn halt" type="submit" title="Delete job" aria-label="Delete job">${I.trash}</button></form>` : ''}
        ${canAct ? '' : `<span class="actguard" title="${lockLabel}" aria-label="${lockLabel}">${I.shield}</span>`}
      </div>
    </div>
    <div class="cron-x hidden" id="x-${escapeHtml(j.id)}">
      ${openClaim ? `<div class="hint">Started ${escapeHtml(fmtWhen(j.lastRunAt))}, but no result was recorded, so there is no history row. Companion records the start before Docker work and the result after; the run may still be going or Companion may have stopped.${canAct ? ' Run it again if required.' : ''}</div>` : ''}
      ${hist.length ? `<div class="xrow xh"><div>When</div><div>Trigger</div><div>Took</div><div>Result</div></div>
      ${hist.map((h) => `<div class="xrow"><div class="dim">${escapeHtml(fmtWhen(h.at))}</div><div class="dim">${escapeHtml(h.trigger || 'schedule')}</div><div class="dim">${Number(h.ms) || 0}ms</div><div><span class="state ${h.ok ? 'ok' : 'bad'}"><i></i>${escapeHtml(h.note || '')}</span></div></div>`).join('')}
      <form method="post" action="/cron/clear-history" style="margin-top:8px">${hid(j.id)}<button class="btn" type="submit">Clear history</button></form>`
    : '<div class="hint">No runs recorded yet.</div>'}
    </div>`;
  }).join('');
  // Data used to prefill the edit dialog.
  const lite = Object.fromEntries(jobs.map((j) => [j.id, {
    id: j.id, name: j.name, custom: j.kind === 'custom',
    action: j.kind === 'custom' ? j.action : null, schedule: j.schedule,
    locked: !canActOn(j), requiredLabel: modeLabel[requiredMode(j)],
  }]));
  const copts = containers.length
    ? containers.map((c) => `<option value="${escapeHtml(c.id.slice(0, 12))}">${escapeHtml(c.name)}</option>`).join('')
    : '<option value="">no containers found</option>';
  const sel = (idAttr, name, opts, extra) => `<select class="tbar-sel" id="${idAttr}" name="${name}" style="width:100%;margin:6px 0 12px"${extra || ''}>${opts}</select>`;
  const hourOpts = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${pad(h)}</option>`).join('');
  const minOpts = Array.from({ length: 60 }, (_, m) => `<option value="${m}">${pad(m)}</option>`).join('');
  const hoursOpts = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168].map((h) => `<option value="${h}">${h}</option>`).join('');
  const execOption = shellAccess
    ? '<option value="exec">Run a command in a container</option>'
    : '<option value="exec" disabled>Run a command in a container (shell mode required)</option>';
  return shell('cron', csrf, metaOf(), `
    ${board('cron', 'Cron jobs', `<span class="count-tag">${jobs.length}</span>
      ${control ? `<button class="btn primary" id="newjob">${I.plus}New job</button>` : ''}
      <span data-grid-gear></span>`, metaOf())}
    <p class="sub">Schedule Docker maintenance or custom jobs. Docker changes require Management; commands require Management + shell. Current mode: ${modeLabel[currentMode]}.</p>
    ${lockedNote}
    ${err ? '<div class="err">That job did not save. Check the fields and try again.</div>' : ''}
    ${gridOpen('cron', { tableClass: 'crontable' })}
      ${gridHeader('cron', { rowClass: 't-cron' })}
      ${rows}
    ${gridClose()}
    <div class="overlay" id="jobov" hidden>
      <form class="modal sm" id="jobform" method="post" action="/cron/new" role="dialog" aria-modal="true" aria-label="Cron job">
        <div class="modal-h"><b id="jobtitle">New job</b><button type="button" class="iconbtn" id="jobx" aria-label="Close">${I.x}</button></div>
        <div class="modal-b">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="id" id="f-id" value="">
          <label class="hint" for="f-name">Name</label>
          <input class="in" id="f-name" name="name" maxlength="40" style="width:100%;margin:6px 0 12px" placeholder="Nightly tidy-up" autocomplete="off" spellcheck="false" required>
          <p class="mode-note" id="f-locknote" hidden></p>
          <div id="f-actwrap">
            <label class="hint" for="f-atype">Action</label>
            ${sel('f-atype', 'atype', `<option value="prune">Prune</option><option value="container">Restart, stop or start a container</option><option value="pull">Pull a container's image</option>${execOption}`)}
            <div id="f-prunerow">
              <label class="hint" for="f-what">What to prune</label>
              ${sel('f-what', 'what', `<option value="images">Dangling images</option><option value="images-all">All unused images</option><option value="containers">Stopped containers</option><option value="networks">Unused networks</option><option value="volumes">Unused volumes</option><option value="build">Build cache</option>`)}
            </div>
            <div id="f-oprow" class="hidden">
              <label class="hint" for="f-op">Operation</label>
              ${sel('f-op', 'op', '<option value="restart">Restart</option><option value="stop">Stop</option><option value="start">Start</option>')}
            </div>
            <div id="f-refrow" class="hidden">
              <label class="hint" for="f-ref">Container</label>
              ${sel('f-ref', 'ref', copts)}
            </div>
            <div id="f-cmdrow" class="hidden">
              <label class="hint" for="f-cmd">Command</label>
              <input class="in mono" id="f-cmd" name="cmd" maxlength="4000" style="width:100%;margin:6px 0 4px" placeholder="find /config/backups -mtime +14 -delete" autocomplete="off" spellcheck="false">
              <p class="hint" style="margin:0 0 12px">Uses the container's configured user and privileges. Requires Management + shell mode.</p>
            </div>
          </div>
          <label class="hint" for="f-stype">Schedule</label>
          ${sel('f-stype', 'stype', '<option value="daily">Daily</option><option value="weekly">Weekly</option><option value="every">Every N hours</option>')}
          <div id="f-dayrow" class="hidden">
            <label class="hint" for="f-day">Day</label>
            ${sel('f-day', 'day', DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join(''))}
          </div>
          <div id="f-timerow">
            <label class="hint" for="f-hour">Time</label>
            <div class="fieldrow" style="margin:6px 0 12px">
              <select class="tbar-sel" id="f-hour" name="hour">${hourOpts}</select>
              <span class="dim">:</span>
              <select class="tbar-sel" id="f-min" name="minute">${minOpts}</select>
            </div>
          </div>
          <div id="f-hoursrow" class="hidden">
            <label class="hint" for="f-hours">Run every</label>
            <div class="fieldrow" style="margin:6px 0 12px">
              <select class="tbar-sel" id="f-hours" name="hours">${hoursOpts}</select>
              <span class="dim">hours</span>
            </div>
          </div>
        </div>
        <div class="modal-f"><button type="button" class="btn" id="jobcancel">Cancel</button><button class="btn primary" id="jobsave" type="submit">Save job</button></div>
      </form>
    </div>
    <script>
      (function () {
        // Delegate table actions so replaced rows keep working.
        var table = document.querySelector('.crontable');
        function jsel(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, ''); }
        table.addEventListener('click', function (e) {
          var chev = e.target.closest('.j-x');
          if (chev) {
            var x = document.getElementById(chev.dataset.x);
            if (!x) return;
            x.classList.toggle('hidden');
            var shown = !x.classList.contains('hidden');
            chev.classList.toggle('open', shown);
            chev.setAttribute('aria-expanded', shown ? 'true' : 'false');
            return;
          }
          var ed = e.target.closest('.j-edit');
          if (ed) openM(JOBS[ed.dataset.id]);
        });
        // Replace the row when the run completes.
        function runNow(f) {
          var row = f.closest('.t-cron');
          var id = jsel(row.dataset.jid), name = row.dataset.jname;
          var btn = f.querySelector('button');
          btn.disabled = true;
          var t = qmToast('Run ' + name);
          t.ops.set('r', { state: 'active', label: name, note: 'running' });
          fetch('/cron/run', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(new FormData(f)).toString(),
          }).then(function (r) { return r.text(); }).then(function (txt) {
            var fresh = new DOMParser().parseFromString(txt, 'text/html');
            var nextRow = fresh.querySelector('.t-cron[data-jid="' + id + '"]');
            var nextX = fresh.getElementById('x-' + id), liveX = document.getElementById('x-' + id);
            var wasOpen = liveX && !liveX.classList.contains('hidden');
            if (nextRow) {
              if (wasOpen) {
                var c = nextRow.querySelector('.j-x');
                if (c) { c.classList.add('open'); c.setAttribute('aria-expanded', 'true'); }
              }
              row.replaceWith(nextRow);
            }
            if (nextX && liveX) { if (wasOpen) nextX.classList.remove('hidden'); liveX.replaceWith(nextX); }
            var now = document.querySelector('.t-cron[data-jid="' + id + '"]');
            var ok = !!now && now.dataset.lastok === '1';
            var open = !!now && now.dataset.openClaim === '1';
            t.ops.set('r', {
              state: ok ? 'ok' : 'fail',
              note: open ? 'started, no result recorded yet' : (now && now.dataset.lastnote) || (ok ? 'done' : 'no result came back'),
            });
          }).catch(function () {
            t.ops.set('r', { state: 'fail', note: 'could not reach the server' });
          }).then(function () { btn.disabled = false; });
        }
        table.addEventListener('submit', function (e) {
          var f = e.target;
          if (f.classList.contains('j-del')) {
            e.preventDefault();
            qmConfirm({
              title: 'Delete job', danger: true, confirmLabel: 'Delete',
              what: 'Delete this job?',
              detail: ['The schedule and run history will be permanently removed. Completed actions are not reversed.'],
            }).then(function (yes) { if (yes) f.submit(); });
            return;
          }
          if (f.getAttribute('action') === '/cron/run') { e.preventDefault(); runNow(f); }
        });
        var JOBS = ${jsafe(lite)};
        var ov = document.getElementById('jobov'), form = document.getElementById('jobform');
        var atype = document.getElementById('f-atype'), stype = document.getElementById('f-stype');
        function tog(id, show) { document.getElementById(id).classList.toggle('hidden', !show); }
        function showA() {
          var t = atype.value;
          tog('f-prunerow', t === 'prune'); tog('f-oprow', t === 'container');
          tog('f-refrow', t !== 'prune'); tog('f-cmdrow', t === 'exec');
        }
        function showS() {
          var t = stype.value;
          tog('f-dayrow', t === 'weekly'); tog('f-timerow', t !== 'every'); tog('f-hoursrow', t === 'every');
        }
        atype.addEventListener('change', showA); stype.addEventListener('change', showS);
        // Preserve saved values not present in the current option lists.
        function setSel(el, v) {
          v = String(v);
          if (!el.querySelector('option[value="' + v + '"]')) el.add(new Option(v, v));
          el.value = v;
        }
        function openM(job) {
          var scheduleOnly = !!(job && (!job.custom || job.locked));
          form.action = job ? (scheduleOnly ? '/cron/schedule' : '/cron/edit') : '/cron/new';
          document.getElementById('f-id').value = job ? job.id : '';
          document.getElementById('jobtitle').textContent = job ? (scheduleOnly ? 'Edit schedule' : 'Edit job') : 'New job';
          document.getElementById('jobsave').textContent = scheduleOnly ? 'Save schedule' : 'Save job';
          var lockNote = document.getElementById('f-locknote');
          lockNote.hidden = !(job && job.locked);
          lockNote.textContent = job && job.locked ? job.requiredLabel + ' mode is required for this action. Only its schedule can be changed here.' : '';
          var name = document.getElementById('f-name');
          name.value = job ? job.name : '';
          name.readOnly = scheduleOnly;
          tog('f-actwrap', !job || (job.custom && !job.locked));
          var a = (job && job.action) || { type: 'prune', what: 'images' };
          atype.value = a.type;
          document.getElementById('f-what').value = a.what || 'images';
          document.getElementById('f-op').value = a.op || 'restart';
          if (a.ref) setSel(document.getElementById('f-ref'), a.ref);
          document.getElementById('f-cmd').value = a.cmd || '';
          var s = job ? job.schedule : { type: 'weekly', day: 0, hour: 3, minute: 0 };
          stype.value = s.type;
          document.getElementById('f-day').value = String(s.day || 0);
          document.getElementById('f-hour').value = String(s.hour == null ? 3 : s.hour);
          document.getElementById('f-min').value = String(s.minute || 0);
          setSel(document.getElementById('f-hours'), s.hours || 24);
          showA(); showS();
          ov.hidden = false;
          name.focus();
        }
        function closeM() { ov.hidden = true; }
        var newJob = document.getElementById('newjob');
        if (newJob) newJob.addEventListener('click', function () { openM(null); });
        document.getElementById('jobx').addEventListener('click', closeM);
        document.getElementById('jobcancel').addEventListener('click', closeM);
        ov.addEventListener('click', function (e) { if (e.target === ov) closeM(); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !ov.hidden) closeM(); });
      })();
    </script>`);
}
