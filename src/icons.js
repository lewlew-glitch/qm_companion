// Load bundled dashboard-icons assets into memory at boot.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const assets = join(dirname(fileURLToPath(import.meta.url)), 'assets');
const icons = new Map();
try {
  for (const f of readdirSync(join(assets, 'icons'))) {
    if (f.endsWith('.svg')) icons.set(f.slice(0, -4), readFileSync(join(assets, 'icons', f), 'utf8'));
  }
} catch {
  // Missing icons fall back to a generated initial.
}

// App icon for the sidebar, login page, and favicon.
let logo = null;
try {
  logo = readFileSync(join(assets, 'logo.png'));
} catch {
  // Pages omit a missing logo.
}

// Load bundled WOFF2 fonts into memory at boot.
const fonts = new Map();
try {
  for (const f of readdirSync(join(assets, 'fonts'))) {
    if (f.endsWith('.woff2')) fonts.set(f, readFileSync(join(assets, 'fonts', f)));
  }
} catch {
  // Use the system font stack when bundled fonts are absent.
}


export function getLogo() {
  return logo;
}

export function getFont(name) {
  if (!/^[a-z0-9-]+\.woff2$/.test(name)) return null;
  return fonts.get(name) || null;
}

export function hasIcon(kind) {
  return icons.has(kind);
}

export function getIcon(kind) {
  return icons.get(kind) || null;
}
