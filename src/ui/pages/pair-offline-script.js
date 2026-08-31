import { dockerStateWord } from '../../availability.js';
import { tag } from '../bits.js';

// Client-side availability groups for the setup page.

const UNREACHABLE_CHIP = tag('warn', 'Unreachable from Companion', 'alert');
const UNVERIFIED_CHIP = tag('line', 'Not checked');
const BAD_CHIP_OPEN = '<span class="badge bad">';

// Helpers are injected by pair-offline.js.
export function pairOfflineScript({ noteTextSource, includeAnywayHtml }) {
  return `
        var UNREACHABLE_CHIP = ${JSON.stringify(UNREACHABLE_CHIP).replace(/</g, '\\u003c')};
        var UNVERIFIED_CHIP = ${JSON.stringify(UNVERIFIED_CHIP).replace(/</g, '\\u003c')};
        var BAD_CHIP_OPEN = ${JSON.stringify(BAD_CHIP_OPEN).replace(/</g, '\\u003c')};
        var INCLUDE_ANYWAY_HTML = ${JSON.stringify(includeAnywayHtml).replace(/</g, '\\u003c')};
        var OFFLINE_MISSES = 2;
        var ALERT_ICON = typeof ALERT === 'string' ? ALERT : '';
        ${dockerStateWord.toString()}
        ${noteTextSource}
        var GROUP_OF = { reachable: 'reachable', unreachable: 'unreachable', 'not-running': 'stopped', unverified: 'unverified' };
        var groups = {
          reachable: document.querySelector('[data-pair-reachable-rows]'),
          unreachable: document.querySelector('[data-pair-unreachable-rows]'),
          stopped: document.querySelector('[data-pair-stopped-rows]'),
          unverified: document.querySelector('[data-pair-unverified-rows]'),
        };
        function sectionFor(group) { return document.querySelector('[data-pair-section="' + group + '"]'); }
        // Preserve the owner's selection during polling.
        function pickOf(row) { return row.querySelector('.pair-pick input'); }
        function seedIntent() {
          Array.prototype.forEach.call(document.querySelectorAll('[data-pair-row]'), function (row) {
            var pick = pickOf(row);
            if (pick && row.dataset.intent === undefined) row.dataset.intent = pick.checked ? '1' : '0';
          });
        }
        seedIntent();
        document.addEventListener('change', function (event) {
          var input = event.target;
          if (!input || !input.closest) return;
          var holder = input.closest('.pair-pick');
          if (!holder) return;
          var row = input.closest('[data-pair-row]');
          if (row) row.dataset.intent = input.checked ? '1' : '0';
        });
        function holdsFocus(row) {
          var active = document.activeElement;
          return !!active && active !== document.body && row.contains(active);
        }
        function placeInOrder(container, row) {
          if (!container) return;
          if (row.parentNode === container) { delete row.dataset.pendingMove; return; }
          if (holdsFocus(row)) { row.dataset.pendingMove = '1'; return; }
          var order = Number(row.dataset.order || 0), next = null;
          Array.prototype.some.call(container.children, function (child) {
            if (Number(child.dataset.order || 0) > order) { next = child; return true; }
            return false;
          });
          container.insertBefore(row, next);
          delete row.dataset.pendingMove;
        }
        function settleMove(row) {
          if (!row.dataset.pendingMove) return;
          placeInOrder(groups[GROUP_OF[row.dataset.avail] || 'unverified'], row);
        }
        function rowsIn(avail) { return Array.prototype.slice.call(document.querySelectorAll('[data-pair-row][data-avail="' + avail + '"]')); }
        function leftOutCounts() {
          // Count only selected services.
          var unreachable = rowsIn('unreachable').filter(function (row) {
            var pick = pickOf(row);
            return !(pick && pick.checked);
          }).length;
          return { unreachable: unreachable, stopped: rowsIn('not-running').length };
        }
        function countOffline() { var c = leftOutCounts(); return c.unreachable + c.stopped; }
        function syncSections() {
          ['unreachable', 'stopped', 'unverified'].forEach(function (group) {
            var section = sectionFor(group); if (!section) return;
            section.hidden = !groups[group] || groups[group].children.length === 0;
          });
        }
        function availabilityChipHtml(avail, dockerState) {
          if (avail === 'not-running') return BAD_CHIP_OPEN + ALERT_ICON + dockerStateWord(dockerState) + '\\u003c/span>';
          if (avail === 'unreachable') return UNREACHABLE_CHIP;
          return UNVERIFIED_CHIP;
        }
        function includeAnyway(row) {
          var pick = row.querySelector('.pair-pick input'), flag = row.querySelector('[data-force-flag]');
          if (!pick || row.dataset.avail !== 'unreachable' || row.dataset.credState === 'conflict') return;
          row.dataset.forced = '1';
          row.dataset.intent = '1';
          if (flag) flag.value = 'on';
          pick.disabled = false;
          pick.checked = true;
          if (typeof recount === 'function') recount();
        }
        document.addEventListener('click', function (event) {
          var btn = event.target && event.target.closest ? event.target.closest('[data-include-anyway]') : null;
          if (!btn) return;
          var row = btn.closest('[data-pair-row]');
          if (row) includeAnyway(row);
        });
        function setAvailability(row, availability, dockerState, url) {
          var was = row.dataset.avail, now = GROUP_OF[availability] ? availability : 'unverified';
          var pick = row.querySelector('.pair-pick input'), wrap = row.querySelector('[data-cred]');
          var note = row.querySelector('[data-avail-note]'), noteText = row.querySelector('[data-avail-note-text]');
          var slot = row.querySelector('[data-override-slot]'), flag = row.querySelector('[data-force-flag]');
          var state = typeof dockerState === 'string' ? dockerState : '';
          if (now === 'unreachable' && was !== 'unreachable' && was !== 'not-running') {
            var misses = Number(row.dataset.misses || 0) + 1;
            row.dataset.misses = String(misses);
            if (misses < OFFLINE_MISSES) return;
          }
          if (now !== 'unreachable') row.dataset.misses = '0';
          var text = availabilityNoteText(now, url || row.dataset.url || '', state);
          if (noteText && noteText.textContent !== text) noteText.textContent = text;
          if (url) row.dataset.url = url;
          if (was === now) {
            if (now === 'not-running' && row.dataset.dockerState !== state) {
              row.dataset.dockerState = state;
              if (wrap) wrap.innerHTML = availabilityChipHtml(now, state);
            }
            settleMove(row);
            return;
          }
          row.dataset.avail = now;
          row.dataset.dockerState = state;
          if (now !== 'unreachable') {
            // Preserve override intent across status changes.
            if (slot) slot.innerHTML = '';
          }
          if (now === 'not-running') {
            pick.checked = false;
            pick.disabled = true;
            if (wrap) wrap.innerHTML = availabilityChipHtml(now, state);
            if (note) note.hidden = false;
          } else if (now === 'unreachable') {
            // Restore saved intent for unreachable services.
            if (!row.dataset.forced) { pick.checked = false; pick.disabled = true; }
            else if (row.dataset.credState !== 'conflict') { pick.disabled = false; pick.checked = row.dataset.intent === '1'; }
            if (wrap) wrap.innerHTML = availabilityChipHtml(now, state);
            if (slot && !slot.innerHTML) slot.innerHTML = INCLUDE_ANYWAY_HTML;
            if (note) note.hidden = false;
          } else if (now === 'reachable') {
            if (row.dataset.credState !== 'conflict') pick.disabled = false;
            if (was === 'unreachable' || was === 'not-running') pick.checked = row.dataset.intent === '1' && !pick.disabled;
            if (wrap) wrap.innerHTML = chipHtml(row.dataset.credState);
            if (note) note.hidden = true;
          } else {
            // Restore the saved selection for unverified services.
            if (row.dataset.credState !== 'conflict') pick.disabled = false;
            if (was === 'unreachable' || was === 'not-running') pick.checked = row.dataset.intent === '1' && !pick.disabled;
            if (wrap) wrap.innerHTML = availabilityChipHtml(now, state);
            if (note) note.hidden = false;
          }
          placeInOrder(groups[GROUP_OF[now]], row);
          syncSections();
        }
        document.addEventListener('focusout', function (event) {
          var row = event.target && event.target.closest ? event.target.closest('[data-pair-row]') : null;
          if (row) setTimeout(function () { if (!holdsFocus(row)) { settleMove(row); syncSections(); } }, 0);
        });
`;
}
