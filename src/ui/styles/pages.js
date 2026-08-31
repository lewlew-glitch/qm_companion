// Page-specific styles.

export const detail = `/* ---------- container detail ---------- */
.detail { position: absolute; top: 0; right: 0; bottom: 0; width: 360px; max-width: 92vw; background: var(--panel); border-left: 1px solid var(--border); padding: 20px 20px 16px; overflow-y: auto; transform: translateX(100%); transition: transform 180ms ease-out; z-index: 20; display: flex; flex-direction: column; }
.detail.open { transform: none; box-shadow: -12px 0 32px rgb(0 0 0 / .25); }
.detail .d-head { display: flex; align-items: center; gap: 11px; margin-bottom: 4px; }
.detail .d-head .logo { width: 34px; height: 34px; border-radius: 8px; }
.detail .d-head b { font-size: 16px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail .d-close { margin-left: auto; }
.detail .d-state { margin: 2px 0 16px; }
.d-charts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
.d-chart .lbl { display: flex; justify-content: space-between; margin-bottom: 5px; }
.d-chart .lbl b { color: var(--fg); font-size: 11.5px; font-variant-numeric: tabular-nums; font-weight: 600; }
.d-chart svg { width: 100%; height: 44px; border-radius: 6px; background: var(--lift); }
.d-chart .cpu-line { stroke: var(--accent); fill: var(--accent-soft); stroke-width: 1.5; }
.d-chart .mem-line { stroke: var(--teal); fill: color-mix(in srgb, var(--teal) 13%, transparent); stroke-width: 1.5; }
.d-kv { border-top: 1px solid var(--border); }
.d-kv .kv { display: flex; justify-content: space-between; gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.d-kv .kv span { color: var(--fg-2); flex: none; }
.d-kv .kv b { font-weight: 500; font-size: 11.5px; font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }
/* Detail sections. */
.d-sec { margin: 16px 0 4px; color: var(--fg-2); font-size: 11.5px; font-weight: 600; }
.d-list { display: flex; flex-direction: column; min-width: 0; }
.d-envrow, .d-mountrow { display: flex; align-items: center; gap: 7px; padding: 4px 0; border-bottom: 1px solid var(--border); min-width: 0; }
.d-envrow:last-child, .d-mountrow:last-child { border-bottom: 0; }
.d-ek { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--fg-2); }
.d-ev { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--fg); }
.d-mountrow .d-src { text-align: left; }
.d-mountrow .d-src + .d-arrow + .d-src { text-align: right; }
.d-arrow { flex: none; color: var(--faint); font-size: 10.5px; }
.d-mountrow .badge { flex: none; font-size: 9.5px; padding: 1px 5px; }
.d-ibtn { width: 22px; height: 22px; flex: none; }
.d-ibtn svg { width: 12px; height: 12px; }
.d-wait { padding: 4px 0; color: var(--faint); font-size: 11.5px; }
.d-adv { display: flex; align-items: center; gap: 10px; margin: 20px 0 0; color: var(--faint); font-size: 11.5px; font-weight: 600; }
.d-adv::before, .d-adv::after { content: ""; flex: 1; height: 1px; background: var(--border); }
#d-limits { border-top: 0; margin-bottom: 2px; }
.d-actions { display: flex; gap: 8px; margin-top: auto; padding-top: 16px; }
.d-actions .btn { flex: 1; justify-content: center; }
.d-guard { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); font-size: 12px; }
.d-guard svg { width: 14px; height: 14px; color: var(--warn); }

.section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin: 24px 0 8px; }
.section-head > div:first-child > span { display: block; color: var(--faint); font-size: 11.5px; font-weight: 600; }
.section-head h2 { margin: 1px 0 0; font-size: 16px; font-weight: 600; }
.section-facts { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 6px 14px; color: var(--fg-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.section-facts span { position: relative; }
.section-facts span + span::before { content: ""; position: absolute; left: -8px; top: 50%; width: 3px; height: 3px; border-radius: 50%; background: var(--faint); }
.bad-text { color: var(--bad); }
@media (max-width: 760px) {
  .section-head { align-items: flex-start; flex-direction: column; }
  .section-facts { justify-content: flex-start; }
}

.panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px 18px; }
.panel .p-h { display: flex; align-items: baseline; gap: 10px; margin: 0 0 12px; font-size: 13.5px; font-weight: 600; }
.panel .p-h .r { margin-left: auto; font-size: 12px; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--fg-2); }
.panel .p-h .p-more { margin-left: auto; font-size: 12px; font-weight: 500; color: var(--fg-2); }
.panel .p-h .p-more:hover { color: var(--accent-2); }
.chart-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-size: 11.5px; color: var(--fg-2); }
.chart-legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 6px; }

`;

export const dashboard = `/* disk ring */
.ring-wrap { display: flex; gap: 18px; align-items: center; }
.ring { position: relative; flex: none; }
.ring svg { width: 128px; height: 128px; }
.ring .r-track { stroke: var(--lift); }
.ring .r-a { stroke: var(--accent); } .ring .r-b { stroke: var(--teal); } .ring .r-c { stroke: var(--warn-mark); } .ring .r-d { stroke: var(--faint); }
.ring .r-mid { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }
.ring .r-mid b { font-size: 19px; font-weight: 300; display: block; font-variant-numeric: tabular-nums; }
.ring .r-mid span { font-size: 11px; font-weight: 600; color: var(--fg-2); }
.ds-legend { display: flex; flex-direction: column; gap: 8px; min-width: 0; flex: 1; }
.ds-row { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--fg-2); }
.ds-row.ds-a .ds-dot { background: var(--accent); } .ds-row.ds-b .ds-dot { background: var(--teal); } .ds-row.ds-c .ds-dot { background: var(--warn-mark); } .ds-row.ds-d .ds-dot { background: var(--faint); }
.ds-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ds-sz { margin-left: auto; color: var(--fg); font-size: 11.5px; font-variant-numeric: tabular-nums; }

/* Recent activity and top consumers. */
.ev-list { display: flex; flex-direction: column; }
.ev-row { display: flex; align-items: center; gap: 10px; font-size: 12.5px; padding: 7px 0; border-bottom: 1px solid var(--border); min-width: 0; }
.ev-row:last-child { border-bottom: 0; }
.ev-t { color: var(--faint); flex: none; font-size: 11px; font-variant-numeric: tabular-nums; }
.ev-row svg { width: 12px; height: 12px; flex: none; stroke: currentColor; }
.ev-row .ec.run { color: var(--ok); } .ev-row .ec.pause { color: var(--warn); } .ev-row .ec.bad { color: var(--bad); } .ev-row .ec { color: var(--fg-2); }
.ev-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slip { color: var(--bad); font-weight: 500; }
.dk-list { display: flex; flex-direction: column; }
.dk-load { font-size: 12px; color: var(--faint); }
.dk-row { display: grid; grid-template-columns: 1.2fr 2fr 48px 48px; align-items: center; gap: 12px; font-size: 12.5px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.dk-row:last-child { border-bottom: 0; }
.dk-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.dk-bar { height: 5px; border-radius: 3px; background: var(--lift); overflow: hidden; }
.dk-bar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.dk-val { text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; }
.dk-val.dim { color: var(--fg-2); }
.ec { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--fg-2); }
.ec svg { width: 13px; height: 13px; stroke: currentColor; }
.ec b { font-size: 14px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.ec.run { color: var(--ok); } .ec.run b { color: var(--ok); }
.ec.pause { color: var(--warn); } .ec.pause b { color: var(--warn); }
.ec.bad { color: var(--bad); } .ec.bad b { color: var(--bad); }
.ec.total { margin-left: auto; }
/* Now playing and media services. */
.nowplay { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; margin: 0 0 18px; }
.np { display: flex; align-items: center; gap: 11px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 12px 14px; }
.np-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
.np-dot.paused { background: var(--faint); }
.np-txt { min-width: 0; }
.np-txt b { display: block; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.np-txt span { font-size: 11.5px; color: var(--fg-2); }
@media (prefers-reduced-motion: no-preference) { .np-dot:not(.paused) { animation: livedot 2s ease-in-out infinite; } }
@keyframes livedot { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

.stackcard { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 16px; margin: 0 0 12px; }
.sc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; margin-bottom: 10px; }
.sc-title { font-size: 13.5px; font-weight: 600; }
.sc-sub { color: var(--fg-2); font-weight: 400; font-size: 12px; margin-left: 8px; }
.sc-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; max-width: 340px; margin-bottom: 12px; }
.sc-metrics b { display: block; font-size: 22px; font-weight: 250; line-height: 1.2; font-variant-numeric: tabular-nums; }
.sc-metrics b.up { color: var(--ok); }
.sc-metrics b.warn { color: var(--warn); }
.sc-metrics span { display: block; margin-top: 1px; font-size: 11.5px; font-weight: 600; color: var(--fg-2); }
.sc-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.sc-chip { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 500; border: 1px solid var(--border); border-radius: 999px; padding: 4px 13px 4px 5px; background: var(--panel); }
.sc-chip.off { opacity: .55; }
.sc-chip .logo { width: 22px; height: 22px; border-radius: 50%; }
.sc-note { margin-top: 12px; font-size: 12px; color: var(--faint); }

/* Dashboard summary. */
.warn-text { color: var(--warn); }
.dash-environment { display: grid; grid-template-columns: minmax(230px, .8fr) minmax(280px, 1.4fr) auto; align-items: center; gap: 18px 28px; min-height: 76px; margin-bottom: 12px; padding: 12px 15px; }
.de-identity { display: flex; align-items: center; gap: 12px; min-width: 0; }
.de-icon { display: grid; place-items: center; width: 38px; height: 38px; flex: none; border-radius: 10px; color: var(--accent-2); background: var(--accent-soft); }
.de-icon svg { width: 19px; height: 19px; stroke: currentColor; }
.de-identity > div { min-width: 0; }
.de-identity > div > span { display: block; color: var(--fg-2); font-size: 11px; font-weight: 650; }
.de-identity b { display: inline; font-size: 14px; font-weight: 620; }
.de-identity small { margin-left: 8px; color: var(--faint); font-size: 10.5px; }
.de-connection { min-width: 0; }
.de-connection .state { font-size: 12.5px; font-weight: 600; }
.de-connection small { display: block; margin-top: 3px; color: var(--fg-2); font-size: 10.5px; }
.de-actions { display: flex; align-items: center; justify-content: flex-end; gap: 14px; }
.de-actions > a { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); font-size: 11.5px; font-weight: 550; white-space: nowrap; }
.de-actions > a:hover { color: var(--accent-2); }
.de-actions > a svg { width: 13px; height: 13px; stroke: currentColor; }
.dash-overview { margin-bottom: 12px; }
.dash-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.dash-metric { position: relative; display: flex; min-width: 0; min-height: 126px; flex-direction: column; padding: 13px 15px 12px; color: var(--fg); overflow: hidden; transition: border-color 140ms ease-out, background 140ms ease-out; }
a.dash-metric:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); background: var(--lift); }
.dm-head { display: flex; align-items: center; gap: 8px; color: var(--fg-2); font-size: 11.5px; font-weight: 650; }
.dm-icon { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 7px; color: var(--fg-2); background: var(--lift); }
.dm-icon svg { width: 13px; height: 13px; stroke: currentColor; }
.dm-icon.ok { color: var(--ok); background: var(--ok-soft); }
.dm-icon.warn { color: var(--warn); background: var(--warn-soft); }
.dm-icon.accent { color: var(--accent-2); background: var(--accent-soft); }
.dm-icon.teal { color: var(--teal); background: color-mix(in srgb, var(--teal) 12%, transparent); }
.dm-value { display: block; margin-top: 10px; font-size: 34px; font-weight: 260; line-height: 1; letter-spacing: -.025em; font-variant-numeric: tabular-nums; }
.dm-value.ok { color: var(--ok); }
.dm-value.warn { color: var(--warn); }
.dm-value > span { color: inherit; }
.dash-metric small { display: block; margin-top: auto; padding-top: 8px; color: var(--faint); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.dash-healthline { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 26px; margin-top: 12px; padding: 9px 14px; }
.rib-fact { display: inline-flex; align-items: baseline; gap: 9px; min-width: 0; }
.rib-fact .state { font-size: 12px; }
.rib-note { color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.dash-healthline > a { display: inline-flex; align-items: center; gap: 5px; color: var(--fg-2); font-size: 11px; font-weight: 550; }
.dash-healthline > a:hover { color: var(--accent-2); }
.dash-healthline > a svg { width: 12px; height: 12px; stroke: currentColor; }
.dash-unavailable { margin-bottom: 12px; padding: 12px 14px; }

/* Container workload, Docker storage, and recent activity. */
.band2 { display: grid; grid-template-columns: 1.6fr 1fr; gap: 12px; align-items: start; margin-bottom: 12px; }
.band2-col { display: grid; gap: 12px; min-width: 0; }
.hl-now { display: inline-flex; gap: 16px; margin-left: 12px; font-size: 11.5px; font-weight: 600; color: var(--fg-2); }
.hl-now b { margin-left: 5px; color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.hl-chart { width: 100%; height: 160px; }
.hl-chart .grid-line { stroke: var(--border); stroke-width: 1; }
.hl-chart .cpu-line { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1.4; vector-effect: non-scaling-stroke; }
.hl-chart .mem-line { fill: color-mix(in srgb, var(--teal) 10%, transparent); stroke: var(--teal); stroke-width: 1.4; vector-effect: non-scaling-stroke; }
/* Top consumers within the workload panel. */
.hl-top { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
.hl-top-h { margin: 0 0 6px; font-size: 11.5px; font-weight: 600; color: var(--fg-2); }
.diskcard .btn { margin-top: 14px; }
.ds-n { margin-left: 2px; color: var(--fg-2); font-size: 11px; font-variant-numeric: tabular-nums; }
a.ds-row:hover { color: var(--fg); }
a.ds-row:hover .ds-sz { color: var(--accent-2); }
.ds-row.ds-x .ds-dot { background: transparent; border: 1px solid var(--faint); }
.docker-notice { display: flex; align-items: center; gap: 11px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--lift); }
.docker-notice > span { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 8px; color: var(--faint); background: var(--panel); }
.docker-notice svg { width: 15px; height: 15px; stroke: currentColor; }
.docker-notice b, .docker-notice small { display: block; }
.docker-notice b { font-size: 12.5px; font-weight: 600; }
.docker-notice small { margin-top: 2px; color: var(--fg-2); font-size: 11px; }

.phone-setup { display: grid; grid-template-columns: auto minmax(240px, 1fr) auto auto; align-items: center; gap: 12px 18px; margin-bottom: 12px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--ok) 42%, var(--border)); border-radius: var(--radius); background: var(--panel); box-shadow: var(--shadow); }
.phone-setup.action { border-color: color-mix(in srgb, var(--warn) 48%, var(--border)); }
.phone-setup.blocked { border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); }
.phone-mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; color: var(--accent-2); background: var(--accent-soft); }
.phone-mark svg { width: 16px; height: 16px; stroke: currentColor; }
.phone-copy { min-width: 0; }
.phone-copy > span { display: block; color: var(--fg-2); font-size: 11px; font-weight: 600; }
.phone-copy b { display: block; margin-top: 1px; font-size: 13px; font-weight: 600; }
.phone-copy small { display: block; margin-top: 1px; color: var(--fg-2); font-size: 10.5px; }
.phone-facts { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 14px; color: var(--fg-2); font-size: 10.5px; }
.phone-facts span { white-space: nowrap; }
.phone-facts b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.phone-facts .warn, .phone-facts .warn b { color: var(--warn); }
.phone-facts .bad, .phone-facts .bad b { color: var(--bad); }

.dash-context { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; margin-bottom: 12px; }
.dash-context.single { grid-template-columns: minmax(340px, 760px); }
.qm-media-panel { min-width: 0; margin: 0; padding: 13px 14px; }
.qm-media-panel .nowplay { margin: 0; }
.qm-media-panel .np { padding: 8px 10px; box-shadow: none; }
.qm-media-panel .sc-metrics { margin-bottom: 9px; }
.qm-media-panel .sc-note { margin-top: 9px; }
.p-title { display: inline-flex; flex-direction: column; font-size: 13.5px; font-weight: 620; line-height: 1.2; }
.p-title small { margin-bottom: 2px; color: var(--faint); font-size: 11px; font-weight: 650; }
.dash-stacks { min-width: 0; padding: 13px 14px 5px; }
.dash-stacks .p-h { margin-bottom: 5px; }
.dash-stacks .count-tag { margin-left: 2px; }
.dash-stack-list { display: flex; flex-direction: column; }
.dash-stack-row { display: grid; grid-template-columns: 28px minmax(100px, 1fr) minmax(72px, .7fr) auto 14px; align-items: center; gap: 10px; min-height: 47px; color: var(--fg); border-top: 1px solid var(--border); }
.dash-stack-row:first-child { border-top: 0; }
.dash-stack-row:hover .dash-stack-name b { color: var(--accent-2); }
.dash-stack-row > svg { width: 13px; height: 13px; color: var(--faint); stroke: currentColor; }
.dash-stack-icon { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 7px; color: var(--accent-2); background: var(--accent-soft); }
.dash-stack-icon:is(.sh-0, .sh-1, .sh-2, .sh-3, .sh-4, .sh-5) { color: var(--sh-ink); background: var(--sh-bg); }
.dash-stack-icon svg { width: 14px; height: 14px; stroke: currentColor; }
.dash-stack-name { min-width: 0; }
.dash-stack-name b, .dash-stack-name small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-stack-name b { font-size: 12px; font-weight: 600; }
.dash-stack-name small { margin-top: 2px; color: var(--faint); font-size: 9.5px; }
.dash-stack-progress { height: 4px; overflow: hidden; border-radius: 3px; background: var(--lift); }
.dash-stack-progress i { display: block; height: 100%; border-radius: 3px; background: var(--teal); }
.dash-stack-row .state { justify-self: end; font-size: 10.5px; white-space: nowrap; }

.svc-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tr.t-svc { min-height: 48px; padding-top: 6px; padding-bottom: 6px; }
.tr.t-svc .svc-main .logo { flex: none; }
.service-route { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; overflow: hidden; color: var(--fg-2); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.service-route:hover { color: var(--accent-2); }
.service-route svg { width: 11px; height: 11px; flex: none; stroke: currentColor; }
.first-run { display: flex; align-items: center; gap: 8px 14px; flex-wrap: wrap; text-align: left; }
.first-run b { font-size: 13px; }
.first-run span { color: var(--fg-2); }
.first-run .btn { margin-left: auto; }

.market-intro { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: -5px 0 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); box-shadow: var(--shadow); }
.market-intro > div { min-width: 0; }
.market-intro b, .market-intro span { display: block; }
.market-intro b { font-size: 13px; font-weight: 600; }
.market-intro > div > span { margin-top: 2px; color: var(--fg-2); font-size: 11.5px; }
.market-browser-tools { display: flex; align-items: center; gap: 10px 18px; margin: -4px 0 12px; padding-bottom: 11px; border-bottom: 1px solid var(--border); }
.market-mode { margin-left: auto; color: var(--fg-2); font-size: 10.5px; font-weight: 500; text-align: right; }
.market-mode.warn { color: var(--warn); }
.market-tools { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.market-tools .tbar-search input { width: min(330px, 34vw); }
.market-tools .tbar-search input::placeholder { color: var(--fg-2); }
.market-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.market-card { display: flex; flex-direction: column; min-width: 0; min-height: 168px; padding: 12px 13px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); transition: border-color 140ms ease-out, background 140ms ease-out; }
.market-card:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); background: var(--lift); }
.market-card:has(.market-card-open:focus-visible), .market-card:has(.market-project:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.market-card-head { display: flex; align-items: center; gap: 9px; min-width: 0; }
.market-card-head .logo { width: 30px; height: 30px; flex: none; }
.market-card-title { min-width: 0; flex: 1; }
.market-card-title b, .market-card-title span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.market-card-title b { font-size: 13px; font-weight: 650; }
.market-card-title span { margin-top: 1px; color: var(--fg-2); font-size: 9.5px; }
.market-card > p { display: -webkit-box; min-height: 34px; margin: 9px 0 8px; overflow: hidden; color: var(--fg-2); font-size: 11px; line-height: 1.48; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.market-card-tags { display: flex; align-items: center; gap: 5px; min-width: 0; flex-wrap: wrap; }
.market-card-tags .badge { max-width: 100%; overflow: hidden; padding: 2px 6px; font-size: 9.5px; text-overflow: ellipsis; }
.market-category-chip { display: inline-flex; align-items: center; max-width: 100%; overflow: hidden; padding: 2px 6px; border-radius: 5px; background: var(--lift); color: var(--fg-2); font-size: 9.5px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.market-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: auto; padding-top: 9px; }
.market-card-open, .market-project { display: inline-flex; align-items: center; gap: 5px; min-width: 0; height: 26px; border-radius: 5px; font: inherit; font-size: 10.5px; font-weight: 600; text-decoration: none; cursor: pointer; }
.market-card-open { overflow: hidden; padding: 0; border: 0; background: none; color: var(--accent-2); text-overflow: ellipsis; white-space: nowrap; }
.market-card-open.primary { padding: 0 8px; background: var(--accent); color: #FFF; }
.market-card-open:hover { color: var(--fg); }
.market-card-open.primary:hover { background: var(--accent-2); color: #FFF; }
.market-project { flex: none; color: var(--fg-2); }
.market-project:hover { color: var(--accent-2); text-decoration: underline; text-underline-offset: 3px; }
.market-card-open svg, .market-project svg { width: 12px; height: 12px; flex: none; stroke: currentColor; }
.market-card-open:focus-visible, .market-project:focus-visible { outline: none; }
.market-empty-state { display: grid; place-items: center; gap: 6px; min-height: 180px; margin-top: 10px; padding: 24px; border: 1px dashed var(--border); border-radius: var(--radius); color: var(--fg-2); text-align: center; }
.market-empty-state b { color: var(--fg); font-size: 13px; }
.market-empty-state span { max-width: 58ch; font-size: 11.5px; }
.market-empty-state .btn { margin-top: 4px; }
.market-modal .modal-h > div { display: flex; flex-direction: column; min-width: 0; }
.market-description { margin: 0 0 13px; color: var(--fg-2); font-size: 12.5px; }
.market-connect-info { display: flex; align-items: flex-start; gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--lift); }
.market-connect-info > div { min-width: 0; }
.market-connect-icon { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: var(--radius-sm); color: var(--accent-2); background: var(--accent-soft); }
.market-connect-icon svg { width: 16px; height: 16px; stroke: currentColor; }
.market-connect-info b, .market-connect-info span { display: block; }
.market-connect-info b { font-size: 13px; font-weight: 600; }
.market-connect-info div span { margin-top: 3px; color: var(--fg-2); font-size: 11.5px; overflow-wrap: anywhere; }
.market-connect-info .market-endpoint { display: block; margin-top: 9px; color: var(--fg-2); font-size: 10.5px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.market-compose-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.market-compose-head b, .market-compose-head div span { display: block; }
.market-compose-head b { font-size: 12.5px; font-weight: 600; }
.market-compose-head div span { margin-top: 2px; color: var(--fg-2); font-size: 10.5px; }
.market-yaml { display: block; width: 100%; height: min(360px, 42vh); resize: vertical; padding: 12px 14px; border: 1px solid #2A303C; border-radius: var(--radius-sm); outline: 0; background: #16191F; color: #E8EAF0; font-size: 11.5px; line-height: 1.55; tab-size: 2; }
.market-yaml:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.market-notes { margin: 10px 0 0; padding-left: 19px; color: var(--fg-2); font-size: 11px; }
.market-notes li + li { margin-top: 3px; }
.market-deploy-fields { display: grid; grid-template-columns: auto minmax(180px, 280px) 1fr; align-items: center; gap: 8px 12px; margin-top: 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border)); border-radius: var(--radius-sm); background: var(--warn-soft); }
.market-deploy-fields label { font-size: 11px; font-weight: 600; }
.market-deploy-fields span { color: var(--fg-2); font-size: 10.5px; }
.market-modal-foot { align-items: center; flex-wrap: wrap; }
.market-status { min-width: 0; margin-right: auto; color: var(--fg-2); font-size: 11px; }
/* Community template source. */
.market-hint { margin: -7px 0 13px; color: var(--warn); font-size: 11.5px; }
/* Template sources. */
.srctable { min-width: 760px; }
.tr.t-tpl { grid-template-columns: minmax(110px, .7fr) minmax(240px, 1.7fr) 64px 150px 118px; }
.t-tpl .acts { justify-content: flex-end; }
.src-add { display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.src-add #src-name { width: 160px; }
.src-add #src-url { flex: 1; min-width: 240px; max-width: 520px; }
.src-add .hint { color: var(--fg-2); }

@media (max-width: 1200px) {
  .band2 { grid-template-columns: 1fr; }
  .dash-environment { grid-template-columns: minmax(220px, .8fr) minmax(260px, 1.2fr); }
  .de-actions { grid-column: 1 / -1; justify-content: space-between; padding-top: 9px; border-top: 1px solid var(--border); }
  .phone-setup { grid-template-columns: auto minmax(220px, 1fr) auto; }
  .phone-facts { grid-column: 2; }
  .phone-setup .btn { grid-column: 3; grid-row: 1 / span 2; }
  .market-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .market-mode { width: 100%; margin-left: 0; text-align: left; }
}
@media (max-width: 980px) {
  .dash-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .market-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .dash-environment { grid-template-columns: 1fr; }
  .de-actions { grid-column: auto; align-items: flex-start; flex-wrap: wrap; }
  .de-actions > a { min-width: 0; margin-left: auto; text-align: right; white-space: normal; }
  .dm-value { font-size: clamp(26px, 7vw, 34px); white-space: nowrap; }
  .dash-healthline .grow { display: none; }
  .dash-healthline > a { width: 100%; padding-top: 6px; border-top: 1px solid var(--border); }
  .hl-chart { height: 130px; }
  .phone-setup { grid-template-columns: auto minmax(0, 1fr); }
  .phone-facts { grid-column: 1 / -1; }
  .phone-setup .btn { grid-column: 1 / -1; grid-row: auto; justify-content: center; width: 100%; }
  .dash-context, .dash-context.single { grid-template-columns: 1fr; }
  .dash-stack-row { grid-template-columns: 28px minmax(90px, 1fr) auto 14px; }
  .dash-stack-progress { display: none; }
  .market-intro { align-items: flex-start; flex-direction: column; }
  .market-browser-tools { align-items: stretch; flex-direction: column; }
  .market-tools { align-items: stretch; flex-direction: column; width: 100%; }
  .market-tools .tbar-search, .market-tools .tbar-search input, .market-tools .tbar-sel { width: 100%; }
  .market-tools .market-clear { justify-content: center; width: 100%; }
  .market-grid { grid-template-columns: minmax(0, 1fr); }
  .market-deploy-fields { grid-template-columns: 1fr; }
  .market-modal-foot { align-items: stretch; flex-direction: column; }
  .market-modal-foot .market-status { width: 100%; }
  .market-modal-foot .btn { justify-content: center; width: 100%; }
  .pair-service-head { grid-template-columns: minmax(0, 1fr) auto; }
  .pair-route-summary { grid-column: 1 / -1; grid-row: 2; }
  .pair-service-head .credwrap { grid-column: 1; grid-row: 3; }
  .pair-service-toggle { grid-column: 2; grid-row: 3; }
}

`;

export const stacks = `/* ---------- compose stacks ---------- */
.stack-tools .tool-primary { gap: 12px; }
.stack-tools .tbar-search input { width: min(320px, 42vw); }
.stack-group { padding: 0; overflow: hidden; margin: 0 0 10px; }
.stack-thead, .stack-summary { display: grid; grid-template-columns: 22px 32px minmax(190px, 1fr) 64px 64px 64px 64px 118px 126px; align-items: center; gap: 12px; }
.stack-thead { padding: 0 15px 7px; color: var(--fg-2); font-size: 11.5px; font-weight: 600; }
.stack-thead .r { text-align: right; }
.stack-summary { min-height: 60px; padding: 9px 14px; cursor: pointer; list-style: none; }
.stack-summary::-webkit-details-marker { display: none; }
.stack-summary:hover { background: var(--lift); }
.stack-toggle { width: 22px; height: 22px; display: grid; place-items: center; color: var(--faint); }
.stack-toggle svg { width: 13px; height: 13px; stroke: currentColor; transition: transform 150ms ease-out; }
.stack-group[open] .stack-toggle svg { transform: rotate(90deg); }
.stack-symbol { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; background: var(--accent-soft); color: var(--accent-2); }
/* Stack colour marker. */
.stack-symbol:is(.sh-0, .sh-1, .sh-2, .sh-3, .sh-4, .sh-5) { background: var(--sh-bg); color: var(--sh-ink); }
.stack-symbol svg { width: 15px; height: 15px; stroke: currentColor; }
.stack-identity { min-width: 0; }
.stack-identity .si-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.stack-identity .si-top > b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.stack-identity > small { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); font-size: 10.5px; }
.mngchip { flex: none; font-size: 10px; padding: 1.5px 7px; }
.adoptbtn { flex: none; border: 0; background: none; padding: 0; color: var(--accent-2); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.adoptbtn:hover { text-decoration: underline; }
.st-kpi { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; }
.st-kpi.warm { color: var(--warn); }
.st-kpi.zero { color: var(--faint); }
.st-state .state { font-size: 12px; white-space: nowrap; }
.stack-summary .acts { justify-content: flex-end; }
.stack-body { padding: 12px 14px 14px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 58%, var(--panel)); }
/* Stack actions. */
.stack-verbs { display: flex; gap: 8px; margin: 2px 0 12px; }
.stack-verbs .btn { flex: 1; justify-content: center; }
.stack-verbs .sv-down:hover { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); }
.updot.quiet { background: var(--faint); opacity: .5; }
/* Resolved variables. */
.varchips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.varchips[hidden] { display: none; }
.varchip { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--border); border-radius: 6px; padding: 2.5px 8px; font-size: 10.5px; }
.varchip .vk { color: var(--fg-2); font-weight: 600; }
.varchip code { font-family: var(--mono); font-size: 11px; color: var(--fg); }
.varchip .vunset { color: var(--bad); font-style: normal; font-weight: 600; font-size: 10.5px; }
#sed-ops { margin-top: 10px; }
#sed-ops:empty { display: none; }
/* Activity follow indicator. */
.followdot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
#follow.on { color: var(--fg); }
#follow.on .followdot { background: var(--ok); }
@media (prefers-reduced-motion: no-preference) { #follow.on .followdot { animation: livedot 2s ease-in-out infinite; } }

.svcgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; margin-top: 4px; }
/* Service status marker. */
.svccard { position: relative; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--panel); transition: border-color 140ms ease-out, background 140ms ease-out; }
.svccard:hover { border-color: color-mix(in srgb, var(--accent) 38%, var(--border)); background: var(--lift); }
.svccard.is-running { border-color: color-mix(in srgb, var(--ok) 32%, var(--border)); }
.svccard.is-stopped { border-color: var(--border); }
.svccard.is-unhealthy { border-color: color-mix(in srgb, var(--bad) 42%, var(--border)); }
/* Service update marker. */
.svccard.has-update { border-color: color-mix(in srgb, var(--warn-mark) 46%, var(--border)); }
.svc-upd { display: inline-flex; align-items: center; gap: 5px; border: 1px solid color-mix(in srgb, var(--warn-mark) 45%, var(--border)); border-radius: 6px; background: var(--warn-soft); color: var(--warn); padding: 1.5px 7px; font-size: 10.5px; font-weight: 600; }
.svc-upd i { width: 6px; height: 6px; border-radius: 50%; background: var(--warn-mark); flex: none; }
/* Service header. */
.svc-top { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 3px; }
.svc-top .logo { width: 22px; height: 22px; border-radius: 5px; margin-top: 1px; }
.svc-top b { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.svc-top .state, .svc-top .badge { margin-left: auto; }
.svc-name { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.svc-name span { color: var(--faint); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Service uptime. */
.svc-name .svc-age { margin-top: 1px; font-variant-numeric: tabular-nums; }
.svc-state { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: none; }
.svc-state .state { margin-left: 0; }
.svc-state .healthline.off { display: none; }
.svc-state .nohealth { display: none; }
.svc-img { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 10px; }
.meters { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; margin-bottom: 11px; }
.meter { font-size: 11px; font-weight: 500; color: var(--fg-2); }
.meter .m-row { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.meter .m-row b { font-weight: 600; color: var(--fg); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.meter .m-bar { height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--border) 70%, transparent); margin-top: 5px; overflow: hidden; }
.meter .m-bar i { display: block; height: 100%; width: 100%; border-radius: 2px; transform: scaleX(0); transform-origin: left; transition: transform 240ms ease-out; }
/* CPU and memory are percentages; network and disk are relative totals. */
.m-cpu .m-bar i { background: var(--accent); }
.m-mem .m-bar i { background: var(--teal); }
.m-net .m-bar i { background: var(--port-ink); }
.m-dsk .m-bar i { background: color-mix(in srgb, var(--fg-2) 70%, transparent); }
.svc-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.svc-foot { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; min-height: 23px; }
.svc-foot > a { display: inline-flex; align-items: center; gap: 5px; flex: none; color: var(--fg-2); font-size: 10.5px; font-weight: 500; }
.svc-foot > a:hover { color: var(--accent-2); }
.svc-foot > a svg { width: 11px; height: 11px; stroke: currentColor; }
.svccard .btn.deploy { width: 100%; justify-content: center; margin-top: 10px; }
/* Deployment editor layout. */
.dp-split { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 14px; align-items: start; }
.dp-split .pane-h { margin: 0 0 6px; }
.envpane { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.envrow { margin-bottom: 8px; }
.envrow .in { flex: 1; min-width: 0; }
.envnil { border: 1px dashed var(--border); border-radius: var(--radius-sm); padding: 16px 12px; text-align: center; color: var(--faint); font-size: 12px; }
.dp-f { justify-content: space-between; align-items: flex-end; gap: 16px; }
.dp-btns { display: flex; gap: 8px; flex: none; margin-left: auto; }
@media (max-width: 720px) { .dp-split { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 900px) {
  .stack-summary { grid-template-columns: 22px 30px minmax(140px, 1fr) 110px auto; }
  .stack-thead, .st-kpi { display: none; }
  .stack-tools .tool-primary { align-items: flex-start; flex-direction: column; }
  .stack-tools .tbar-search, .stack-tools .tbar-search input { width: 100%; }
}

`;

export const settings = `/* ---------- settings ---------- */
.setgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; max-width: 1060px; }
/* Single-column settings layout. */
.setgrid.one { grid-template-columns: minmax(0, 560px); }
/* Profile columns. */
.setcol { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
@media (max-width: 900px) { .setgrid { grid-template-columns: 1fr; } }
.setcard { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 4px 18px 6px; }
.setcard .sec-h { display: flex; align-items: center; gap: 8px; padding: 14px 0 8px; margin: 0; border-bottom: 1px solid var(--border); }
.setcard .sec-h svg { display: none; }
.kv { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 11px 0; border-bottom: 1px solid var(--border); }
.kv:last-child { border-bottom: 0; }
/* Keep value controls at their intrinsic width. */
.kv > span:first-child { flex: 1 1 auto; min-width: 0; }
.kv span { font-weight: 500; font-size: 13px; }
.kv > .badge, .kv > a, .kv > button { flex: none; }
.kv span small { display: block; color: var(--fg-2); font-weight: 400; font-size: 11.5px; margin-top: 2px; max-width: 40ch; line-height: 1.45; }
.kv span .badge { margin-left: 8px; vertical-align: 1px; }
/* Limit long fingerprint values. */
.kv b { flex: 0 1 auto; min-width: 0; max-width: 58%; margin-top: 2px; text-align: right; overflow-wrap: anywhere; font-weight: 600; font-size: 11.5px; font-variant-numeric: tabular-nums; }

`;

export const auth = `/* ---------- auth ---------- */
.auth { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 12px 40px rgb(0 0 0 / .3); padding: 38px 36px 28px; width: 100%; max-width: 400px; text-align: center; }
.light .card { box-shadow: 0 1px 3px rgb(20 24 33 / .08), 0 12px 32px rgb(20 24 33 / .1); }
.card .mark { width: 58px; height: 58px; border-radius: 50%; margin: 0 auto 12px; overflow: hidden; }
.card .wm { font-size: 11.5px; color: var(--fg-2); font-weight: 600; margin-bottom: 22px; }
.card h1 { font-size: 22px; font-weight: 600; letter-spacing: -.01em; margin: 0 0 6px; }
.card .lead { color: var(--fg-2); font-size: 13px; margin: 0 0 22px; }
.field { text-align: left; margin-bottom: 14px; }
label { display: block; font-size: 11.5px; font-weight: 600; color: var(--fg-2); margin: 0 0 8px; }
.field input, .connremote { width: 100%; height: 40px; padding: 0 13px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg); color: var(--fg); font: inherit; }
input::placeholder { color: var(--faint); }
.field input:focus, .connremote:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.card .btn.primary { width: 100%; justify-content: center; height: 40px; margin-top: 4px; }
.foot { color: var(--faint); font-size: 11.5px; margin: 22px 0 0; }
.err { background: var(--bad-soft); border: 1px solid var(--bad); color: var(--bad); font-size: 12.5px; padding: 9px 12px; border-radius: var(--radius-sm); margin: 0 0 16px; text-align: left; }

`;

export const pairing = `/* ---------- pairing ---------- */
.pair-wrap { display: grid; grid-template-columns: 300px 1fr; gap: 26px; align-items: start; }
.conncard { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px 18px; margin: 0 0 20px; max-width: 760px; }
.cc-h { font-size: 13.5px; font-weight: 600; margin-bottom: 13px; }
.cc-sub { color: var(--fg-2); font-weight: 400; font-size: 12px; margin-left: 8px; }
.connform { display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; }
/* Connection labels. */
.crad { display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; flex: 1; min-width: 158px; transition: border-color 140ms ease-out, background 140ms ease-out; }
.crad.on { border-color: var(--accent); background: var(--accent-soft); }
.crad input { margin-top: 2px; accent-color: var(--accent); }
.crad b { font-size: 13px; font-weight: 600; display: block; }
.crad small { color: var(--fg-2); font-size: 11.5px; }
.connremote { flex: 2 1 100%; height: 38px; }
.cc-hint { font-size: 12.5px; color: var(--fg-2); margin: 12px 0 0; }
.pair-form { max-width: 980px; }
.pair-form .conncard { max-width: none; }
.pair-credential-note { max-width: 980px; display: flex; align-items: center; gap: 9px; flex-wrap: wrap; background: var(--panel); border: 1px solid color-mix(in srgb, var(--ok) 40%, var(--border)); border-radius: var(--radius); box-shadow: var(--shadow); padding: 13px 15px; margin: 0 0 16px; }
.pair-credential-note > div { flex: 1 1 320px; min-width: 0; }
.pair-credential-note b { display: block; font-size: 13px; }
.pair-credential-note div > span { display: block; margin-top: 2px; color: var(--fg-2); font-size: 12px; line-height: 1.45; }
.pair-services { display: grid; gap: 12px; margin-bottom: 16px; }
.pair-service { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
.pair-service-head { display: grid; grid-template-columns: minmax(190px, .8fr) minmax(220px, 1.2fr) auto auto; align-items: center; gap: 12px 18px; min-height: 66px; padding: 10px 14px; }
.pair-pick { display: flex; align-items: center; gap: 10px; margin: 0; cursor: pointer; color: var(--fg); }
.pair-pick > input { accent-color: var(--accent); }
.pair-pick .svc-logo, .pair-pick .svc-icon { flex: none; }
.pair-pick b { display: block; font-size: 13.5px; }
.pair-pick small { display: block; color: var(--fg-2); font-size: 11.5px; font-weight: 400; margin-top: 2px; }
.pair-route-summary { min-width: 0; }
.pair-route-summary span, .pair-route-summary small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pair-route-summary span { color: var(--fg-2); font-size: 11.5px; }
.pair-route-summary small { margin-top: 2px; color: var(--faint); font-size: 10.5px; }
.pair-service-toggle { justify-content: space-between; min-width: 112px; }
.pair-service-toggle svg { width: 13px; height: 13px; transition: transform 140ms ease-out; }
.pair-service.open .pair-service-toggle svg { transform: rotate(90deg); }
.pair-service-body { padding: 12px 14px 2px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--lift) 42%, var(--panel)); }
.pair-route-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pair-route-grid .field { margin-bottom: 12px; }
.pair-route-grid label span, .edge-card summary span { color: var(--fg-2); font-weight: 400; margin-left: 4px; }
.edge-card summary { cursor: pointer; font-size: 13.5px; font-weight: 600; }
.edge-card[open] summary { margin-bottom: 4px; }
.pair-edge-grid { display: grid; grid-template-columns: .8fr 1.2fr 1.2fr; gap: 12px; margin-top: 15px; }
.pair-edge-grid .field { margin-bottom: 0; }
.pair-submit { display: flex; align-items: center; gap: 14px; padding: 2px 0 24px; }
.pair-submit span { color: var(--fg-2); font-size: 12px; }
.pair-errors > div + div { margin-top: 4px; }
.qr { background: #FFF; border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; place-items: center; }
.qr img { width: 100%; max-width: 268px; image-rendering: pixelated; }
.qr .count { margin-top: 10px; color: #5B6473; font-size: 11.5px; }
.qr-ctrl { display: flex; gap: 8px; margin-top: 10px; }
.qr-ctrl button { flex: 1; height: 32px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); color: var(--fg); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; }
.qr-ctrl button:hover { background: var(--lift); }
.passbox { border: 1px solid var(--border); border-radius: var(--radius); padding: 13px 15px; background: var(--panel); box-shadow: var(--shadow); margin: 14px 0; }
.passbox span { font-size: 11.5px; color: var(--fg-2); font-weight: 600; }
.passbox code { display: block; font-family: var(--mono); font-size: 16px; line-height: 1.5; margin-top: 8px; overflow-wrap: anywhere; }
.passbox .p-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
/* Copy controls for secrets and recovery codes. */
.copybtn { border: 1px solid var(--border); background: var(--panel); color: var(--fg-2); font: inherit; font-size: 11px; font-weight: 600; border-radius: 999px; padding: 3px 10px; cursor: pointer; flex: none; }
.copybtn:hover { background: var(--lift); color: var(--fg); }
.codegrid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; padding: 12px 0 14px; }
.codegrid b { font-family: var(--mono); font-size: 14px; font-weight: 500; letter-spacing: .04em; }
@media (max-width: 620px) { .codegrid { grid-template-columns: 1fr; } }
.steps { counter-reset: s; list-style: none; padding: 0; margin: 0 0 22px; max-width: 60ch; }
.steps li { position: relative; padding: 0 0 13px 32px; color: var(--fg-2); font-size: 13.5px; }
.steps li::before { counter-increment: s; content: counter(s); position: absolute; left: 0; top: 0; width: 21px; height: 21px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-2); font-size: 11px; font-weight: 600; display: grid; place-items: center; }
.steps b { color: var(--fg); }
.pair-ready-list { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); overflow: hidden; }
.pair-ready-row { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 11px 13px; border-bottom: 1px solid var(--border); }
.pair-ready-row:last-child { border-bottom: 0; }
.pair-ready-row b { display: block; font-size: 13px; }
.pair-ready-row small { display: block; color: var(--fg-2); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
.pair-fallback { width: 100%; height: auto; min-height: 34px; justify-content: center; padding: 8px 12px; line-height: 1.35; text-align: center; white-space: normal; }
.empty { border: 1px dashed var(--border); border-radius: var(--radius); padding: 44px; text-align: center; color: var(--fg-2); }
.empty code { color: var(--fg); font-family: var(--mono); }
/* Setup checklist. */
.credwrap { display: inline-flex; }
@media (prefers-reduced-motion: no-preference) { .credwrap.flip .badge { animation: credflip .24s ease; } }
@keyframes credflip { 0% { opacity: 0; transform: translateY(-3px); } 100% { opacity: 1; transform: none; } }
.pair-ladder { border-top: 1px solid var(--border); margin: 0 -14px; padding: 12px 14px; display: flex; align-items: flex-start; gap: 10px 14px; flex-wrap: wrap; }
.pair-ladder[hidden] { display: none; }
.lad-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pair-key-entry { flex: 1 1 430px; justify-content: flex-end; }
.pair-key-field { display: flex; align-items: center; gap: 8px; min-width: min(280px, 100%); flex: 1 1 280px; }
.pair-key-field > span { color: var(--fg-2); font-size: 11px; font-weight: 600; line-height: 1.25; max-width: 112px; }
.pair-key-field .in { min-width: 120px; flex: 1; height: 34px; }
.pair-key-status { color: var(--fg-2); font-size: 11.5px; flex: 1 1 100%; text-align: right; min-height: 1em; }
.lad-hint { color: var(--fg-2); font-size: 12px; line-height: 1.5; flex: 1 1 220px; min-width: 0; }
.mountpanel { flex: 1 1 100%; }
.mountpanel > summary { cursor: pointer; color: var(--accent-2); font-size: 12.5px; font-weight: 500; list-style: none; }
.mountpanel > summary::-webkit-details-marker { display: none; }
.mountpanel[open] > summary { margin-bottom: 8px; }
.mountpanel p { color: var(--fg-2); font-size: 12px; line-height: 1.5; margin: 0 0 8px; }
.mountpanel p code, .copyline code { font-family: var(--mono); color: var(--fg); }
.copyline { display: flex; align-items: center; gap: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; }
.copyline code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; font-size: 12px; }
.key-made { display: none; align-items: center; gap: 8px; color: var(--ok); font-size: 12.5px; flex: 1 1 100%; }
.key-made.on { display: inline-flex; }
.key-made svg { width: 15px; height: 15px; flex: none; }
.key-made button { border: none; background: none; color: var(--accent-2); font: inherit; font-size: 12.5px; cursor: pointer; padding: 0; text-decoration: underline; }
.pair-open[aria-disabled="true"] { opacity: .5; pointer-events: none; }
@media (max-width: 700px) {
  .pair-key-entry { justify-content: flex-start; }
  .pair-key-field { flex-basis: 100%; }
  .pair-key-field > span { max-width: 100px; }
  .pair-key-status { text-align: left; }
}
.pair-readiness { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--fg-2); font-weight: 500; }
.pair-readiness .rdot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); display: inline-block; }
.pair-readiness.ready { color: var(--ok); }
.pair-readiness.ready .rdot { background: var(--ok); }
@media (prefers-reduced-motion: no-preference) { .pair-readiness:not(.ready) .rdot { animation: livedot 2s ease-in-out infinite; } }
/* Key creation dialog. */
.modal.mint { max-width: 520px; }
.mint-note { color: var(--fg-2); font-size: 12.5px; line-height: 1.5; margin: 0 0 14px; }
.mint-note[hidden] { display: none; }
.mint-security { border-bottom: 1px solid var(--border); padding: 0 0 13px; margin: 0 0 14px; }
.mint-security > b, .mint-warning > b { display: block; color: var(--fg); font-size: 12.5px; margin-bottom: 6px; }
.mint-security p, .mint-warning p { color: var(--fg-2); font-size: 12px; line-height: 1.5; margin: 0; }
.mint-security p + p, .mint-warning p + p { margin-top: 7px; }
.mint-protections { display: grid; gap: 7px; list-style: none; margin: 11px 0; padding: 0; }
.mint-protections li { position: relative; padding-left: 16px; color: var(--fg-2); font-size: 12px; line-height: 1.45; }
.mint-protections li::before { content: ''; position: absolute; left: 1px; top: .52em; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.mint-protections b { color: var(--fg); }
.mint-security p.mint-cert { color: var(--warn); }
.mint-warning { background: var(--warn-soft); border: 1px solid color-mix(in srgb, var(--warn-mark) 45%, var(--border)); border-radius: 12px; padding: 13px 14px; margin: 0 0 14px; }
.mint-warning[hidden] { display: none; }
.mint-warning > b, .mint-warning p { color: var(--warn); }
.mint-consent { display: flex; align-items: flex-start; gap: 9px; min-height: 44px; margin-top: 11px; padding: 7px 0; color: var(--fg); font-size: 12px; font-weight: 600; line-height: 1.4; cursor: pointer; }
.mint-consent input { width: 17px; height: 17px; flex: none; margin: 0; accent-color: var(--accent); }
.mint-field { display: block; margin-bottom: 12px; }
.mint-field span { display: block; font-size: 11.5px; font-weight: 600; color: var(--fg-2); margin-bottom: 6px; }
.mint-field .in { width: 100%; height: 38px; }
.mint-ops:empty { display: none; }
/* Late-key banner on the ready page. */
.reissue-form { max-width: 640px; margin: 18px 0 0; }
.reissue-form[hidden] { display: none; }
.reissue-banner { background: var(--panel); border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: var(--radius); padding: 12px 14px; margin-bottom: 10px; font-size: 13px; }

`;
