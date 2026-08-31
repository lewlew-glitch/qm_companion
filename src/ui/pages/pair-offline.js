import { escapeHtml } from '../../http.js';
import { dockerStateWord } from '../../availability.js';
import { availabilityOf } from '../../build.js';
import { tag } from '../bits.js';
import { pairOfflineScript } from './pair-offline-script.js';

// Offline service rows. Polling is defined in pair-offline-script.js.

export const GROUP_BY_AVAILABILITY = {
  reachable: 'reachable', unreachable: 'unreachable', 'not-running': 'stopped', unverified: 'unverified',
};

export function pairGroupFor(d) {
  return GROUP_BY_AVAILABILITY[availabilityOf(d)] || 'unverified';
}

export function availabilityChip(availability, dockerState) {
  if (availability === 'not-running') return tag('bad', dockerStateWord(dockerState), 'alert');
  if (availability === 'unreachable') return tag('warn', 'Unreachable from Companion', 'alert');
  if (availability === 'unverified') return tag('line', 'Not checked');
  return '';
}

// Share availability notes between server rendering and live updates.
export function availabilityNoteText(availability, url, dockerState) {
  if (availability === 'not-running') return dockerStateWord(dockerState) + ' in Docker. Start it in Docker; this page updates on its own.';
  if (availability === 'unreachable') return 'Running in Docker, but Companion could not reach it at ' + (url || 'its address') + '. Companion checks from inside its own container, so a different Docker network, host networking or a VPN can hide a service your phone can reach.';
  if (availability === 'unverified') {
    // Preserve Docker's running state when only the reachability check is missing.
    if (String(dockerState || '').toLowerCase() === 'running') return 'Running in Docker. Companion has not checked its published address. Include it if you want; it is checked on the phone before it is saved.';
    return 'Not checked: Companion has no Docker state or probe answer for this service. Include it if you know it is running; it is checked on the phone before it is saved.';
  }
  return '';
}

export const INCLUDE_ANYWAY_COPY = 'Your phone may reach it even though Companion cannot; it will be checked on the phone before it is saved.';

// The advanced override, rendered only into an unreachable row. Not-running rows never get one.
export function includeAnywayMarkup() {
  return `<span class="pair-advanced"><button type="button" class="pair-include-anyway" data-include-anyway>Include anyway</button><small>${escapeHtml(INCLUDE_ANYWAY_COPY)}</small></span>`;
}

export function availabilityNoteMarkup(d, fallbackUrl, index) {
  const availability = availabilityOf(d);
  const hidden = availability === 'reachable' ? ' hidden' : '';
  const override = availability === 'unreachable' ? includeAnywayMarkup() : '';
  return `<div class="cc-hint pair-avail-note" data-avail-note${hidden}><span data-avail-note-text>${escapeHtml(availabilityNoteText(availability, d.url || fallbackUrl, d.dockerState))}</span><span data-override-slot>${override}</span></div>
      <input type="hidden" name="force_${index}" value="" data-force-flag>`;
}

// Append exclusion counts to readiness; this function is mirrored into the page script.
export function pairReadinessLine(readiness, counts) {
  var parts = [readiness.line];
  var unreachable = counts && counts.unreachable ? counts.unreachable : 0;
  var stopped = counts && counts.stopped ? counts.stopped : 0;
  if (unreachable) parts.push(unreachable + ' unreachable, not included');
  if (stopped) parts.push(stopped + ' not running');
  return parts.join(' · ');
}

const SECTIONS = {
  unreachable: {
    title: 'Not reachable from Companion',
    hint: 'Docker reports these services as running, but Companion cannot reach them. Check their Docker network, host networking or VPN settings. You can include a service manually while this page continues checking.',
  },
  stopped: {
    title: 'Not running',
    hint: 'Docker reports these containers are not running, so they cannot be handed over. Start one in Docker; this page updates on its own.',
  },
  unverified: {
    title: 'Not checked',
    hint: 'Companion has not checked these at an address it trusts: either it has no probe answer yet, or no Docker state for them at all. Each row says which. Tick one if you know it is running; the phone tests every route before it is saved.',
  },
};

export function availabilitySectionMarkup(group, rows, hidden) {
  const copy = SECTIONS[group];
  return `<div class="pair-avail-section pair-avail-${group}" data-pair-section="${group}"${hidden ? ' hidden' : ''}>
      <div class="sec-h">${escapeHtml(copy.title)}</div>
      <p class="cc-hint">${escapeHtml(copy.hint)}</p>
      <div class="pair-services" data-pair-${group}-rows>${rows}</div>
    </div>`;
}

export function availabilitySectionsMarkup(groups) {
  return ['unreachable', 'stopped', 'unverified']
    .map((group) => availabilitySectionMarkup(group, (groups[group] || []).join(''), (groups[group] || []).length === 0))
    .join('\n');
}

export const PAIR_OFFLINE_SCRIPT = pairOfflineScript({
  noteTextSource: `${availabilityNoteText.toString()}\n        ${pairReadinessLine.toString()}`,
  includeAnywayHtml: includeAnywayMarkup(),
});
