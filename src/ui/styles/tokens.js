// Shared colour and spacing tokens.

export const tokens = `:root {
  --bg: #14171D;
  --panel: #1B1F27;
  --lift: #20252F;
  --border: #2A303C;
  --fg: #E8EAF0;
  --fg-2: #99A2B1;
  --faint: #78818F;
  --accent: #5B78F0;
  --accent-2: #7B93F4;
  --accent-soft: rgba(91, 120, 240, .13);
  --ok: #41B663;
  --ok-soft: rgba(65, 182, 99, .14);
  --warn: #E0A23E;
  --warn-soft: rgba(224, 162, 62, .14);
  /* Marker colour for small status indicators. */
  --warn-mark: #E0A23E;
  --bad: #E25A50;
  --bad-soft: rgba(226, 90, 80, .14);
  --teal: #33B3A2;
  --brass: #C29A5B;
  /* Port and stack identity colours. */
  --port-bg: rgba(124, 148, 196, .13);
  --port-ink: #97A9CE;
  --sh0-bg: #7556A6; --sh0-ink: #FFF;
  --sh1-bg: #9A4766; --sh1-ink: #FFF;
  --sh2-bg: #287783; --sh2-ink: #FFF;
  --sh3-bg: #64743C; --sh3-ink: #FFF;
  --sh4-bg: #42588F; --sh4-ink: #FFF;
  --sh5-bg: #8F5938; --sh5-ink: #FFF;
  --shadow: none;
  --radius: 10px;
  --radius-sm: 7px;
  /* UI values and console output use separate font stacks. */
  --mono: "Martian Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --console: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: dark;
}
.light {
  --bg: #F4F5F7;
  --panel: #FFFFFF;
  --lift: #F6F7F9;
  --border: #E3E6EC;
  --fg: #1B202A;
  --fg-2: #5B6473;
  --faint: #767E8A;
  --accent: #4A66E8;
  --accent-2: #3A52C8;
  --accent-soft: rgba(74, 102, 232, .1);
  --ok: #1F9D4D;
  --ok-soft: rgba(31, 157, 77, .12);
  --warn: #8F6110;
  --warn-soft: rgba(143, 97, 16, .12);
  --warn-mark: #C98A1E;
  --bad: #C93F36;
  --bad-soft: rgba(201, 63, 54, .1);
  --teal: #178F80;
  --brass: #A07C3F;
  /* Keep stack identity colours consistent across themes. */
  --port-bg: rgba(74, 92, 134, .09);
  --port-ink: #48597F;
  --sh0-bg: #7556A6; --sh0-ink: #FFF;
  --sh1-bg: #9A4766; --sh1-ink: #FFF;
  --sh2-bg: #287783; --sh2-ink: #FFF;
  --sh3-bg: #64743C; --sh3-ink: #FFF;
  --sh4-bg: #42588F; --sh4-ink: #FFF;
  --sh5-bg: #8F5938; --sh5-ink: #FFF;
  --shadow: 0 1px 2px rgb(20 24 33 / .05), 0 1px 3px rgb(20 24 33 / .06);
  color-scheme: light;
}

`;
