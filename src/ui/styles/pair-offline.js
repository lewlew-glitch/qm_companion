// Setup availability groups.
export const pairOffline = `/* ---------- pairing: availability groups ---------- */
.pair-avail-section { margin: 6px 0 18px; }
.pair-avail-section > .sec-h { display: flex; align-items: center; gap: 8px; margin: 22px 0 6px; }
.pair-avail-section > .sec-h::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
.pair-avail-unreachable > .sec-h::before { background: var(--warn-mark); }
.pair-avail-stopped > .sec-h::before { background: var(--bad); }
.pair-avail-section > .cc-hint { margin: 0 0 12px; max-width: 760px; }
.pair-service.is-unreachable, .pair-service.is-stopped, .pair-service.is-unverified { background: color-mix(in srgb, var(--panel) 72%, var(--bg)); }
.pair-service.is-stopped { border-style: dashed; }
.pair-service.is-unreachable .pair-pick b, .pair-service.is-stopped .pair-pick b { color: var(--fg-2); }
.pair-service.is-stopped .logo, .pair-service.is-stopped .pair-route-summary { opacity: .55; }
.pair-pick > input:disabled { accent-color: var(--faint); opacity: .45; cursor: not-allowed; }
.pair-service.is-stopped .pair-pick { cursor: not-allowed; }
.pair-avail-note { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0; padding: 0 14px 12px; color: var(--fg-2); font-size: 12px; line-height: 1.5; }
.pair-service.is-unverified .pair-avail-note { color: var(--faint); }
.pair-advanced { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.pair-advanced small { color: var(--faint); font-size: 11.5px; }
.pair-include-anyway { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; font-size: 12px; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.pair-include-anyway:hover { color: var(--accent-2); }
.pair-include-anyway:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.pair-service[data-forced] { background: var(--panel); border-color: var(--warn-mark); }
.pair-service[data-forced] .pair-advanced { display: none; }
`;
