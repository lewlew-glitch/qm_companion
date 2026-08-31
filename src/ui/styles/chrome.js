// Application frame.

export const chrome = `/* ---------- shell ---------- */
.app { display: grid; grid-template-columns: 224px 1fr; height: 100vh; }
.side { background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 16px 10px 12px; }
.side-menu { min-height: 0; flex: 1; display: flex; flex-direction: column; }
.top-brand { display: flex; align-items: center; gap: 10px; padding: 2px 10px 16px; }
.top-brand .mark { width: 30px; height: 30px; border-radius: 50%; overflow: hidden; flex: none; }
.mark img { width: 100%; height: 100%; object-fit: cover; display: block; }
.top-brand .wordmark { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
.top-brand .wordmark b { font-size: 12.5px; font-weight: 600; }
.top-brand .wordmark small { margin-top: 1px; color: var(--fg-2); font-size: 11px; font-weight: 500; }
.mobile-menu, .side-scrim { display: none; }
.nav { display: flex; align-items: center; gap: 11px; padding: 8px 12px; border-radius: var(--radius-sm); color: var(--fg-2); font-weight: 500; font-size: 13px; text-decoration: none; position: relative; transition: background 140ms ease-out, color 140ms ease-out; }
button.nav { width: 100%; border: 0; background: none; font-family: inherit; text-align: left; cursor: pointer; }
.nav svg { width: 16px; height: 16px; stroke: currentColor; flex: none; opacity: .9; }
.nav:hover { background: var(--lift); color: var(--fg); }
.nav.on { background: var(--accent-soft); color: var(--fg); }
.nav.on svg { color: var(--accent-2); opacity: 1; }
.nav.on::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2.5px; border-radius: 2px; background: var(--accent); }
.nav-group { margin: 13px 12px 3px; font-size: 11.5px; font-weight: 600; color: var(--faint); }
/* Navigation status figure. */
.nav-fig { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; font-size: 10.5px; font-weight: 500; font-variant-numeric: tabular-nums; }
.nav-fig i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.nav-fig.bad { color: var(--bad); } .nav-fig.bad i { background: var(--bad); }
.nav-fig.warn { color: var(--warn); } .nav-fig.warn i { background: var(--warn-mark); }
.mode-nav > span:first-of-type { white-space: nowrap; }
.mode-nav-value { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); font-size: 10.5px; font-weight: 500; }
.mode-nav:hover .mode-nav-value { color: var(--fg-2); }
.side .spacer { flex: 1; }
.side .foot { display: flex; align-items: center; gap: 6px; padding: 8px 6px 0; border-top: 1px solid var(--border); }
.iconbtn { width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: var(--radius-sm); background: none; color: var(--fg-2); cursor: pointer; }
.iconbtn svg { width: 16px; height: 16px; stroke: currentColor; }
.iconbtn:hover { background: var(--lift); color: var(--fg); }
.signout { flex: 1; text-align: left; background: none; border: 0; color: var(--fg-2); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; padding: 8px; border-radius: var(--radius-sm); display: flex; align-items: center; gap: 9px; }
.signout svg { width: 15px; height: 15px; stroke: currentColor; }
.signout:hover { background: var(--lift); color: var(--fg); }

.main { display: flex; flex-direction: column; min-width: 0; overflow: hidden; position: relative; }
.scroll { overflow: auto; padding: 18px 24px 44px; }

/* Host status strip. */
.factstrip { display: flex; align-items: center; flex: none; height: 36px; padding: 0 24px; border-bottom: 1px solid var(--border); font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--fg-2); white-space: nowrap; }
.factstrip .fs-host { flex: none; color: var(--fg); font-weight: 600; }
.factstrip .fs-more { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
.factstrip .fs-sep { flex: none; white-space: pre; }
.factstrip #clk { flex: none; font-weight: 500; color: var(--fg); }

/* page header: title left, page tools inline */
.board { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 2px 0 18px; }
.board h1 { font-size: 18px; font-weight: 600; letter-spacing: -.01em; margin: 0; }
.board-icon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; background: var(--accent-soft); color: var(--accent-2); }
.board-icon svg { width: 16px; height: 16px; stroke: currentColor; }
.board .count-tag { display: inline-grid; place-items: center; min-width: 26px; height: 22px; padding: 0 8px; border-radius: 999px; background: var(--border); color: var(--fg-2); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.grow { flex: 1; }
/* Keep action controls together. */
.tbar-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.hdot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); display: inline-block; }
.sub { color: var(--fg-2); font-size: 13.5px; margin: -8px 0 16px; max-width: 70ch; }
.sec-h { margin: 24px 0 10px; }
.hint { font-size: 12px; color: var(--faint); }
.fleet-line { font-variant-numeric: tabular-nums; white-space: nowrap; }
.fleet-line b { font-weight: 600; }

`;

export const responsive = `/* ---------- responsive ---------- */
@media (max-width: 1150px) {
  .loglayout { grid-template-columns: minmax(0, 1fr); grid-template-rows: 186px minmax(0, 1fr); }
  .logside { min-height: 0; }
}

@media (max-width: 860px) {
  .app { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .side { position: relative; z-index: 90; flex-direction: row; align-items: center; overflow: visible; min-height: 52px; padding: 8px 10px; gap: 8px; }
  .top-brand { padding: 0 4px 0 2px; }
  .top-brand .wordmark { display: none; }
  .mobile-menu { margin-left: auto; min-width: 0; max-width: calc(100vw - 72px); height: 34px; padding: 0 10px 0 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); color: var(--fg); display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .mobile-menu span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-menu svg { width: 15px; height: 15px; flex: none; stroke: currentColor; transition: transform 140ms ease-out; }
  .side.menu-open .mobile-menu svg { transform: rotate(90deg); }
  .side-scrim { position: fixed; z-index: 0; inset: 52px 0 0; border: 0; background: color-mix(in srgb, var(--bg) 58%, transparent); backdrop-filter: blur(2px); }
  .side.menu-open .side-scrim { display: block; }
  .side-menu { display: none; position: fixed; z-index: 1; top: 60px; right: 10px; bottom: 10px; left: 10px; min-height: 0; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); box-shadow: var(--shadow); overflow-y: auto; }
  .side.menu-open .side-menu { display: flex; }
  .nav { padding: 9px 12px; white-space: nowrap; }
  .nav.on::before { display: none; }
  .nav-group { display: block; margin-top: 14px; }
  .side .spacer { display: block; min-height: 16px; }
  .side .foot { display: flex; position: sticky; bottom: -10px; margin-top: 8px; padding: 10px 6px; background: var(--panel); }
  .main { order: 1; }
  .pair-wrap { grid-template-columns: 1fr; }
  .pair-route-grid, .pair-edge-grid { grid-template-columns: 1fr; }
  .scroll { padding: 14px 14px 40px; }
  .factstrip { padding: 0 14px; }
  .factstrip .fs-more { display: none; }
  .detail { width: 100%; max-width: 100%; }
  .rightrow .btn { width: 100%; justify-content: center; }
  .loglayout { grid-template-columns: 1fr; grid-template-rows: auto auto; height: auto; min-height: 0; }
  .logside { max-height: 240px; }
  .logconsole .logs { flex: none; max-height: 55vh; }
}
`;
