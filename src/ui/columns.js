// Shared table-column definitions.

import { escapeHtml } from '../http.js';

const col = (id, label, track, extra = {}) => Object.freeze({ id, label, track, hide: true, ...extra });

export const GRIDS = Object.freeze({
  services: Object.freeze({
    minWidth: 760,
    columns: Object.freeze([
      col('state', 'State', '108px', { sort: { attr: 'state' } }),
      col('service', 'Service', 'minmax(170px, 1fr)', { hide: false, sort: { attr: 'service' } }),
      col('route', 'Route', 'minmax(240px, 1.5fr)', { sort: { attr: 'route' } }),
      col('pairing', 'Pairing', '172px', { sort: { attr: 'pairing' } }),
    ]),
  }),
  containers: Object.freeze({
    minWidth: 1190,
    controlMinWidth: 1210,
    gap: 12, // Container rows use a 12px gap.
    // Control mode adds selection; all other container attributes have independent columns.
    columns: Object.freeze([
      col('sel', '', '24px', { hide: false, control: true }),
      col('name', 'Name', 'minmax(140px, 1fr)', { hide: false, sort: { attr: 'name' } }),
      col('image', 'Image', 'minmax(170px, 1.4fr)', { sort: { attr: 'image' } }),
      col('state', 'State', '104px', { sort: { attr: 'state' } }),
      col('health', 'Health', '102px', { sort: { attr: 'health' } }),
      col('uptime', 'Uptime', '78px'),
      col('restarts', 'Restarts', '68px', { align: 'right', sort: { attr: 'restarts', type: 'num' }, live: true }),
      col('cpu', 'CPU', '104px', { align: 'right', sort: { attr: 'cpu', type: 'num' }, live: true }),
      col('mem', 'Memory', '96px', { align: 'right', sort: { attr: 'mem', type: 'num' }, live: true }),
      col('netio', 'Net I/O', '92px', { title: 'bytes received and sent since the container started' }),
      col('diskio', 'Disk I/O', '92px', { title: 'bytes read and written since the container started' }),
      col('ip', 'IP', '118px', { sort: { attr: 'ip' } }),
      col('ports', 'Ports', 'minmax(110px, 1fr)'),
      col('update', 'Update', '94px', { sort: { attr: 'update' } }),
      col('stack', 'Stack', '92px', { sort: { attr: 'stack' } }),
      col('actions', 'Actions', '100px', { hide: false, align: 'right', controlTrack: '248px' }),
    ]),
  }),
  stacks: Object.freeze({
    minWidth: 1040,
    gap: 12,
    columns: Object.freeze([
      col('exp', '', '24px', { hide: false }),
      col('stack', 'Stack', 'minmax(210px, 1.4fr)', { hide: false, sort: { attr: 'name' } }),
      col('source', 'Source', '104px', { sort: { attr: 'source' } }),
      col('running', 'Running', '76px', { align: 'right', sort: { attr: 'running', type: 'num' }, title: 'running containers / total containers' }),
      col('state', 'State', '118px', { sort: { attr: 'state' } }),
      col('cpu', 'CPU', '76px', { align: 'right', sort: { attr: 'cpu', type: 'num' }, live: true }),
      col('mem', 'Memory', '88px', { align: 'right', sort: { attr: 'mem', type: 'num' }, live: true }),
      col('updates', 'Updates', '104px', { sort: { attr: 'update', type: 'num' } }),
      col('resources', 'Resources', '128px', { sort: { attr: 'resources', type: 'num' } }),
      col('actions', 'Actions', '82px', { hide: false, align: 'right' }),
    ]),
  }),
  images: Object.freeze({
    minWidth: 940,
    columns: Object.freeze([
      col('exp', '', '24px', { hide: false }),
      col('repo', 'Image', '2.4fr', { hide: false, sort: { attr: 'repo' } }),
      col('id', 'ID', '110px'),
      col('tags', 'Tags', '56px', { align: 'right', sort: { attr: 'tags', type: 'num' } }),
      col('size', 'Size', '84px', { align: 'right', sort: { attr: 'size', type: 'num' } }),
      col('created', 'Created', '128px', { align: 'right', sort: { attr: 'created', type: 'num' } }),
      col('actions', '', '64px', { hide: false, align: 'right' }),
    ]),
  }),
  volumes: Object.freeze({
    minWidth: 940,
    columns: Object.freeze([
      col('name', 'Name', 'minmax(170px, 1.3fr)', { hide: false, sort: { attr: 'name' } }),
      col('driver', 'Driver', '78px', { sort: { attr: 'driver' } }),
      col('stack', 'Stack', 'minmax(90px, .7fr)'),
      col('usedby', 'Used by', '64px', { align: 'right' }),
      col('size', 'Size', '92px', { align: 'right' }),
      col('mount', 'Mount point', 'minmax(150px, 1.4fr)'),
      col('created', 'Created', '132px', { align: 'right', sort: { attr: 'created', type: 'num' } }),
      col('actions', '', '60px', { hide: false, align: 'right' }),
    ]),
  }),
  networks: Object.freeze({
    minWidth: 880,
    columns: Object.freeze([
      col('name', 'Name', '1.4fr', { hide: false, sort: { attr: 'name' } }),
      col('driver', 'Driver', '90px', { sort: { attr: 'driver' } }),
      col('scope', 'Scope', '68px', { sort: { attr: 'scope' } }),
      col('subnet', 'Subnet', '1.2fr'),
      col('gateway', 'Gateway', '1.2fr'),
      col('attached', 'Containers', '92px', { align: 'right', sort: { attr: 'attached', type: 'num' } }),
      col('actions', 'Actions', '64px', { hide: false, align: 'right' }),
    ]),
  }),
  cron: Object.freeze({
    minWidth: 860,
    columns: Object.freeze([
      col('exp', '', '26px', { hide: false }),
      col('job', 'Job', '1.6fr', { hide: false, sort: { attr: 'job' } }),
      col('schedule', 'Schedule', '140px'),
      col('last', 'Last run', '190px', { sort: { attr: 'last', type: 'num' } }),
      col('next', 'Next run', '140px', { sort: { attr: 'next', type: 'num' } }),
      col('status', 'Status', '70px', { sort: { attr: 'enabled' } }),
      col('actions', 'Actions', '118px', { hide: false, align: 'right' }),
    ]),
  }),
  activity: Object.freeze({
    minWidth: 640,
    columns: Object.freeze([
      col('when', 'Timestamp', '118px', { hide: false, sort: { attr: 'ts', type: 'num' } }),
      col('action', 'Action', '130px', { sort: { attr: 'action' } }),
      col('container', 'Container', '1fr', { sort: { attr: 'cname' } }),
      col('image', 'Image', '1.4fr'),
      col('exit', 'Exit', '52px', { align: 'right' }),
      col('link', '', '44px', { hide: false, align: 'right' }),
    ]),
  }),
});

// Apply control-only columns and control-specific track widths for this render.
export function gridColumns(gridId, { control = false } = {}) {
  const grid = GRIDS[gridId];
  if (!grid) throw new Error(`unknown grid "${gridId}"`);
  return grid.columns
    .filter((c) => !c.control || control)
    .map((c) => (control && c.controlTrack ? { ...c, track: c.controlTrack } : c));
}

export function gridTemplate(gridId, opts) {
  return gridColumns(gridId, opts).map((c) => c.track).join(' ');
}

// Return the pixel floor of fixed and minmax tracks; fractional tracks contribute zero.
function trackMin(track) {
  const px = /^(\d+(?:\.\d+)?)px$/.exec(track);
  if (px) return Number(px[1]);
  const mm = /^minmax\((\d+(?:\.\d+)?)px/.exec(track);
  if (mm) return Number(mm[1]);
  return 0;
}

// Compute minimum width from track floors, gaps, and padding, bounded by the grid floor.
export function gridMinWidth(gridId, opts = {}) {
  const grid = GRIDS[gridId];
  const cols = gridColumns(gridId, opts);
  const gap = grid.gap == null ? 14 : grid.gap;
  const padding = 32;
  const sum = cols.reduce((n, c) => n + trackMin(c.track), 0) + gap * (cols.length - 1) + padding;
  const floor = opts.control && grid.controlMinWidth ? grid.controlMinWidth : grid.minWidth;
  return Math.max(floor || 0, Math.ceil(sum));
}

// Render header cells with column IDs and optional sort controls.
export function gridHeader(gridId, opts = {}) {
  const cells = gridColumns(gridId, opts).map((c) => {
    const fallbackLabel = { sel: 'Selection', exp: 'Details', actions: 'Actions', link: 'Open' }[c.id] || c.id;
    const attrs = [
      `class="hc${c.align === 'right' ? ' num' : ''}"`,
      'role="columnheader"',
      `data-col="${c.id}"`,
      c.hide === false ? 'data-fixed="1"' : '',
      c.sort ? `data-sort="${c.sort.attr}" data-sort-type="${c.sort.type || 'text'}" aria-sort="none"` : '',
      !c.label ? `aria-label="${escapeHtml(fallbackLabel)}"` : '',
      c.title ? `title="${escapeHtml(c.title)}"` : '',
    ].filter(Boolean).join(' ');
    if (c.id === 'sel') return `<div ${attrs}><input type="checkbox" id="selall" aria-label="Select every row"></div>`;
    const word = c.sort
      ? `<button type="button" class="hsort" data-sort-btn>${escapeHtml(c.label)}<span class="sarrow" aria-hidden="true"></span></button>`
      : escapeHtml(c.label);
    return `<div ${attrs}>${word}</div>`;
  }).join('');
  return `<div class="tr ${opts.rowClass || ''} th" role="row">${cells}</div>`;
}

// Open a scrollable grid with the computed track template and minimum width.
export function gridOpen(gridId, opts = {}) {
  const min = gridMinWidth(gridId, opts);
  const count = gridColumns(gridId, opts).length;
  const cls = ['table', 'qm-grid', opts.tableClass || ''].filter(Boolean).join(' ');
  const label = opts.label || `${gridId[0].toUpperCase()}${gridId.slice(1)} table`;
  const extra = [
    opts.id ? `id="${opts.id}"` : '',
    opts.rowClick ? 'data-rowclick="1"' : '',
  ].filter(Boolean).join(' ');
  return `<div class="gwrap"><div class="${cls}" role="table" aria-label="${escapeHtml(label)}" aria-colcount="${count}" data-grid="${gridId}" ${extra} style="--qm-gt: ${gridTemplate(gridId, opts)}; min-width: ${min}px">`;
}

export function gridClose() {
  return '</div></div>';
}
