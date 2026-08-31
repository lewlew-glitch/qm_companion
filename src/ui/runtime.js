// Shared inline runtime for theme, dialogs, operation feedback, streams, and data grids.

import { getPrefs } from '../store.js';
import { I } from './bits.js';

// Apply a saved browser theme before first paint, falling back to the server preference.
export function themeBoot() {
  const fallbackLight = getPrefs().theme === 'light';
  return `<script>try{var t=localStorage.getItem('qm_theme');if(t==='light'||(!t&&${fallbackLight}))document.documentElement.classList.add('light')}catch(e){}</script>`;
}

// Ignore row shortcuts when focus starts in an interactive control.
export function gridKeyStartsInControl(target, row) {
  if (!target || !row || typeof target.closest !== 'function') return false;
  const control = target.closest('a,button,input,select,textarea,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="tab"],[role="menuitem"],[tabindex]');
  return !!(control && control !== row && row.contains(control));
}

// Browser helpers for dialogs, operation status, streams, and SSE.
export function appRuntime() {
  return `
<div class="overlay" id="qmcov" hidden>
  <div class="modal confirm" role="dialog" aria-modal="true" aria-labelledby="qmctitle">
    <div class="modal-h"><b id="qmctitle"></b><button type="button" class="iconbtn" id="qmcx" aria-label="Close">${I.x}</button></div>
    <div class="modal-b"><p class="confirm-what" id="qmcwhat"></p><p class="confirm-detail" id="qmcdetail"></p><input class="in confirm-typed hidden" id="qmctyped" autocomplete="off" spellcheck="false" autocapitalize="off"></div>
    <div class="modal-f"><button type="button" class="btn" id="qmccancel">Cancel</button><button type="button" class="btn" id="qmcgo"></button></div>
  </div>
</div>
<div class="toast" id="qmtoast" hidden role="status" aria-live="polite">
  <div class="toast-h"><b id="qmtoast-t"></b><button type="button" class="iconbtn" id="qmtoast-x" aria-label="Close">${I.x}</button></div>
  <div class="toast-b" id="qmtoast-b"></div>
</div>
<div class="overlay" id="qmmov" hidden>
  <div class="modal mint" role="dialog" aria-modal="true" aria-labelledby="qmmtitle" aria-describedby="qmmflow qmmscope">
    <div class="modal-h"><b id="qmmtitle"></b><button type="button" class="iconbtn" id="qmmx" aria-label="Close">${I.x}</button></div>
    <div class="modal-b">
      <p class="mint-note" id="qmmnote"></p>
      <section class="mint-security" aria-labelledby="qmmsecuritytitle">
        <b id="qmmsecuritytitle">Protections already in place</b>
        <p id="qmmflow"></p>
        <ul class="mint-protections">
          <li><b>Owner protected.</b> You must be signed into Companion. A page security token and an attempt limit protect this action.</li>
          <li><b>Destination locked.</b> <span id="qmmtarget"></span></li>
          <li><b>Bounded request.</b> Redirects are refused, every step has a deadline and response size is capped.</li>
          <li><b>Secrets contained.</b> Your password is not written to state, returned to this browser or added to the audit log. The created key is encrypted at rest and bound to this service.</li>
        </ul>
        <p id="qmmscope"></p>
        <p class="mint-cert" id="qmmcert" hidden></p>
      </section>
      <div class="mint-warning" id="qmmwarning" role="note" hidden>
        <b>Remaining connection risk</b>
        <p id="qmmwarningtext"></p>
        <p>Do not continue on a network you do not trust. You can cancel and paste a key you created in the service instead.</p>
        <label class="mint-consent"><input type="checkbox" id="qmmconsent"><span>I understand that my sign-in details will cross an unencrypted HTTP connection.</span></label>
      </div>
      <label class="mint-field"><span id="qmmulabel"></span><input class="in" id="qmmuser" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label class="mint-field"><span id="qmmplabel"></span><input class="in" id="qmmpass" type="password" autocomplete="new-password" spellcheck="false"></label>
      <div class="mint-ops" id="qmmops"></div>
    </div>
    <div class="modal-f"><button type="button" class="btn" id="qmmcancel">Cancel</button><button type="button" class="btn primary" id="qmmgo">Create key</button></div>
  </div>
</div>
<script>
  (function () {
    var ASK = ${getPrefs().confirmActions};
    var ov = document.getElementById('qmcov');
    var title = document.getElementById('qmctitle'), what = document.getElementById('qmcwhat');
    var det = document.getElementById('qmcdetail'), go = document.getElementById('qmcgo');
    var typed = document.getElementById('qmctyped');
    var settle = null, back = null, expected = null;

    // Build detail lines from text and explicit code fragments, never parsed HTML.
    function parts(el, v) {
      el.textContent = '';
      var a = Array.isArray(v) ? v : [v];
      for (var i = 0; i < a.length; i++) {
        var p = a[i];
        if (!p) continue;
        if (typeof p === 'string') { el.appendChild(document.createTextNode(p)); continue; }
        var c = document.createElement('code'); c.textContent = p.c; el.appendChild(c);
      }
      el.hidden = !el.textContent;
    }
    function shut(v) {
      if (!settle) return;
      var f = settle; settle = null;
      ov.hidden = true;
      document.removeEventListener('keydown', key, true);
      if (back && back.focus) { try { back.focus(); } catch (e) {} }
      f(v);
    }
    // Capture Escape and Enter within the active confirmation dialog.
    function key(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shut(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!go.disabled) shut(true); }
    }
    // Require the resource name for destructive actions.
    typed.addEventListener('input', function () {
      if (expected !== null) go.disabled = typed.value.trim() !== expected;
    });
    go.addEventListener('click', function () { if (!go.disabled) shut(true); });
    document.getElementById('qmccancel').addEventListener('click', function () { shut(false); });
    document.getElementById('qmcx').addEventListener('click', function () { shut(false); });
    ov.addEventListener('click', function (e) { if (e.target === ov) shut(false); });

    window.qmConfirm = function (o) {
      o = o || {};
      // Allow reversible prompts to follow the saved preference.
      if (o.pref && !ASK) return Promise.resolve(true);
      shut(false);
      back = document.activeElement;
      title.textContent = o.title || 'Confirm';
      what.textContent = o.what || '';
      parts(det, o.detail || '');
      go.textContent = o.confirmLabel || 'Confirm';
      go.className = 'btn ' + (o.danger ? 'danger' : 'primary');
      expected = typeof o.typed === 'string' && o.typed ? o.typed : null;
      typed.classList.toggle('hidden', expected === null);
      typed.value = '';
      typed.placeholder = expected === null ? '' : 'Type ' + expected + ' to confirm';
      typed.setAttribute('aria-label', typed.placeholder);
      go.disabled = expected !== null;
      ov.hidden = false;
      document.addEventListener('keydown', key, true);
      (expected === null ? go : typed).focus();
      return new Promise(function (res) { settle = res; });
    };

    // Address operation rows by id so updates reuse the existing step.
    window.qmOps = function (host) {
      var list = document.createElement('div');
      list.className = 'oplist';
      host.textContent = '';
      host.appendChild(list);
      var rows = {};
      return {
        el: list,
        set: function (id, o) {
          var r = rows[id];
          // Ignore updates for unknown rows.
          if (!r && o.label == null) return null;
          if (!r) {
            var el = document.createElement('div');
            var dot = document.createElement('i');
            var lab = document.createElement('div'); lab.className = 'op-label';
            var note = document.createElement('span'); note.className = 'op-note';
            el.appendChild(dot); el.appendChild(lab); el.appendChild(note);
            list.appendChild(el);
            r = rows[id] = { el: el, dot: dot, lab: lab, note: note, bar: null, out: null };
          }
          var st = o.state || 'active';
          r.el.className = 'op ' + st;
          r.dot.className = 'dot ' + st;
          if (o.label != null) r.lab.textContent = o.label;
          if (o.note != null) { r.note.textContent = o.note; r.note.className = 'op-note' + (o.mono ? ' mono' : ''); }
          // Show progress only when provided.
          if (o.pct != null) {
            if (!r.bar) { r.bar = document.createElement('span'); r.bar.className = 'opbar'; r.bar.appendChild(document.createElement('i')); r.el.appendChild(r.bar); }
            r.bar.firstChild.style.transform = 'scaleX(' + (Math.max(0, Math.min(100, o.pct)) / 100).toFixed(3) + ')';
          } else if (o.pct === null && r.bar) { r.bar.remove(); r.bar = null; }
          if (o.out) {
            if (!r.out) { r.out = document.createElement('pre'); r.out.className = 'op-out'; r.el.appendChild(r.out); }
            r.out.textContent = o.out; r.out.hidden = false;
          }
          host.scrollTop = host.scrollHeight;
          return r;
        },
      };
    };

    // Keep table-initiated operation feedback in a persistent toast.
    var toast = document.getElementById('qmtoast');
    document.getElementById('qmtoast-x').addEventListener('click', function () {
      toast.hidden = true;
      if (toast.dataset.reload === '1') location.reload();
    });
    window.qmToast = function (t) {
      document.getElementById('qmtoast-t').textContent = t;
      toast.dataset.reload = '';
      toast.hidden = false;
      return {
        ops: qmOps(document.getElementById('qmtoast-b')),
        reloadOnClose: function () { toast.dataset.reload = '1'; },
      };
    };

    // Key-creation dialog.
    var mov = document.getElementById('qmmov');
    var mtitle = document.getElementById('qmmtitle'), mnote = document.getElementById('qmmnote');
    var muser = document.getElementById('qmmuser'), mpass = document.getElementById('qmmpass');
    var mulabel = document.getElementById('qmmulabel'), mplabel = document.getElementById('qmmplabel');
    var mflow = document.getElementById('qmmflow'), mtarget = document.getElementById('qmmtarget'), mscope = document.getElementById('qmmscope');
    var mcert = document.getElementById('qmmcert'), mwarning = document.getElementById('qmmwarning');
    var mwarningtext = document.getElementById('qmmwarningtext'), mconsent = document.getElementById('qmmconsent');
    var mgo = document.getElementById('qmmgo'), mcancel = document.getElementById('qmmcancel');
    var mback = null, msettle = null, mbusy = false, mneedsConsent = false;
    function mclear() {
      muser.value = '';
      mpass.value = '';
      mconsent.checked = false;
    }
    function mshut(v) {
      var f = msettle; msettle = null;
      mclear();
      if (!f) return;
      mov.hidden = true;
      document.removeEventListener('keydown', mkey, true);
      if (mback && mback.focus) { try { mback.focus(); } catch (e) {} }
      f(v);
    }
    function mscopeCopy(kind, name) {
      if (kind === 'portainer') return 'The token has the same permissions as the ' + name + ' account you enter. Use the least privileged account that still gives Quartermaster the access it needs.';
      if (kind === 'jellyfin' || kind === 'emby') return 'The new key can access the whole ' + name + ' server. You can revoke it from ' + name + ' at any time.';
      return name + ' decides what the created key can access. You can revoke it from the service at any time.';
    }
    function msecurity(o) {
      var name = o.serviceName || 'the selected service';
      var target = null;
      try { if (o.baseUrl) target = new URL(o.baseUrl, location.href); } catch (e) {}
      var address = target ? target.protocol + '//' + target.host : 'its detected address';
      mflow.textContent = 'Companion uses your sign-in details only during this request at ' + address + ' to create a key named Quartermaster. It clears the fields when this window closes, and only the sealed key remains.';
      mtarget.textContent = 'Companion keeps the detected protocol, host and port. This browser cannot swap them, public HTTP is refused and the request connects to the resolved address.';
      mscope.textContent = mscopeCopy(o.kind || '', name);

      var risks = [];
      if (location.protocol !== 'https:') risks.push('This Companion page uses HTTP, so the details are not encrypted between this browser and Companion.');
      if (target && target.protocol === 'http:') risks.push(name + ' also uses HTTP, so the details are not encrypted between Companion and ' + name + '.');
      if (!target) risks.push('Companion cannot show the service transport before this request. Check the address on the setup row before continuing.');
      mneedsConsent = risks.length > 0;
      mwarning.hidden = !mneedsConsent;
      mwarningtext.textContent = risks.join(' ');
      mconsent.checked = false;

      var privateCertNote = target && target.protocol === 'https:';
      mcert.hidden = !privateCertNote;
      mcert.textContent = privateCertNote ? 'Public HTTPS certificates are verified. A private self-signed HTTPS certificate is currently accepted without a saved fingerprint check.' : '';
      mgo.disabled = mneedsConsent;
    }
    function mkey(e) {
      if (e.key === 'Escape' && !mbusy) { e.preventDefault(); e.stopPropagation(); mshut(false); }
    }
    mconsent.addEventListener('change', function () { if (!mbusy) mgo.disabled = mneedsConsent && !mconsent.checked; });
    document.getElementById('qmmx').addEventListener('click', function () { if (!mbusy) mshut(false); });
    mcancel.addEventListener('click', function () { if (!mbusy) mshut(false); });
    mov.addEventListener('click', function (e) { if (e.target === mov && !mbusy) mshut(false); });
    window.qmMintModal = function (o) {
      o = o || {};
      mshut(false);
      mback = document.activeElement;
      mtitle.textContent = o.title || 'Create a key';
      mnote.textContent = o.note || '';
      mnote.hidden = !o.note;
      mulabel.textContent = o.usernameLabel || 'Username';
      mplabel.textContent = o.passwordLabel || 'Password';
      mclear();
      mcancel.disabled = false;
      var ops = qmOps(document.getElementById('qmmops'));
      mbusy = false;
      msecurity(o);
      function go() {
        if (mbusy) return;
        if (mneedsConsent && !mconsent.checked) { mconsent.focus(); return; }
        var user = muser.value.trim(), pass = mpass.value;
        if (!user) { muser.focus(); return; }
        if (!pass) { mpass.focus(); return; }
        mbusy = true; mgo.disabled = true; mcancel.disabled = true;
        Promise.resolve(o.onSubmit(user, pass, function (step) {
          ops.set(step.id, { label: step.label, state: step.state, note: step.note });
        })).then(function (verdict) {
          mbusy = false; mcancel.disabled = false;
          if (verdict && verdict.ok) { mshut(true); return; }
          mgo.disabled = mneedsConsent && !mconsent.checked;
          mpass.value = '';
          ops.set('result', { label: 'Could not create the key', state: 'fail', note: (verdict && verdict.note) || '' });
        }).catch(function () {
          mbusy = false; mcancel.disabled = false; mgo.disabled = mneedsConsent && !mconsent.checked;
          mpass.value = '';
          ops.set('result', { label: 'Could not create the key', state: 'fail', note: 'the request failed' });
        });
      }
      mgo.onclick = go;
      mov.hidden = false;
      document.addEventListener('keydown', mkey, true);
      (mneedsConsent ? mconsent : muser).focus();
      return new Promise(function (res) { msettle = res; });
    };

    // Read newline-delimited progress and settle with the final verdict.
    window.qmStream = function (url, body, onStep) {
      var done = null;
      function feed(line) {
        var e;
        try { e = JSON.parse(line); } catch (err) { return; }
        if (e.t === 'step') { if (onStep) onStep(e); return; }
        done = e.t === 'done' ? e : Object.assign({ t: 'done', ok: !!e.ok, note: e.note || e.error || '' }, e);
      }
      return fetch(url, {
        method: 'POST',
        headers: { 'x-csrf-token': document.querySelector('meta[name=csrf]').content, 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        // Fall back to a buffered response.
        if (!r.body || !r.body.getReader) return r.text().then(function (txt) { txt.split('\\n').forEach(function (l) { if (l.trim()) feed(l); }); });
        var rd = r.body.getReader(), dec = new TextDecoder(), buf = '';
        return (function pump() {
          return rd.read().then(function (c) {
            if (c.value) buf += dec.decode(c.value, { stream: true });
            var i = buf.indexOf('\\n');
            while (i >= 0) { var l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) feed(l); i = buf.indexOf('\\n'); }
            if (c.done) { if (buf.trim()) feed(buf); return; }
            return pump();
          });
        })();
      }).then(function () {
        return done || { t: 'done', ok: false, note: 'the server closed without an answer' };
      });
    };

    // Fall back to polling after repeated stream failures; always:true keeps polling active.
    window.qmLive = function (o) {
      var topics = o.topics || [];
      var fails = 0, timer = null, es = null;
      function poll() {
        if (timer || !o.fallbackPoll) return;
        o.fallbackPoll();
        timer = setInterval(o.fallbackPoll, o.fallbackMs || 5000);
      }
      function stopPoll() {
        if (o.always) return; // Keep required polling active.
        if (timer) { clearInterval(timer); timer = null; }
      }
      function connect() {
        if (!window.EventSource) { poll(); return; }
        es = new EventSource('/api/stream?topics=' + encodeURIComponent(topics.join(',')));
        topics.forEach(function (t) {
          es.addEventListener(t, function (ev) {
            var d;
            try { d = JSON.parse(ev.data); } catch (e) { return; }
            fails = 0;
            stopPoll();
            if (o.onmessage) o.onmessage(t, d);
          });
        });
        es.onerror = function () {
          try { es.close(); } catch (e) {}
          fails += 1;
          if (fails >= 2) poll();
          // Retry with capped exponential backoff.
          setTimeout(connect, Math.min(60000, 5000 * Math.pow(2, fails - 1)));
        };
      }
      if (o.always) poll();
      connect();
      return { close: function () { if (es) try { es.close(); } catch (e) {} if (timer) clearInterval(timer); timer = null; } };
    };

    ${gridKeyStartsInControl.toString()}

    // Shared grid sorting, resizing, column layout, keyboard access, and persisted preferences.
    window.qmGrid = (function () {
      function prefs(id) {
        try { var p = JSON.parse(localStorage.getItem('qm-grid-v1:' + id) || '{}'); return p && typeof p === 'object' ? p : {}; }
        catch (e) { return {}; }
      }
      function save(id, p) { try { localStorage.setItem('qm-grid-v1:' + id, JSON.stringify(p)); } catch (e) {} }

      function defs(table) {
        // Read the column definition from the header.
        var head = table.querySelector('.tr.th');
        var base = (table.dataset.qmBase || table.style.getPropertyValue('--qm-gt')).trim().split(/\\s+(?![^(]*\\))/);
        table.dataset.qmBase = base.join(' ');
        return Array.prototype.map.call(head.children, function (hc, i) {
          return { id: hc.dataset.col, el: hc, track: base[i] || 'auto', sort: hc.dataset.sort || '', type: hc.dataset.sortType || 'text', label: (hc.textContent || '').trim(), fixed: hc.dataset.fixed === '1' || !hc.dataset.col || hc.dataset.col === 'sel' || hc.dataset.col === 'actions' || hc.dataset.col === 'exp' || hc.dataset.col === 'link' };
        });
      }
      function rows(table) { return Array.prototype.filter.call(table.children, function (r) { return r.classList.contains('tr') && !r.classList.contains('th'); }); }

      // Restore table roles after partial row updates.
      function semantics(table) {
        var head = table.querySelector('.tr.th');
        if (head) {
          head.setAttribute('role', 'row');
          Array.prototype.forEach.call(head.children, function (hc) { hc.setAttribute('role', 'columnheader'); });
        }
        rows(table).forEach(function (r) {
          r.setAttribute('role', 'row');
          Array.prototype.forEach.call(r.children, function (td) {
            if (td.dataset.col) td.setAttribute('role', 'cell');
          });
        });
      }

      function layout(table) {
        semantics(table);
        var id = table.dataset.grid, raw = prefs(id), cols = defs(table), byId = {};
        cols.forEach(function (c) { byId[c.id] = c; });
        // Accept only known movable column ids and keep fixed columns at the edges.
        var left = cols.filter(function (c) { return c.fixed && c.id !== 'actions'; }).map(function (c) { return c.id; });
        var right = cols.filter(function (c) { return c.fixed && c.id === 'actions'; }).map(function (c) { return c.id; });
        var movable = cols.filter(function (c) { return !c.fixed; }).map(function (c) { return c.id; });
        var requested = Array.isArray(raw.order) ? raw.order : [];
        var middle = requested.filter(function (cid, at) { return movable.indexOf(cid) >= 0 && requested.indexOf(cid) === at; });
        movable.forEach(function (cid) { if (middle.indexOf(cid) < 0) middle.push(cid); });
        var order = left.concat(middle, right);
        var hidden = (Array.isArray(raw.hidden) ? raw.hidden : []).filter(function (cid, at, all) {
          return byId[cid] && !byId[cid].fixed && all.indexOf(cid) === at;
        });
        var widths = {};
        if (raw.widths && typeof raw.widths === 'object') Object.keys(raw.widths).forEach(function (cid) {
          var value = Number(raw.widths[cid]);
          if (byId[cid] && Number.isFinite(value)) widths[cid] = Math.max(44, Math.min(640, Math.round(value)));
        });
        var p = Object.assign({}, raw, { order: order, hidden: hidden, widths: widths });
        var visible = order.filter(function (c) { return hidden.indexOf(c) < 0; });
        // Build tracks in display order.
        var tracks = visible.map(function (c) { return widths[c] ? widths[c] + 'px' : byId[c].track; });
        table.style.setProperty('--qm-gt', tracks.join(' '));
        // Derive minimum width from visible tracks, gaps, and row padding.
        var gap = parseFloat(getComputedStyle(table.querySelector('.tr.th')).columnGap) || 14;
        var minSum = 32 + gap * Math.max(0, tracks.length - 1);
        tracks.forEach(function (t) {
          var m = /^(\\d+(?:\\.\\d+)?)px$/.exec(t) || /^minmax\\((\\d+(?:\\.\\d+)?)px/.exec(t);
          if (m) minSum += parseFloat(m[1]);
        });
        table.style.minWidth = Math.ceil(minSum) + 'px';
        // Reorder row cells in DOM order and hide disabled columns.
        var all = [table.querySelector('.tr.th')].concat(rows(table));
        all.forEach(function (r) {
          var cells = {};
          Array.prototype.forEach.call(r.children, function (td) { if (td.dataset.col) cells[td.dataset.col] = td; });
          order.forEach(function (cid) {
            var td = cells[cid];
            if (!td) return;
            td.classList.toggle('hidden', hidden.indexOf(cid) >= 0);
            r.appendChild(td);
          });
        });
        // Reposition the pinned column after layout changes.
        if (table.qmPin) table.qmPin();
        return { cols: cols, order: order, hidden: hidden, widths: widths, prefs: p };
      }

      function applySort(table, silent) {
        var id = table.dataset.grid, p = prefs(id);
        var head = table.querySelector('.tr.th');
        Array.prototype.forEach.call(head.children, function (hc) {
          hc.removeAttribute('data-dir');
          if (hc.dataset.sort) hc.setAttribute('aria-sort', 'none');
        });
        if (!p.sort || !p.sort.attr) return;
        var hc = head.querySelector('[data-sort="' + p.sort.attr + '"]');
        if (!hc) return;
        hc.setAttribute('data-dir', p.sort.dir);
        hc.setAttribute('aria-sort', p.sort.dir === 'desc' ? 'descending' : 'ascending');
        var type = hc.dataset.sortType || 'text', dir = p.sort.dir === 'desc' ? -1 : 1;
        var list = rows(table);
        var keyed = list.map(function (r, i) {
          var v = r.dataset[p.sort.attr] != null ? r.dataset[p.sort.attr] : '';
          // Keep each detail row with its parent.
          var fold = r.nextElementSibling && !r.nextElementSibling.classList.contains('tr') ? r.nextElementSibling : null;
          return { r: r, fold: fold, i: i, v: type === 'num' ? (parseFloat(v) || 0) : String(v).toLowerCase() };
        });
        keyed.sort(function (a, b) {
          if (a.v < b.v) return -1 * dir;
          if (a.v > b.v) return 1 * dir;
          return a.i - b.i; // stable: equal keys keep their order
        });
        keyed.forEach(function (k) { table.appendChild(k.r); if (k.fold) table.appendChild(k.fold); });
        if (!silent && table.dataset.onsort) { try { window[table.dataset.onsort](); } catch (e) {} }
      }

      function wire(table) {
        var id = table.dataset.grid;
        var state = layout(table);
        applySort(table, true);
        var head = table.querySelector('.tr.th');

        // Shift the actions track with horizontal overflow to keep it at the scrollport edge.
        var wrap = table.closest('.gwrap');
        if (wrap && head.querySelector('[data-col="actions"]')) {
          var pinRaf = null;
          var pin = function () {
            pinRaf = null;
            var remaining = Math.max(0, wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft);
            table.style.setProperty('--pinshift', (-remaining) + 'px');
          };
          var askPin = function () { if (!pinRaf) pinRaf = requestAnimationFrame(pin); };
          wrap.addEventListener('scroll', askPin);
          window.addEventListener('resize', askPin);
          table.qmPin = askPin;
          pin();
        }

        // Cycle column sorting through ascending, descending, and off.
        head.addEventListener('click', function (e) {
          var btn = e.target.closest('[data-sort-btn]');
          if (!btn) return;
          var hc = btn.closest('.hc'), attr = hc.dataset.sort;
          var p = prefs(id);
          var cur = p.sort && p.sort.attr === attr ? p.sort.dir : null;
          p.sort = cur === 'asc' ? { attr: attr, dir: 'desc' } : cur === 'desc' ? null : { attr: attr, dir: 'asc' };
          save(id, p);
          applySort(table);
        });

        // Use one persisted resize path for pointer and keyboard input.
        Array.prototype.forEach.call(head.children, function (hc) {
          if (!hc.dataset.col) return;
          var grip = document.createElement('span');
          grip.className = 'hgrip';
          grip.tabIndex = 0;
          grip.setAttribute('role', 'separator');
          grip.setAttribute('aria-orientation', 'vertical');
          grip.setAttribute('aria-valuemin', '44');
          grip.setAttribute('aria-valuemax', '640');
          grip.setAttribute('aria-label', 'Resize ' + ((hc.textContent || '').trim() || hc.dataset.col) + ' column');
          hc.appendChild(grip);
          function setWidth(value) {
            var w = Math.max(44, Math.min(640, Math.round(value)));
            var p2 = prefs(id);
            p2.widths = p2.widths || {};
            p2.widths[hc.dataset.col] = w;
            save(id, p2);
            layout(table);
            grip.setAttribute('aria-valuenow', String(w));
            grip.setAttribute('aria-valuetext', w + ' pixels');
          }
          function syncWidth() {
            var w = Math.max(44, Math.min(640, Math.round(hc.getBoundingClientRect().width)));
            grip.setAttribute('aria-valuenow', String(w));
            grip.setAttribute('aria-valuetext', w + ' pixels');
          }
          syncWidth();
          grip.addEventListener('focus', syncWidth);
          grip.addEventListener('pointerdown', function (e) {
            e.preventDefault(); e.stopPropagation();
            grip.classList.add('on');
            var startX = e.clientX, startW = hc.getBoundingClientRect().width;
            function move(ev) {
              setWidth(startW + (ev.clientX - startX));
            }
            function up() {
              grip.classList.remove('on');
              document.removeEventListener('pointermove', move);
              document.removeEventListener('pointerup', up);
            }
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
          });
          grip.addEventListener('keydown', function (e) {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return;
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Home') {
              var p2 = prefs(id);
              if (p2.widths) delete p2.widths[hc.dataset.col];
              save(id, p2);
              layout(table);
              syncWidth();
              return;
            }
            var step = e.shiftKey ? 25 : 10;
            setWidth(hc.getBoundingClientRect().width + (e.key === 'ArrowRight' ? step : -step));
          });
        });

      // Mount the column settings control.
        var slot = document.querySelector('[data-grid-gear]');
        if (slot && !slot.dataset.wired) {
          slot.dataset.wired = '1';
          var gear = document.createElement('button');
          gear.type = 'button';
          gear.className = 'iconbtn';
          gear.title = 'Columns';
          gear.setAttribute('aria-label', 'Choose and order columns');
          gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>';
          slot.appendChild(gear);
          var menu = null;
          function closeMenu() { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey, true); } }
          function onDoc(e) { if (menu && !menu.contains(e.target) && e.target !== gear) closeMenu(); }
          function onKey(e) { if (e.key === 'Escape') { closeMenu(); gear.focus(); } }
          function buildMenu() {
            var p = prefs(id), st = layout(table);
            menu = document.createElement('div');
            menu.className = 'colmenu';
            menu.setAttribute('role', 'dialog');
            menu.setAttribute('aria-label', 'Columns');
            var h = document.createElement('div'); h.className = 'cm-h'; h.textContent = 'Columns'; menu.appendChild(h);
            var byId = {};
            st.cols.forEach(function (c) { byId[c.id] = c; });
            st.order.forEach(function (cid, idx) {
              var c = byId[cid];
              if (!c || c.fixed) return;
              var row = document.createElement('label'); row.className = 'cm-row';
              var box = document.createElement('input'); box.type = 'checkbox';
              box.checked = st.hidden.indexOf(cid) < 0;
              box.addEventListener('change', function () {
                var p2 = prefs(id);
                p2.hidden = (p2.hidden || []).filter(function (x) { return x !== cid; });
                if (!box.checked) p2.hidden.push(cid);
                save(id, p2);
                layout(table);
              });
              var word = document.createElement('span'); word.textContent = c.label || cid;
              var mv = document.createElement('span'); mv.className = 'cm-move';
              [['up', -1], ['down', 1]].forEach(function (m) {
                var b = document.createElement('button');
                b.type = 'button';
                b.title = 'Move ' + m[0];
                b.setAttribute('aria-label', 'Move ' + (c.label || cid) + ' ' + m[0]);
                b.textContent = m[1] < 0 ? '\\u2191' : '\\u2193';
                b.addEventListener('click', function (e) {
                  e.preventDefault();
                  var p2 = prefs(id), st2 = layout(table);
                  var o = st2.order.slice(), at = o.indexOf(cid), to = at + m[1];
                  // Move configurable columns only.
                  if (to < 0 || to >= o.length || (byId[o[to]] && byId[o[to]].fixed)) return;
                  o[at] = o[to]; o[to] = cid;
                  p2.order = o;
                  save(id, p2);
                  layout(table);
                  closeMenu(); buildMenu(); place();
                });
                mv.appendChild(b);
              });
              row.appendChild(box); row.appendChild(word); row.appendChild(mv);
              menu.appendChild(row);
            });
            var foot = document.createElement('div'); foot.className = 'cm-foot';
            var reset = document.createElement('button'); reset.type = 'button'; reset.className = 'cm-reset'; reset.textContent = 'Reset layout';
            reset.addEventListener('click', function () {
              try { localStorage.removeItem('qm-grid-v1:' + id); } catch (e) {}
              layout(table); applySort(table, true); closeMenu();
            });
            foot.appendChild(reset); menu.appendChild(foot);
            document.body.appendChild(menu);
            document.addEventListener('click', onDoc, true);
            document.addEventListener('keydown', onKey, true);
          }
          function place() {
            if (!menu) return;
            var r = gear.getBoundingClientRect();
            menu.style.top = (r.bottom + 6 + window.scrollY) + 'px';
            menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth + window.scrollX)) + 'px';
          }
          gear.addEventListener('click', function () {
            if (menu) { closeMenu(); return; }
            buildMenu(); place();
          });
        }

      // Keyboard navigation for actionable rows.
        if (table.dataset.rowclick) {
          rows(table).forEach(function (r) { r.tabIndex = 0; });
          table.addEventListener('keydown', function (e) {
            var r = e.target.closest('.tr');
            if (!r || r.classList.contains('th')) return;
            if (gridKeyStartsInControl(e.target, r)) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.click(); }
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              var list = rows(table).filter(function (x) { return x.style.display !== 'none'; });
              var at = list.indexOf(r), to = at + (e.key === 'ArrowDown' ? 1 : -1);
              if (to >= 0 && to < list.length) list[to].focus();
            }
          });
        }
        return state;
      }

      var registry = {};
      document.addEventListener('DOMContentLoaded', function () {
        document.querySelectorAll('.qm-grid[data-grid]').forEach(function (t) { registry[t.dataset.grid] = wire(t); });
      });
      return {
        // Reapply layout and keyboard state after partial refreshes without re-sorting.
        refresh: function (table) {
          layout(table);
          if (table.dataset.rowclick) rows(table).forEach(function (r) { r.tabIndex = 0; });
          if (table.qmPin) table.qmPin();
        },
      };
    })();
  })();
</script>`;
}
