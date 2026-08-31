import { escapeHtml } from '../../http.js';
import { I, tag, fmtBytes, fmtWhen, metaOf } from '../bits.js';
import { board, shell, noSocket, proxyBlocked } from '../chrome.js';
import { gridHeader, gridOpen, gridClose } from '../columns.js';

// An empty array is a successful Docker response. Do not render image actions without rows.
function noImages(csrf) {
  return shell('images', csrf, metaOf(), `
    ${board('images', 'Images', `<span class="count-tag">0</span>
      <a class="btn" href="/images">${I.rotate}Refresh</a>`, metaOf())}
    <div class="empty">Docker returned no images.
      <br><br>Pull an image or start a stack on the server:
      <code class="mono">docker pull lscr.io/linuxserver/radarr:latest</code>, or
      <code class="mono">docker compose -f docker-compose.example.yml up -d</code>, repeating every
      <code class="mono">-f</code> file this install already starts with, in the same order.</div>`);
}

export function imagesPage(images, inUse, control, csrf, usedBy) {
  if (images === null) return noSocket('images', 'img', 'Images', csrf);
  if (images === 'blocked') return proxyBlocked('images', 'img', 'Images', 'IMAGES', csrf);
  if (!images.length) return noImages(csrf);
  // Split repo:tag only when the colon follows the last slash, preserving registry ports.
  const splitTag = (full) => {
    const i = full.lastIndexOf(':');
    return i > full.lastIndexOf('/') ? [full.slice(0, i), full.slice(i + 1)] : [full, ''];
  };
  const on = usedBy || {};
  // Render each image tag on its own line.
  const tagsFor = (im, n) => {
    const list = im.tagList || [];
    if (!list.length) return '';
    const rows = list.map((tg) => {
      // Update state is keyed by the fully qualified tag.
      const users = on[tg.ref] || on[`${tg.repo}:${tg.tag}`] || [];
      return `<div class="xrow">
        <div>${tag('line mono', tg.tag)}<span class="badge warn tagupd hidden" data-ref="${escapeHtml(tg.ref)}">Update</span><span class="dim" style="margin-left:8px">${escapeHtml(tg.repo)}</span></div>
        <div class="mono dim" title="${escapeHtml(tg.digest || '')}">${escapeHtml(tg.digest ? tg.digest.replace(/^sha256:/, '').slice(0, 12) : 'Not available')}</div>
        <div class="dim">${escapeHtml(fmtBytes(im.size))}</div>
        <div class="dim">${escapeHtml(fmtWhen(im.created ? im.created * 1000 : 0))}</div>
        <div class="dim" title="${escapeHtml(users.join(', '))}">${users.length ? `${users.length} container${users.length > 1 ? 's' : ''}` : 'nothing'}</div>
        <div class="acts">${control ? `<button class="actbtn halt tag-rm" data-ref="${escapeHtml(tg.ref)}" data-last="${list.length === 1 ? '1' : ''}" title="Remove this tag" aria-label="Remove this tag">${I.trash}</button>` : ''}</div>
      </div>`;
    }).join('');
    return `<div class="rowx x-tags" id="x${n}" hidden>
      <div class="xrow xh"><div>Tag</div><div>Digest</div><div>Size</div><div>Created</div><div>Used by</div><div style="text-align:right">${control ? 'Actions' : ''}</div></div>
      ${rows}
    </div>`;
  };
  const rows = images.map((im, n) => {
    const full = im.tags[0] || '';
    const [repo, tagName] = full ? splitTag(full) : [`<untagged> ${im.id}`, ''];
    const used = inUse && inUse.has(im.fullId);
    const count = (im.tagList || []).length;
    const chev = count ? `<button class="chevbtn imgx" data-x="x${n}" aria-expanded="false" aria-controls="x${n}" title="Show every tag" aria-label="Show every tag">${I.chev}</button>` : '';
    return `<div class="tr t-img" data-id="${escapeHtml(im.id)}" data-repo="${escapeHtml(repo)}" data-tags="${count}" data-size="${im.size || 0}" data-created="${im.created || 0}" data-find="${escapeHtml(((im.tags.join(' ') || repo) + ' ' + im.id).toLowerCase())}">
      <div data-col="exp">${chev}</div>
      <div class="svc" data-col="repo">${escapeHtml(repo)} ${tagName ? tag('line mono', tagName) : ''} ${used || im.dangling ? '' : tag('idle', 'unused')} ${im.dangling ? tag('warn', 'dangling') : ''}</div>
      <div class="mono dim" data-col="id">${escapeHtml(im.id)}</div>
      <div class="num dim" data-col="tags">${count || '<span class="faint">None</span>'}</div>
      <div class="num dim" data-col="size">${escapeHtml(fmtBytes(im.size))}</div>
      <div class="num dim" data-col="created">${escapeHtml(fmtWhen(im.created ? im.created * 1000 : 0))}</div>
      <div data-col="actions">${control ? `<div class="acts"><button class="actbtn halt img-rm" data-id="${escapeHtml(im.id)}" data-name="${escapeHtml(full || im.id)}" title="Remove image" aria-label="Remove image">${I.trash}</button></div>` : ''}</div>
    </div>${tagsFor(im, n)}`;
  }).join('');
  return shell('images', csrf, metaOf(), `
    ${board('images', 'Images', `<span class="count-tag" id="tcount">${images.length}</span>
      <div class="tbar-search">${I.search}<input id="tsearch" type="text" placeholder="Search images…" autocomplete="off" spellcheck="false"></div>
      ${control ? `<button class="btn primary" id="pullbtn">${I.down}Pull</button>
      <button class="btn" id="prunebtn">Prune</button>
      <button class="btn" id="pruneallbtn">Prune unused</button>` : ''}
      <a class="btn" href="/images">${I.rotate}Refresh</a>
      <span data-grid-gear></span>`, metaOf())}
    ${control ? '' : '<p class="sub">Read only. Choose Management from Docker access in the navigation to pull, prune and remove.</p>'}
    ${gridOpen('images', { tableClass: 'imgtable' })}
      ${gridHeader('images', { rowClass: 't-img' })}
      ${rows}
    ${gridClose()}
    <div class="empty hidden" id="tempty">Nothing matches that filter.</div>
    <script>
      (function () {
        // Filter each row and its adjacent tag details together.
        var q = document.getElementById('tsearch'), c = document.getElementById('tcount'), e = document.getElementById('tempty');
        function prunable(any) {
          ['prunebtn', 'pruneallbtn'].forEach(function (id) {
            var b = document.getElementById(id);
            if (b) b.classList.toggle('hidden', !any);
          });
        }
        function apply() {
          var t = (q.value || '').toLowerCase(), n = 0, total = 0;
          document.querySelectorAll('.t-img:not(.th)').forEach(function (r) {
            var ok = !t || r.dataset.find.indexOf(t) >= 0;
            r.style.display = ok ? '' : 'none';
            var x = r.nextElementSibling;
            if (x && x.classList.contains('rowx')) x.style.display = ok ? '' : 'none';
            if (ok) n++;
            total++;
          });
          c.textContent = n;
          // Hide Prune when the page has no rows.
          prunable(total > 0);
          // Distinguish a filter miss from a list emptied by actions.
          e.textContent = t
            ? 'Nothing matches that filter.'
            : 'No images left on this page. Reload to check that against Docker.';
          e.classList.toggle('hidden', n > 0);
        }
        q.addEventListener('input', apply);
        // Initialize the empty state after listeners are attached.
        apply();
        document.querySelectorAll('.imgx').forEach(function (b) {
          b.addEventListener('click', function () {
            var x = document.getElementById(b.dataset.x);
            if (!x) return;
            x.hidden = !x.hidden;
            b.classList.toggle('open', !x.hidden);
            b.setAttribute('aria-expanded', x.hidden ? 'false' : 'true');
          });
        });
        // Apply per-tag update status from the shared cache without starting a registry check.
        fetch('/api/updates?cached=1').then(function (r) { return r.json(); }).then(function (d) {
          var by = {};
          (d.results || []).forEach(function (x) { by[x.image] = x.status === 'update' && !x.dismissed; });
          document.querySelectorAll('.tagupd').forEach(function (el) { el.classList.toggle('hidden', !by[el.dataset.ref]); });
        }).catch(function () {});
      })();
    </script>
    ${control ? `<div class="overlay" id="pullov" hidden>
      <div class="modal sm" role="dialog" aria-modal="true" aria-label="Pull an image">
        <div class="modal-h"><b>Pull an image</b><button class="iconbtn" id="pullx" aria-label="Close">${I.x}</button></div>
        <div class="modal-b">
          <label class="hint" for="pullref">Image reference</label>
          <input class="in" id="pullref" style="width:100%;margin-top:6px" placeholder="lscr.io/linuxserver/radarr:latest" autocomplete="off" spellcheck="false">
          <p class="hint" style="margin:10px 0 0">Pulls through the Docker API. Progress is shown for each downloaded layer.</p>
          <div id="pullnote" style="margin-top:12px"></div>
        </div>
        <div class="modal-f"><button class="btn" id="pullcancel">Cancel</button><button class="btn primary" id="pullgo">${I.down}Pull</button></div>
      </div>
    </div>
    <script>
      (function () {
        var csrf = document.querySelector('meta[name=csrf]').content;
        var count = document.getElementById('tcount');
        // Remove the adjacent tag details with each row and then recompute the empty state.
        function dropRow(row) {
          if (!row) return;
          var x = row.nextElementSibling;
          if (x && x.classList.contains('rowx')) x.remove();
          row.remove();
        }
        function reflectEmpty() {
          var left = document.querySelectorAll('.t-img:not(.th)').length;
          if (count) count.textContent = left;
          var e = document.getElementById('tempty');
          if (!e) return;
          if (!left) e.textContent = 'No images left on this page. Reload to check that against Docker.';
          e.classList.toggle('hidden', left > 0);
          ['prunebtn', 'pruneallbtn'].forEach(function (id) {
            var b = document.getElementById(id);
            if (b) b.classList.toggle('hidden', left === 0);
          });
        }
        function post(path, body) {
          return fetch(path, { method: 'POST', headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
            .then(function (r) { return r.json(); });
        }
        // Show indeterminate progress until Prune reports totals, then render the result.
        function pruneRun(mode, ask) {
          qmConfirm(ask).then(function (yes) {
            if (!yes) return;
            var t = qmToast(ask.title);
            t.ops.set('p', { state: 'active', label: mode === 'all' ? 'Removing every unused image' : 'Removing dangling layers', note: 'working' });
            post('/images/prune', { mode: mode }).then(function (d) {
              t.ops.set('p', { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'done' : 'failed') });
              if (!d.ok) return;
              // Remove pruned rows immediately.
              var gone = Array.isArray(d.removed) ? d.removed : [];
              gone.forEach(function (id) { dropRow(document.querySelector('.t-img[data-id="' + id + '"]')); });
              reflectEmpty();
              // Reconcile when Prune matched no rendered rows.
              if (!gone.length && /reclaimed/.test(d.note || '')) t.reloadOnClose();
            }).catch(function () { t.ops.set('p', { state: 'fail', note: 'could not reach the server' }); });
          });
        }
        document.getElementById('prunebtn').addEventListener('click', function () {
          pruneRun('dangling', {
            title: 'Prune dangling images', danger: true, confirmLabel: 'Prune',
            what: 'Remove the untagged layers left behind by old pulls?',
            detail: ['Anything still carrying a tag stays, so nothing you can name goes.'],
          });
        });
        document.getElementById('pruneallbtn').addEventListener('click', function () {
          pruneRun('all', {
            title: 'Prune unused images', danger: true, confirmLabel: 'Prune unused',
            what: 'Remove every image no container references?',
            detail: ['Images used by stopped containers are kept. Removed images must be downloaded again.'],
          });
        });
        document.querySelectorAll('.img-rm').forEach(function (b) {
          b.addEventListener('click', function () {
            var name = b.dataset.name;
            qmConfirm({
              title: 'Remove image', danger: true, confirmLabel: 'Remove',
              what: 'Delete this image from the host?',
              detail: [{ c: name }, ' will be permanently removed. Docker refuses while a container still uses it.'],
            }).then(function (yes) {
              if (!yes) return;
              b.disabled = true;
              var t = qmToast('Remove ' + name);
              t.ops.set('r', { state: 'active', label: 'Removing ' + name, note: 'working' });
              post('/images/remove', { id: b.dataset.id }).then(function (d) {
                t.ops.set('r', { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'removed' : 'failed') });
                if (!d.ok) { b.disabled = false; return; }
                // Remove images confirmed absent by the server without a full reload.
                dropRow(b.closest('.t-img'));
                reflectEmpty();
              }).catch(function () { b.disabled = false; t.ops.set('r', { state: 'fail', note: 'could not reach the server' }); });
            });
          });
        });
        // Removing the final tag deletes the image; otherwise it only removes that tag.
        document.querySelectorAll('.tag-rm').forEach(function (b) {
          b.addEventListener('click', function () {
            var ref = b.dataset.ref, last = b.dataset.last === '1';
            qmConfirm({
              title: last ? 'Remove image' : 'Remove tag', danger: true, confirmLabel: 'Remove',
              what: last ? 'Delete this image from the host?' : 'Drop this tag from the image?',
              detail: last
                ? [{ c: ref }, ' is the only tag on it, so the image goes with it. Docker refuses while a container still uses it.']
                : [{ c: ref }, ' stops pointing at this image. The layers stay, because another tag still names them.'],
            }).then(function (yes) {
              if (!yes) return;
              b.disabled = true;
              var t = qmToast('Remove ' + ref);
              t.ops.set('r', { state: 'active', label: 'Removing ' + ref, note: 'working' });
              post('/images/remove', { id: ref }).then(function (d) {
                t.ops.set('r', { state: d.ok ? 'ok' : 'fail', note: d.note || d.error || (d.ok ? 'removed' : 'failed') });
                if (d.ok) t.reloadOnClose(); else b.disabled = false;
              }).catch(function () { b.disabled = false; t.ops.set('r', { state: 'fail', note: 'could not reach the server' }); });
            });
          });
        });
        var ov = document.getElementById('pullov'), ref = document.getElementById('pullref'), pn = document.getElementById('pullnote');
        var go = document.getElementById('pullgo'), cancel = document.getElementById('pullcancel'), landed = false;
        function openM() { ov.hidden = false; pn.textContent = ''; landed = false; go.hidden = false; go.disabled = false; cancel.textContent = 'Cancel'; ref.focus(); }
        function closeM() { ov.hidden = true; if (landed) location.reload(); }
        document.getElementById('pullbtn').addEventListener('click', openM);
        document.getElementById('pullx').addEventListener('click', closeM);
        cancel.addEventListener('click', closeM);
        ov.addEventListener('click', function (e) { if (e.target === ov) closeM(); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !ov.hidden) closeM(); });
        go.addEventListener('click', function () {
          var v = ref.value.trim();
          if (!v) { ref.focus(); return; }
          go.disabled = true;
          // Display operation progress in this dialog.
          var ops = qmOps(pn);
          qmStream('/images/pull', { ref: v }, function (e) {
            ops.set(e.id, { state: e.state, label: e.label, note: e.note, mono: e.mono, pct: e.pct });
          }).then(function (d) {
            go.disabled = false;
            if (!d.ok) { ops.set('verdict', { state: 'fail', label: 'Not pulled', note: d.note || 'failed' }); return; }
            landed = true;
            go.hidden = true;
            cancel.textContent = 'Done';
            cancel.focus();
          }).catch(function () { go.disabled = false; ops.set('verdict', { state: 'fail', label: 'Not pulled', note: 'could not reach the server' }); });
        });
        ref.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
      })();
    </script>` : ''}`);
}
