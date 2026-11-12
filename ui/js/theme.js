// Hysh - themes and the Windows 11 window material. GPL-3.0-or-later
import { emit } from './store.js';
import { appWindow } from './api.js';

const LEGACY = { dark: 'graphite', oled: 'void' };
const LIGHT = new Set(['paper']);
/** Themes added by plugins: { id, name, note, bg, fg, ac, light } */
export const pluginThemes = [];

/** Applies a skin by name ("graphite" is the base stylesheet, so it needs no attribute). */
export function applyTheme(name) {
  const theme = LEGACY[name] || name || 'graphite';
  if (theme === 'graphite') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const light = LIGHT.has(theme) || pluginThemes.some((t) => t.id === theme && t.light);
  // the native frame and Mica follow the skin's brightness
  appWindow().setTheme(light ? 'light' : 'dark').catch(() => {});
  emit('theme', theme);
}

const EFFECT = { mica: 'mica', 'mica-alt': 'tabbed', acrylic: 'acrylic' };
let windowIsTransparent = false;

/** Called once at start-up with the material the window was created with. */
export function initMaterial(startupMaterial) {
  windowIsTransparent = !!EFFECT[startupMaterial];
  document.documentElement.classList.toggle('material', windowIsTransparent);
}

/** Switches material live when the window supports it; returns false when a restart is needed. */
export async function setMaterial(name) {
  if (!windowIsTransparent) return !EFFECT[name];
  const effect = EFFECT[name];
  await appWindow().setEffects({ effects: effect ? [effect] : [] }).catch(() => {});
  document.documentElement.classList.toggle('material', !!effect);
  return true;
}
