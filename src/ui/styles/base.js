// Fonts, reset, typography, and scrollbars.
export const fonts = `
@font-face {
  font-family: "Libre Franklin";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(/assets/fonts/sans.woff2) format("woff2");
}
@font-face {
  font-family: "Martian Mono";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(/assets/fonts/mono.woff2) format("woff2");
}
`;

export const base = `* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: "Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", system-ui, sans-serif;
  font-size: 13.5px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
/* Keep Martian Mono aligned with body text without increasing row height. */
.mono, code, pre, kbd, samp {
  font-family: var(--mono);
  font-size: .93em;
  font-variant-numeric: tabular-nums;
}
a { color: var(--accent); text-decoration: none; }
svg { display: block; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--faint); }

/* Labels. */
.lbl, .tr.th, .sec-h { font-size: 11.5px; font-weight: 600; color: var(--fg-2); }

`;
