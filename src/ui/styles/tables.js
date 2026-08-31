// Table styles.

export const tables = `/* ---------- table ---------- */
.table { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--panel); box-shadow: var(--shadow); }
.tr { display: grid; grid-template-columns: 34px 1.5fr 2.2fr 130px 110px; align-items: center; gap: 14px; padding: 9px 16px; border-bottom: 1px solid var(--border); font-size: 13px; }
.tr > div { min-width: 0; }
.tr:last-child { border-bottom: 0; }
.tr.th { padding: 10px 16px 8px; background: var(--panel); }
.tr:not(.th):hover { background: var(--lift); }
.tr.sel { background: var(--accent-soft); box-shadow: inset 2.5px 0 0 var(--accent); }
.logo { width: 26px; height: 26px; border-radius: 6px; background: var(--lift); display: grid; place-items: center; font-size: 10px; font-weight: 600; color: var(--fg-2); }
.logo.img { background: #FFF; padding: 3px; }
.logo.img img { width: 100%; height: 100%; object-fit: contain; display: block; }
.logo.generic { background: var(--logo-bg, var(--faint)); color: #FFF; }
.logo.generic.template { background: var(--accent); }
.logo.generic svg { width: 15px; height: 15px; stroke: currentColor; }
.logo.product img { border-radius: 50%; }
.fill-icon { fill: currentColor; stroke: none !important; }
.svc { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.svc small { display: block; color: var(--faint); font-weight: 400; font-size: 11px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.addr { color: var(--fg-2); font-size: 11.5px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim { color: var(--fg-2); }
.faint { color: var(--faint); }
.num { text-align: right; font-variant-numeric: tabular-nums; font-size: 11.5px; }
.tscroll { overflow-x: auto; }
/* Grid tracks are supplied by columns.js. */
/* Dashboard services. */
.tr.t-svc { grid-template-columns: 104px 26px 1.2fr 1.8fr 152px; gap: 12px; padding: 7px 16px; }
.tr.t-svc.th { padding: 9px 16px 7px; }
.tr.t-svc.svc-row { position: relative; }
.tr.t-svc.svc-row::before { content: ""; position: absolute; left: 0; top: 7px; bottom: 7px; width: 2px; border-radius: 2px; background: var(--faint); opacity: .45; }
.tr.t-svc.svc-row.is-online::before { background: var(--ok); opacity: 1; }
.tr.t-svc.svc-row.is-offline::before { background: var(--bad); opacity: 1; }
.kcell { text-align: right; }
.imgtable { min-width: 940px; }
.voltable { min-width: 940px; }
.nettable { min-width: 880px; }
.acttable { min-width: 640px; }
.tr.t-audit { grid-template-columns: 150px 1fr; }
.tr.t-audit > div:last-child { display: flex; align-items: center; gap: 8px; color: var(--fg); min-width: 0; }
.tr.t-audit svg { width: 14px; height: 14px; color: var(--faint); flex: none; }
.audittable { min-width: 520px; }
/* Containers table. */
.tr.t-ctr { gap: 12px; padding-top: 5px; padding-bottom: 5px; }
.tr.t-ctr.th { background: var(--lift); border-bottom-color: var(--border); }
.tr.t-ctr:not(.th) { position: relative; }
.tr.t-ctr:not(.th)::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px; border-radius: 2px; background: var(--faint); opacity: .45; }
.tr.t-ctr[data-state="running"]::before { background: var(--ok); opacity: 1; }
.tr.t-ctr[data-state="paused"]::before { background: var(--warn-mark); opacity: 1; }
.tr.t-ctr[data-health="unhealthy"]::before { background: var(--bad); opacity: 1; }
.t-ctr .actbtn { width: 24px; height: 24px; }
/* Selection column. */
.selc { display: flex; align-items: center; }
.selc input { width: 14px; height: 14px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.rowguard, .actguard { display: inline-flex; align-items: center; justify-content: center; color: var(--warn); }
.rowguard { width: 14px; height: 14px; }
.rowguard svg, .actguard svg { width: 14px; height: 14px; stroke: currentColor; }
.actguard { width: 28px; height: 28px; }
.rowguard svg, .actguard svg { width: 14px; height: 14px; }
.selchip { display: inline-flex; align-items: center; gap: 5px; color: var(--fg-2); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.selchip b { color: var(--fg); font-weight: 600; }
.sel-clear { border: 0; background: none; padding: 0; color: var(--accent-2); font: inherit; font-size: 11.5px; cursor: pointer; }
.sel-clear:hover { text-decoration: underline; }
.tool-sep { width: 1px; height: 20px; background: var(--border); margin: 0 2px; flex: none; }
.ctr-ident { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ctr-ident .logo { flex: none; }
.ctr-copy { display: flex; flex-direction: column; gap: 0; min-width: 0; }
.ctr-copy .svc { display: flex; align-items: center; gap: 7px; }
/* Restore ellipsis inside the flex row. */
.ctr-copy .svc > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctr-copy .addr { max-width: 100%; }
.ctr-status { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 8px; }
.healthline { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); font-size: 10.5px; white-space: nowrap; }
.healthline i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); flex: none; }
.healthline.ok { color: var(--ok); } .healthline.ok i { background: var(--ok); }
.healthline.warn { color: var(--warn); } .healthline.warn i { background: var(--warn-mark); }
.healthline.bad { color: var(--bad); } .healthline.bad i { background: var(--bad); }
.healthline.off i { background: transparent; border: 1px solid var(--faint); }
/* Container endpoints. */
.ctr-endpoint { display: flex; flex-direction: column; gap: 3px; min-width: 0; align-items: flex-start; }
.ctr-endpoint .addr { max-width: 100%; }
.ep-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; max-width: 100%; }
.ep-chips .badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; padding: 1.5px 6px; font-size: 10.5px; }
.urlchip { color: var(--fg-2); text-decoration: none; }
.urlchip:hover { color: var(--accent-2); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.urlchip svg { width: 10px; height: 10px; stroke: currentColor; flex: none; }
/* Network and disk I/O. */
.io { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--fg-2); }
.io .d, .io .u { color: var(--fg-2); }
.io2 { display: flex; flex-direction: column; gap: 0; }
/* Image reference and update control. */
.imgcell { display: flex; flex-direction: column; gap: 2px; min-width: 0; align-items: flex-start; }
.imgcell .addr { max-width: 100%; }
.image-source { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; color: var(--fg-2); font-variant-numeric: tabular-nums; text-decoration: none; }
.image-source:hover { color: var(--accent-2); }
.image-source svg { width: 11px; height: 11px; flex: none; stroke: currentColor; }
.upflag { display: inline-flex; align-items: center; gap: 5px; border: 1px solid color-mix(in srgb, var(--warn-mark) 45%, var(--border)); border-radius: 6px; background: var(--warn-soft); color: var(--warn); padding: 1.5px 7px; font: inherit; font-size: 10.5px; font-weight: 600; cursor: pointer; }
.upflag i { width: 6px; height: 6px; border-radius: 50%; background: var(--warn-mark); flex: none; }
.upflag:hover { border-color: var(--warn-mark); }
.upflag:disabled { opacity: .5; cursor: default; }
/* Highlight known restart counts. */
.rst.warm { color: var(--warn); }
/* Keep the update label and count together. */
.updcluster { display: inline-flex; align-items: center; gap: 2px; }
.updcluster .updlbl { white-space: nowrap; }
.updcluster #updn { font-variant-numeric: tabular-nums; }
/* Clip narrow header cells. */
.tr.t-ctr.th .hc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.updot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn-mark); flex: none; display: inline-block; }
/* Image update marker. */
.tagupd { margin-left: 6px; }
/* Preserve stack colours on linked badges. */
.stacklink { text-decoration: none; }
.stacklink:hover { color: var(--sh-ink); border-color: color-mix(in srgb, var(--sh-ink) 42%, transparent); }
.actbtn.upd { color: var(--warn); }
.actbtn.upd:hover { color: var(--accent-2); }
/* Override component display rules. */
.hidden { display: none !important; }

/* Shared state indicator. */
.state { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 500; }
.state i { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--faint); }
.state.ok { color: var(--ok); } .state.ok i { background: var(--ok); }
.state.warn { color: var(--warn); } .state.warn i { background: var(--warn-mark); }
.state.bad { color: var(--bad); } .state.bad i { background: var(--bad); }
.state.off { color: var(--fg-2); }
/* Filled state badges in the containers table. */
.t-ctr .state { padding: 3px 11px 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
.t-ctr .state.ok { background: var(--ok-soft); }
.t-ctr .state.warn { background: var(--warn-soft); }
.t-ctr .state.bad { background: var(--bad-soft); }
.t-ctr .state.off { background: var(--lift); }

/* State and fact badges. */
.badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; border-radius: 6px; padding: 2.5px 8px; white-space: nowrap; background: var(--lift); color: var(--fg-2); }
.badge svg { width: 10px; height: 10px; stroke: currentColor; flex: none; }
.badge.ok { background: var(--ok); color: #FFF; }
.badge.warn { background: var(--warn-mark); color: #1B1607; }
.badge.bad, .badge.err { background: var(--bad); color: #FFF; }
.badge.info, .badge.viol { background: var(--accent); color: #FFF; }
.badge.line { background: none; border: 1px solid var(--border); color: var(--fg-2); font-weight: 500; }
/* Unused image state. */
.badge.idle { background: none; border: 1px solid var(--border); color: var(--faint); font-weight: 500; }
.badge.mono { font-weight: 500; }
/* Published port and proxy-route colours. */
.badge.port { background: var(--port-bg); color: var(--port-ink); border: 1px solid color-mix(in srgb, var(--port-ink) 22%, transparent); }
/* Stack colour ramp. */
.sh-0 { --sh-bg: var(--sh0-bg); --sh-ink: var(--sh0-ink); }
.sh-1 { --sh-bg: var(--sh1-bg); --sh-ink: var(--sh1-ink); }
.sh-2 { --sh-bg: var(--sh2-bg); --sh-ink: var(--sh2-ink); }
.sh-3 { --sh-bg: var(--sh3-bg); --sh-ink: var(--sh3-ink); }
.sh-4 { --sh-bg: var(--sh4-bg); --sh-ink: var(--sh4-ink); }
.sh-5 { --sh-bg: var(--sh5-bg); --sh-ink: var(--sh5-ink); }
.badge.stacktint { background: var(--sh-bg); color: var(--sh-ink); border: 1px solid transparent; font-weight: 600; }

/* Inline sparkline. */
.spark { display: inline-flex; align-items: center; gap: 8px; }
.spark svg { width: 56px; height: 20px; flex: none; }
.spark .v { font-size: 11.5px; font-variant-numeric: tabular-nums; min-width: 42px; text-align: right; }
.sparkline { stroke: var(--accent); fill: var(--accent-soft); stroke-width: 1.5; }

/* Row actions. */
.acts { display: flex; gap: 2px; justify-content: flex-end; }
.actbtn { width: 26px; height: 26px; display: grid; place-items: center; border: 0; background: none; color: var(--faint); cursor: pointer; border-radius: 6px; text-decoration: none; }
.actbtn svg { width: 13px; height: 13px; stroke: currentColor; }
.actbtn:hover { background: var(--lift); color: var(--fg); }
.actbtn.go:hover { color: var(--ok); }
.actbtn.halt:hover { color: var(--warn); }
.actbtn.spin:hover { color: var(--accent-2); }
.actbtn:disabled { opacity: .4; cursor: default; }

/* Activity labels. */
.ev-act { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 500; color: var(--fg-2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-act svg { width: 12px; height: 12px; stroke: currentColor; flex: none; }
.ev-act.ok { color: var(--ok); }
.ev-act.warn { color: var(--warn); }
.ev-act.bad { color: var(--bad); }

`;
