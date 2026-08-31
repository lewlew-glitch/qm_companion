// Controls, consoles, modals, and operation feedback.

export const controls = `/* ---------- controls ---------- */
.tbar-search { position: relative; display: flex; align-items: center; }
.tbar-search svg { position: absolute; left: 10px; width: 14px; height: 14px; stroke: var(--faint); pointer-events: none; }
.tbar-search input { height: 32px; width: 230px; padding: 0 12px 0 31px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--panel); color: var(--fg); font: inherit; font-size: 12.5px; }
.tbar-search input::placeholder { color: var(--faint); }
.tbar-sel { height: 32px; padding: 0 26px 0 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--panel); color: var(--fg); font: inherit; font-size: 12.5px; cursor: pointer; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2399A2B1' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; background-size: 12px; }
.tbar-search input:focus, .tbar-sel:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

.btn { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 13px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--panel); color: var(--fg); font: inherit; font-weight: 500; font-size: 12.5px; cursor: pointer; text-decoration: none; transition: background 140ms ease-out; }
.btn:hover { background: var(--lift); }
.btn svg { width: 14px; height: 14px; stroke: currentColor; }
.btn.primary { background: var(--accent); border-color: transparent; color: #FFF; font-weight: 600; }
.btn.primary:hover { background: var(--accent-2); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.rightrow { display: flex; justify-content: flex-end; margin: 0 0 12px; }

/* Page controls sit in a stable work bar instead of competing with the title and machine facts. */
.page-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 14px; margin: 0 0 12px; padding: 10px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.tool-primary, .tool-actions { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tool-actions { justify-content: flex-end; }
.tool-note { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; min-height: 0; }
.tool-note:empty { display: none; }
.tool-note .hint:empty { display: none; }
.mode-note { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; color: var(--fg-2); font-size: 11px; font-weight: 600; white-space: nowrap; }
.mode-note::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.mode-note svg { width: 14px; height: 14px; flex: 0 0 14px; color: var(--warn); }

@media (max-width: 760px) {
  .page-tools { grid-template-columns: 1fr; }
  .tool-actions { justify-content: flex-start; flex-wrap: wrap; }
  .tool-note { grid-column: 1; }
}

`;

export const consoles = `/* ---------- consoles ---------- */
.logtabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
.logtab { padding: 5px 12px; border: 1px solid var(--border); border-radius: 999px; color: var(--fg-2); font-size: 12px; font-weight: 500; text-decoration: none; background: var(--panel); }
.logtab:hover { background: var(--lift); color: var(--fg); }
.logtab.on { background: var(--accent-soft); border-color: transparent; color: var(--accent-2); font-weight: 600; }
.console { background: #16191F; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
.light .console { border-color: #16191F; }
.console-bar { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid #2A303C; flex-wrap: wrap; }
.console-bar .live { display: inline-flex; align-items: center; gap: 6px; color: #41B663; font-size: 11.5px; font-weight: 600; }
.console-bar .live .hdot { background: #41B663; }
/* Auto-scroll state. */
.console-bar .live.off { color: #5E6673; }
.console-bar .live.off .hdot { background: #5E6673; }
.console-bar .cname { color: #99A2B1; font-family: var(--console); font-size: 11.5px; }
/* Log filter count. */
.matchcount { flex: none; padding: 2px 9px; border-radius: 999px; background: rgba(91, 120, 240, .18); color: #7B93F4; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.matchcount[hidden] { display: none; }
.chipbtn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px; border-radius: 999px; border: 0; background: rgba(91, 120, 240, .18); color: #7B93F4; font-size: 11px; font-weight: 600; cursor: pointer; }
.chipbtn svg { width: 11px; height: 11px; stroke: currentColor; }
.chipbtn.off { background: none; border: 1px solid #2A303C; color: #5E6673; }
.console-bar select { height: 26px; padding: 0 24px 0 9px; border-radius: 999px; border: 1px solid #2A303C; background: #20252F; color: #99A2B1; font-size: 11px; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2399A2B1' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; background-size: 11px; }
.logs, .term { padding: 13px 16px; font-size: 12px; line-height: 1.6; color: #C6CCD8; max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; font-family: var(--console); }
/* Shell console layout. */
.term, .term-empty { height: calc(100vh - 320px); min-height: 280px; max-height: none; }
.term-empty { display: grid; place-items: center; color: #5E6673; font-size: 13px; text-align: center; }
.term-empty svg { width: 36px; height: 36px; stroke: currentColor; margin: 0 auto 12px; }
/* Fixed console palette. */
.logstatus { font-size: 11.5px; color: #99A2B1; }
.termbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid #2A303C; }
.termbar .prompt { color: #41B663; font-size: 12px; flex: none; font-family: var(--console); }
.termbar input { flex: 1; height: 32px; padding: 0 12px; border-radius: 7px; border: 1px solid #2A303C; background: #20252F; color: #E8EAF0; font-family: var(--console); font-size: 12px; }
.termbar input:focus { outline: none; border-color: #5B78F0; }
.termbar input:disabled { opacity: .6; }

/* Logs layout. */
.loglayout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 14px; height: calc(100vh - 112px); min-height: 340px; }
.logside { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); display: flex; flex-direction: column; min-height: 0; }
.logside .tbar-search { margin: 10px 10px 8px; }
.logside .tbar-search input { width: 100%; }
.logrows { flex: 1; overflow: auto; padding: 0 6px 6px; }
.logrow { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: var(--radius-sm); color: var(--fg-2); }
.logrow:hover { background: var(--lift); }
.logrow.on { background: var(--accent-soft); }
.logrow .sdot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
.logrow .sdot.ok { background: var(--ok); }
.logrow .sdot.warn { background: var(--warn-mark); }
.logrow .sdot.bad { background: var(--bad); }
.lr-txt { min-width: 0; display: flex; flex-direction: column; }
.lr-name { font-size: 13px; font-weight: 500; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.logrow.on .lr-name { color: var(--accent-2); }
.lr-img { font-size: 10.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lr-count { padding: 8px 14px; border-top: 1px solid var(--border); font-size: 11px; color: var(--faint); }
/* Multi-select marker. */
.logrow .tick { display: none; width: 14px; height: 14px; border: 1.5px solid var(--faint); border-radius: 4px; flex: none; position: relative; }
.loglayout.multi .logrow .tick { display: block; }
.loglayout.multi .logrow.on { background: none; }
.loglayout.multi .logrow.on .lr-name { color: var(--fg); }
.logrow.picked .tick { border-color: currentColor; background: currentColor; }
.logrow.picked .tick::after { content: ""; position: absolute; left: 3.5px; top: 0.5px; width: 4px; height: 7px; border: solid #FFF; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.logconsole { display: flex; flex-direction: column; min-height: 0; }
.logconsole .logs { flex: 1; max-height: none; }
.logsearch { position: relative; display: flex; align-items: center; }
.logsearch svg { position: absolute; left: 9px; width: 12px; height: 12px; stroke: #5E6673; pointer-events: none; }
.logsearch input { height: 26px; width: 180px; padding: 0 10px 0 27px; border-radius: 999px; border: 1px solid #2A303C; background: #20252F; color: #C6CCD8; font: inherit; font-size: 11px; }
.logsearch input::placeholder { color: #5E6673; }
.logsearch input:focus { outline: none; border-color: #5B78F0; }
/* Name-prefix colours for multi-container console output. */
.lc0 { color: #7B93F4; }
.lc1 { color: #41B663; }
.lc2 { color: #C6CCD8; }
.lc3 { color: #99A2B1; }
.lc4 { color: #5E6673; }
.lc5 { color: #E8837B; }
.logs .lp { font-weight: 600; }
/* Tint recognised level words without colouring the full line. */
.logs .lvl-err { color: #E25A50; font-weight: 600; }
.logs .lvl-warn { color: #E0A23E; font-weight: 600; }
.logs .lvl-info { color: #99A2B1; font-weight: 600; }
.logs .lvl-dbg { color: #5E6673; font-weight: 600; }
/* The controlled split view reserves space for logs and an interactive shell. */
.logconsole.split .logs { flex: 3; }
.shellpane { flex: 2; flex-direction: column; min-height: 0; border-top: 1px solid #2A303C; }
.logconsole.split .shellpane { display: flex; }
.shellpane[hidden] { display: none; }
.shellhead { padding: 7px 14px; border-bottom: 1px solid #2A303C; }
.sh-note { color: #99A2B1; font-size: 11px; }
.sh-note code { font-family: var(--mono); font-size: 11px; color: #C6CCD8; }
.shellpane .term { flex: 1; height: auto; min-height: 0; max-height: none; }
.shellpane .termbar { border-top: 1px solid #2A303C; }

/* Shared primitives for overlays, modals, segmented controls, editors, and inline forms. */
.overlay { position: fixed; inset: 0; background: rgb(0 0 0 / .62); z-index: 40; display: grid; place-items: center; padding: 24px; }
.overlay[hidden], .overlay.hidden { display: none; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); width: 100%; box-shadow: 0 12px 40px rgb(0 0 0 / .3); display: flex; flex-direction: column; max-height: 88vh; }
.light .modal { box-shadow: 0 1px 3px rgb(20 24 33 / .08), 0 12px 32px rgb(20 24 33 / .1); }
.modal.sm { max-width: 440px; }
.modal.lg { max-width: 860px; }
.modal-h { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.modal-h b { font-size: 16px; font-weight: 600; }
.modal-sub { color: var(--fg-2); font-size: 12px; }
.modal-h .iconbtn { margin-left: auto; flex: none; }
.modal-b { padding: 16px; overflow-y: auto; }
.modal-f { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.mode-choices { display: grid; gap: 8px; margin: 16px 0 12px; padding: 0; border: 0; }
.mode-choice { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); cursor: pointer; }
.mode-choice:hover { border-color: var(--fg-2); }
.mode-choice:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.mode-choice.unavailable { opacity: .62; cursor: not-allowed; }
.mode-choice input { position: absolute; opacity: 0; pointer-events: none; }
.mode-radio { width: 16px; height: 16px; margin-top: 1px; border: 1.5px solid var(--fg-2); border-radius: 50%; display: grid; place-items: center; }
.mode-choice input:focus-visible + .mode-radio { outline: 2px solid var(--accent); outline-offset: 2px; }
.mode-choice input:checked + .mode-radio { border-color: var(--accent); }
.mode-choice input:checked + .mode-radio::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.mode-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mode-copy b { font-size: 13px; font-weight: 600; color: var(--fg); }
.mode-copy small { color: var(--fg-2); font-size: 12px; line-height: 1.45; }
.mode-copy em { color: var(--warn); font-size: 11.5px; font-style: normal; }
.mode-ceiling { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--lift); }
.mode-ceiling b { font-size: 12px; font-weight: 600; }
.mode-ceiling span { color: var(--fg-2); font-size: 11.5px; line-height: 1.45; }
.mode-stepup { display: grid; gap: 6px; margin-top: 12px; }
.mode-stepup[hidden] { display: none; }
.mode-stepup p { margin: 0 0 2px; color: var(--fg-2); font-size: 12px; }
.mode-stepup label { color: var(--fg-2); font-size: 11.5px; font-weight: 600; }
.mode-stepup .in { width: 100%; }
.mode-impact { min-height: 18px; margin: 10px 0 0; color: var(--fg-2); font-size: 11.5px; line-height: 1.45; }
.mode-status { min-height: 18px; color: var(--bad); font-size: 12px; }
@media (max-width: 760px) {
  /* Keep phone-sized modals above compact navigation. */
  .overlay { z-index: 100; padding: 12px; }
  .modal { width: calc(100vw - 24px); min-width: 0; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow: hidden; }
}
/* Navigation switcher. */
#qmjump { place-items: start center; padding-top: 12vh; }
.modal.jump { max-width: 480px; overflow: hidden; }
.jump-in { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.jump-in svg { width: 15px; height: 15px; stroke: var(--faint); flex: none; }
.jump-in input { flex: 1; min-width: 0; border: 0; background: none; color: var(--fg); font: inherit; font-size: 13.5px; outline: none; }
.jump-in input::placeholder { color: var(--faint); }
.jump-list { max-height: 336px; overflow-y: auto; padding: 6px; }
.jump-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer; }
.jump-row:hover { background: var(--lift); }
.jump-row.on { background: var(--accent-soft); }
.jump-row .jdot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
.jump-row .jdot.ok { background: var(--ok); }
.jump-row .jdot.warn { background: var(--warn-mark); }
.jump-row .jdot.none { background: transparent; border: 1px solid var(--faint); }
.jump-row .jname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.jump-note { padding: 14px 12px; color: var(--faint); font-size: 12.5px; text-align: center; }
.jump-foot { padding: 8px 16px; border-top: 1px solid var(--border); color: var(--faint); font-size: 10.5px; }

.seg { display: inline-flex; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.seg button { padding: 5px 12px; border: 0; background: none; color: var(--fg-2); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
.seg button.on { background: var(--accent-soft); color: var(--accent-2); font-weight: 600; }
.editor { background: #16191F; color: #C6CCD8; font-family: var(--console); font-size: 12px; line-height: 1.65; border: 1px solid #2A303C; border-radius: var(--radius-sm); overflow: hidden; }
.editor textarea { display: block; width: 100%; min-height: 300px; background: none; border: 0; color: inherit; font: inherit; padding: 12px 14px; resize: vertical; outline: none; }
/* Line-numbered editor. */
.editor.lined { display: flex; align-items: stretch; }
.editor.lined .gutter { flex: none; width: 42px; padding: 12px 8px 12px 0; text-align: right; color: #5E6673; background: #16191F; border-right: 1px solid #2A303C; overflow: hidden; white-space: pre; -webkit-user-select: none; user-select: none; }
.editor.lined textarea { flex: 1; min-width: 0; min-height: 340px; padding-left: 12px; resize: none; overflow: auto; }
.fieldrow { display: flex; gap: 8px; align-items: center; }
.in { height: 32px; padding: 0 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--panel); color: var(--fg); font: inherit; font-size: 12.5px; }
.in::placeholder { color: var(--faint); }
.in:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
/* Operation results. */
.runlog { display: flex; flex-direction: column; gap: 5px; min-width: 0; max-height: 30vh; overflow: auto; }
.runstep { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
.runstep .state { min-width: 0; }
.runstep .note { font-size: 12px; color: var(--fg-2); overflow-wrap: anywhere; }
.runstep.bad .note { color: var(--bad); }
/* Compose findings are clickable rows with severity, stable id, and message. */
.lintpanel { margin-top: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); overflow: hidden; }
.lintpanel[hidden] { display: none; }
.lint-note { padding: 7px 12px; border-bottom: 1px solid var(--border); color: var(--bad); font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.lint-note[hidden] { display: none; }
.lint-list { max-height: 168px; overflow-y: auto; }
.lint-row { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 12px; border: 0; border-bottom: 1px solid var(--border); background: none; color: var(--fg); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.lint-row:last-child { border-bottom: 0; }
.lint-row:hover { background: var(--lift); }
.lint-row .ldot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; align-self: center; }
.lint-row .ldot.error { background: var(--bad); }
.lint-row .ldot.warn { background: var(--warn-mark); }
.lint-row .ldot.info { background: var(--faint); }
.lint-id { flex: none; font-family: var(--mono); font-size: 10.5px; font-weight: 600; color: var(--fg-2); background: var(--lift); border-radius: 4px; padding: 1px 5px; }
.lint-msg { min-width: 0; color: var(--fg-2); overflow-wrap: anywhere; }

/* Underline network attachment counts only on hover. */
.who { cursor: help; }
.who:hover { text-decoration: underline dotted; text-underline-offset: 3px; }

/* Scheduled jobs table. */
.crontable { min-width: 960px; }
.chevbtn { width: 24px; height: 24px; display: grid; place-items: center; border: 0; background: none; color: var(--faint); cursor: pointer; border-radius: 6px; }
.chevbtn svg { width: 13px; height: 13px; stroke: currentColor; transition: transform 150ms ease-out; }
.chevbtn:hover { background: var(--lift); color: var(--fg); }
.chevbtn.open svg { transform: rotate(90deg); }
.jobdoes { font-size: 11.5px; color: var(--fg-2); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.runms { font-size: 11px; color: var(--faint); display: block; margin-left: 14px; }
.cron-x { border-bottom: 1px solid var(--border); background: var(--bg); padding: 10px 20px 14px 64px; }
.cron-x .xrow { display: grid; grid-template-columns: 180px 80px 70px 1fr; gap: 14px; padding: 3px 0; font-size: 12.5px; align-items: baseline; }
.cron-x .xrow.xh { font-size: 11.5px; font-weight: 600; color: var(--fg-2); padding-bottom: 5px; }
.acts form { display: contents; }

`;

export const feedback = `/* ---------- confirm + operation feed ---------- */
/* Destructive writes use the application dialog; longer operations report progress by step. */

/* Confirmation dialogs use the shared modal structure at a narrower width. */
.modal.confirm { max-width: 420px; }
.confirm-what { font-size: 13.5px; color: var(--fg); margin: 0; }
.confirm-detail { font-size: 12.5px; color: var(--fg-2); line-height: 1.5; margin: 7px 0 0; }
.confirm-detail code { font-size: 12px; color: var(--fg); }
/* Typed-name confirmation. */
.confirm-typed { width: 100%; margin-top: 12px; font-family: var(--mono); font-size: 12px; }
/* Destructive action. */
.btn.danger { background: var(--bad); border-color: transparent; color: #FFF; font-weight: 600; }
.btn.danger:hover { background: color-mix(in srgb, var(--bad) 85%, var(--fg)); }

/* Operation rows render consistently in dialogs and toasts. */
.oplist { display: flex; flex-direction: column; gap: 0; min-width: 0; }
.op { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 9px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; min-width: 0; }
.op:last-child { border-bottom: 0; }
/* Operation status marker. */
.op .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; margin: 5px; }
.op .dot.pending { opacity: .5; }
.op .dot.active { background: var(--accent); opacity: 1; }
.op .dot.ok { background: var(--ok); opacity: 1; }
.op .dot.fail { background: var(--bad); opacity: 1; }
.op-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.op.pending .op-label { color: var(--fg-2); }
/* Operation detail. */
.op-note { flex: none; margin-left: auto; font-size: 11.5px; color: var(--fg-2); font-variant-numeric: tabular-nums; }
.op.fail .op-note { color: var(--bad); }
/* Active operation animation. */
@media (prefers-reduced-motion: no-preference) { .op.active .dot { animation: livedot 2s ease-in-out infinite; } }
/* Operation output. */
.op-out { background: #16191F; color: #C6CCD8; border: 1px solid #2A303C; border-radius: var(--radius-sm); font-family: var(--console); font-size: 11.5px; line-height: 1.6; padding: 9px 11px; max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.light .op-out { border-color: #16191F; }
.op-out[hidden] { display: none; }
/* Optional progress bar. */
.opbar { height: 3px; border-radius: 2px; background: var(--lift); overflow: hidden; }
.light .opbar { background: var(--border); }
.opbar i { display: block; height: 100%; width: 100%; border-radius: 2px; background: var(--accent); transform: scaleX(0); transform-origin: left; transition: transform 200ms ease-out; }
/* Full-width operation details. */
.op > .op-out, .op > .opbar { flex-basis: 100%; margin: 8px 0 2px 27px; }

/* Background operation toast. */
.toast { position: fixed; right: 20px; bottom: 20px; width: 320px; z-index: 45; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 16px 40px rgb(0 0 0 / .38); overflow: hidden; }
.light .toast { box-shadow: 0 1px 3px rgb(20 24 33 / .08), 0 12px 32px rgb(20 24 33 / .12); }
.toast[hidden] { display: none; }
.toast-h { display: flex; align-items: center; gap: 10px; padding: 10px 12px 10px 14px; border-bottom: 1px solid var(--border); }
.toast-h b { font-size: 12.5px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast-h .iconbtn { margin-left: auto; flex: none; width: 26px; height: 26px; }
.toast-h .iconbtn svg { width: 14px; height: 14px; }
.toast-b { padding: 2px 14px 9px; max-height: 46vh; overflow-y: auto; }
@media (max-width: 620px) { .toast { left: 12px; right: 12px; bottom: 12px; width: auto; } }

/* Fold table-row details into the shared xrow layout. */
.rowx { background: var(--lift); border-bottom: 1px solid var(--border); padding: 10px 16px 12px; }
/* Preserve the table's rounded edge. */
.table > .rowx:last-child { border-bottom: 0; }
.rowx .xrow { display: grid; gap: 14px; padding: 3px 0; font-size: 12.5px; align-items: baseline; }
.rowx .xrow > div { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rowx .xrow.xh { font-size: 11.5px; font-weight: 600; color: var(--fg-2); padding-bottom: 5px; }
/* Image tag details. */
.rowx.x-tags .xrow { grid-template-columns: minmax(0, 1.4fr) 150px 84px 110px 120px 96px; }
/* Network attachments. */
.rowx.x-nets .xrow { grid-template-columns: 1fr; }
.netcount { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }

`;
