/**
 * settings.js — single source of truth for all user-configurable options.
 *
 * Settings live in chrome.storage.local under one key ("settings") as a
 * flat-ish object. Consumers call `getSettings()` for the current cached
 * copy, `updateSettings(patch)` to merge + persist + notify, and
 * `onSettingsChange(fn)` to subscribe to updates (used by the graph, theme
 * applier, and settings panel to stay in sync without tight coupling).
 */

export const DEFAULT_SETTINGS = {
  // Appearance
  theme: { preset: 'midnight', custom: null },
  reduceMotion: false,
  showLabels: true,
  labelDensity: 'normal', // 'compact' | 'normal' | 'roomy'

  // Graph
  graphMode: '3d', // '3d' | '2d'
  physics: {
    repel: 26000,
    springLength: 130,
    damping: 0.86,
    gravity: 0.0022
  },
  maxVisibleNodes: 0, // 0 = unlimited

  // Sound
  soundEnabled: true,
  soundVolume: 0.8,

  // Data safety
  autoBackupEnabled: true,
  autoBackupKeep: 10,
  exportReminderDays: 14,
  lastExportAt: 0,

  // Visibility (per-mode sets of hidden node ids, stored separately in storage.js,
  // but the toggle for "respect hidden nodes" lives here)
  hiddenEnabled: true
};

let cache = null;
const listeners = new Set();

function deepMerge(base, patch) {
  const out = { ...base };
  for (const k in patch) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], patch[k]);
    } else {
      out[k] = patch[k];
    }
  }
  return out;
}

export async function loadSettings() {
  const res = await chrome.storage.local.get(['settings']);
  cache = deepMerge(DEFAULT_SETTINGS, res.settings || {});
  return cache;
}

export function getSettings() {
  return cache || DEFAULT_SETTINGS;
}

export async function updateSettings(patch) {
  cache = deepMerge(cache || DEFAULT_SETTINGS, patch);
  await chrome.storage.local.set({ settings: cache });
  for (const fn of listeners) fn(cache);
  return cache;
}

export async function resetSettings() {
  cache = { ...DEFAULT_SETTINGS };
  await chrome.storage.local.set({ settings: cache });
  for (const fn of listeners) fn(cache);
  return cache;
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Keep tabs in sync: if settings change in another tab/the options page,
// pick it up here too.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  cache = deepMerge(DEFAULT_SETTINGS, changes.settings.newValue || {});
  for (const fn of listeners) fn(cache);
});
