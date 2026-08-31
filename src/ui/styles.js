// Concatenated application stylesheet.

import { tokens } from './styles/tokens.js';
import { fonts, base } from './styles/base.js';
import { chrome, responsive } from './styles/chrome.js';
import { tables } from './styles/tables.js';
import { grid } from './styles/grid.js';
import { controls, consoles, feedback } from './styles/components.js';
import { detail, dashboard, stacks, settings, auth, pairing } from './styles/pages.js';
import { pairOffline } from './styles/pair-offline.js';

export const styles = fonts + tokens + base + chrome + controls + tables + grid + detail + dashboard
  + stacks + consoles + settings + auth + pairing + pairOffline + feedback + responsive;
