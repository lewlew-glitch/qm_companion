// Shared grid layout. Track definitions come from the --qm-gt custom property.

export const grid = `/* ---------- shared grid ---------- */
/* Scroll container for sticky headers and horizontal overflow. */
.gwrap { overflow: auto; max-height: calc(100vh - 240px); min-height: 160px; border-radius: var(--radius); position: relative; }
.gwrap .table { border-radius: var(--radius); }
.qm-grid > .tr { grid-template-columns: var(--qm-gt); }
.qm-grid > .tr.th { position: sticky; top: 0; z-index: 5; background: var(--lift); box-shadow: 0 1px 0 var(--border); }
/* Sort controls. */
.hsort { border: 0; background: none; padding: 0; font: inherit; color: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; max-width: 100%; }
.hsort:hover { color: var(--fg); }
.sarrow { width: 0; height: 0; flex: none; }
/* Inactive and active sort indicators. */
.hc[data-sort]:not([data-dir]) .sarrow { width: auto; height: auto; border: 0; opacity: .4; }
.hc[data-sort]:not([data-dir]) .sarrow::after { content: "\\21C5"; font-size: 9px; line-height: 1; }
.hc[data-dir="asc"] .sarrow { border-left: 4px solid transparent; border-right: 4px solid transparent; border-bottom: 5px solid var(--accent-2); }
.hc[data-dir="desc"] .sarrow { border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid var(--accent-2); }
.hc[data-dir] .hsort { color: var(--fg); }
/* Column resize handle. */
.hc { position: relative; }
.hgrip { position: absolute; top: -4px; bottom: -4px; right: -9px; width: 13px; cursor: col-resize; z-index: 6; }
.hgrip::after { content: ""; position: absolute; top: 6px; bottom: 6px; right: 6px; width: 1px; background: transparent; }
.hgrip:hover::after, .hgrip.on::after { background: var(--accent); }
.hgrip:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 3px; }
.hgrip:focus-visible::after { background: var(--accent); }
/* Keyboard focus for interactive rows. */
.qm-grid > .tr[tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
/* Column settings popover. */
.colmenu { position: absolute; z-index: 40; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 12px 32px rgb(0 0 0 / .3); padding: 8px; min-width: 200px; }
.colmenu .cm-h { font-size: 11.5px; font-weight: 600; color: var(--fg-2); padding: 4px 8px 6px; }
.colmenu .cm-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: var(--radius-sm); font-size: 12.5px; color: var(--fg); }
.colmenu .cm-row:hover { background: var(--lift); }
.colmenu .cm-row input { accent-color: var(--accent); margin: 0; width: 13px; height: 13px; }
.colmenu .cm-row span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.colmenu .cm-move { display: inline-flex; gap: 2px; }
.colmenu .cm-move button { width: 20px; height: 20px; display: grid; place-items: center; border: 0; background: none; color: var(--faint); cursor: pointer; border-radius: 4px; padding: 0; }
.colmenu .cm-move button:hover { background: var(--lift); color: var(--fg); }
.colmenu .cm-move button:disabled { opacity: .35; cursor: default; }
.colmenu .cm-foot { display: flex; justify-content: flex-end; padding: 6px 8px 2px; }
.colmenu .cm-reset { border: 0; background: none; padding: 0; color: var(--accent-2); font: inherit; font-size: 11.5px; cursor: pointer; }
.colmenu .cm-reset:hover { text-decoration: underline; }
/* Loading placeholder. */
.skel { display: inline-block; width: 42px; height: 10px; border-radius: 4px; background: var(--lift); animation: skel 1.4s ease-in-out infinite; }
@keyframes skel { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .skel { animation: none; } }
/* Grid minimum width is provided inline by the rendering helpers. */
.gwrap .table { border-left: 0; border-right: 0; border-radius: 0; }
.gwrap { border: 1px solid var(--border); background: var(--panel); box-shadow: var(--shadow); }
/* Container detail workspace and tabs. */
.detail.wide { width: min(560px, 92vw); }
.d-tabs { display: flex; gap: 2px; padding: 0 16px; border-bottom: 1px solid var(--border); }
.d-tab { border: 0; background: none; padding: 8px 10px 9px; font: inherit; font-size: 12.5px; font-weight: 500; color: var(--fg-2); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.d-tab:hover { color: var(--fg); }
.d-tab.on { color: var(--fg); border-bottom-color: var(--accent); }
.d-pane { padding-top: 4px; }
/* High CPU highlight. */
.td.cpu.hot { color: var(--bad); font-weight: 600; }
/* Recently changed values. */
.flash { animation: cellflash 1.1s ease-out; }
@keyframes cellflash { from { background: var(--warn-soft); border-radius: 4px; } to { background: transparent; } }
@media (prefers-reduced-motion: reduce) { .flash { animation: none; } }
/* Created containers use the informational tone. */
.state.info { color: var(--accent-2); }
.state.info i { background: var(--accent); }
.t-ctr .state.info { background: var(--accent-soft); }
/* Lifecycle state pills. */
.state.glyph { gap: 5px; }
.state.glyph svg { width: 11px; height: 11px; stroke: currentColor; flex: none; }
.t-ctr .state.glyph, .svc-state .state.glyph { padding: 3px 11px 3px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
.t-ctr .state.glyph.ok, .svc-state .state.glyph.ok { background: var(--ok); color: #FFF; }
.t-ctr .state.glyph.warn, .svc-state .state.glyph.warn { background: var(--warn-mark); color: #1B1607; }
.t-ctr .state.glyph.bad, .svc-state .state.glyph.bad { background: var(--bad); color: #FFF; }
.t-ctr .state.glyph.info, .svc-state .state.glyph.info { background: var(--accent); color: #FFF; }
/* Detail-header update status. */
.d-upnote { margin-left: auto; }
.d-head .d-close { margin-left: 8px; }
/* Pin actions to the right edge. --pinshift compensates for scrolling within the grid track. */
.qm-grid > .tr > [data-col="actions"] { transform: translateX(var(--pinshift, 0px)); z-index: 2; background: var(--panel); box-shadow: -1px 0 0 var(--border); padding-left: 8px; margin-right: -16px; padding-right: 16px; align-self: stretch; display: flex; align-items: center; justify-content: flex-end; }
.qm-grid > .tr.th > [data-col="actions"] { background: var(--lift); z-index: 6; }
.qm-grid > .tr:not(.th):hover > [data-col="actions"] { background: var(--lift); }
.qm-grid > .tr.sel > [data-col="actions"] { background: color-mix(in srgb, var(--accent) 13%, var(--panel)); }
/* Row action hit targets. */
.acts { gap: 3px; }
.actbtn { width: 28px; height: 28px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--fg-2); }
.actbtn svg { width: 14px; height: 14px; }
.actbtn:hover { border-color: var(--border); }
.t-ctr .actbtn { width: 27px; height: 27px; }
/* Linked published ports. */
.portlink { text-decoration: none; cursor: pointer; }
.portlink:hover { color: var(--accent-2); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft); }
/* Pending-update and selected-row highlights. */
.qm-grid > .tr[data-update="1"]:not(.sel) { background: color-mix(in srgb, var(--warn-mark) 8%, transparent); }
.qm-grid > .tr[data-update="1"]:not(.sel):hover { background: color-mix(in srgb, var(--warn-mark) 13%, transparent); }
.qm-grid > .tr[data-update="1"]:not(.sel) > [data-col="actions"] { background: color-mix(in srgb, var(--warn-mark) 8%, var(--panel)); }
.qm-grid > .tr[data-update="1"]:not(.sel):hover > [data-col="actions"] { background: color-mix(in srgb, var(--warn-mark) 13%, var(--panel)); }
/* Pending-update flag. */
.upflag { background: var(--warn-mark); border-color: transparent; color: #1B1607; font-weight: 700; }
.upflag i { background: #1B1607; }
.upflag:hover { filter: brightness(1.08); border-color: transparent; }

/* Stack summary rows and fold-out workspaces. */
.stack-grid > .tr.t-stack { gap: 12px; min-height: 58px; padding-top: 7px; padding-bottom: 7px; }
.stack-grid > .tr.t-stack:not(.th) { position: relative; cursor: pointer; }
.stack-grid > .tr.t-stack:not(.th)::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px; border-radius: 2px; background: var(--faint); opacity: .45; }
.stack-grid > .tr.t-stack[data-state="running"]::before { background: var(--ok); opacity: 1; }
.stack-grid > .tr.t-stack[data-state="attention"]::before { background: var(--warn-mark); opacity: 1; }
.stack-grid > .tr.t-stack.open { background: var(--lift); }
.stack-grid-chevron { display: grid; place-items: center; width: 22px; height: 22px; color: var(--faint); }
.stack-grid-chevron svg { width: 13px; height: 13px; stroke: currentColor; transition: transform 150ms ease-out; }
.stack-row.open .stack-grid-chevron svg { transform: rotate(90deg); }
.stack-grid-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.stack-grid-name .stack-symbol { flex: none; }
.stack-grid-name .stack-identity { display: flex; flex-direction: column; min-width: 0; }
.stack-grid-name .stack-identity b, .stack-grid-name .stack-identity small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stack-grid-name .stack-identity b { color: var(--fg); font-size: 13px; font-weight: 600; }
.stack-grid-name .stack-identity small { color: var(--faint); font-size: 10.5px; }
.stack-grid .st-state .state, .stack-grid .stack-update { white-space: nowrap; font-size: 11.5px; }
.stack-update-cell { overflow: hidden; }
.stack-resources { display: flex; gap: 8px; color: var(--fg-2); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stack-open-btn { height: 27px; padding: 0 10px; font-size: 11.5px; }
.stack-workspace { padding: 14px 16px 16px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 58%, var(--panel)); }
.stack-workspace[hidden] { display: none; }
.stack-work-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 10px; }
.stack-work-head > div:first-child { min-width: 180px; }
.stack-work-head b, .stack-work-head small { display: block; }
.stack-work-head b { margin-top: 2px; color: var(--fg); font-size: 15px; font-weight: 600; }
.stack-work-head small { margin-top: 3px; max-width: 66ch; color: var(--fg-2); font-size: 11px; line-height: 1.4; }
.stack-work-kicker { color: var(--faint); font-size: 11px; font-weight: 700; }
.stack-commandbar { display: flex; align-items: center; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
.stack-commandbar .sv-down:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); }
.stack-work-facts { display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 8px 0 10px; border-top: 1px solid var(--border); color: var(--fg-2); font-size: 10.5px; font-variant-numeric: tabular-nums; }
@media (max-width: 900px) {
  .stack-work-head { flex-direction: column; }
  .stack-commandbar { justify-content: flex-start; }
  /* Keep opened stack workspaces inside the mobile viewport. */
  .stack-workspace { position: sticky; left: 0; width: calc(100vw - 28px); box-sizing: border-box; }
  .stack-workspace .svcgrid { grid-template-columns: minmax(0, 1fr); }
  .stack-commandbar { width: 100%; }
}
`;
