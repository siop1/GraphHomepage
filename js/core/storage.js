/**
 * storage.js — all chrome.storage.local access for user data:
 *   - the favorites tree (flat array mirroring chrome.bookmarks' shape)
 *   - hidden-node sets (per mode: favorites / bookmarks)
 *   - versioned auto-backups + manual export/import of the favorites tree
 *
 * Data safety is the point of this module: every mutating write to the
 * favorites tree also pushes a timestamped snapshot into a small rolling
 * backup ring (kept to `settings.autoBackupKeep` entries), so a bad write,
 * a botched import, or an accidental cascade-delete can be undone even
 * without an explicit manual export.
 */

import { getSettings } from './settings.js';

const FAV_KEY = 'favoriteTree';
const BACKUPS_KEY = 'favoriteBackups'; // array of { ts, tree }
const HIDDEN_KEY = 'hiddenNodes';      // { favorites: string[], bookmarks: string[] }
const EXPANDED_KEY = 'expandedNodes';  // { favorites: string[], bookmarks: string[] } — folders unfolded in place in Explore view

/* ---------------- favorites tree CRUD ---------------- */

export async function getFavTree() {
  const res = await chrome.storage.local.get([FAV_KEY, 'favoriteLinks']);
  if (res[FAV_KEY]) return res[FAV_KEY];
  // one-time migration from the old flat favoriteLinks list (v1 compatibility)
  const old = res.favoriteLinks || [];
  const migrated = old.map(f => ({ id: f.id, title: f.title, url: f.url, type: 'link', parentId: 'root' }));
  await chrome.storage.local.set({ [FAV_KEY]: migrated });
  return migrated;
}

async function saveFavTree(list, { backup = true } = {}) {
  await chrome.storage.local.set({ [FAV_KEY]: list });
  if (backup) await pushBackup(list);
}

export async function addFavNode({ title, url, type, parentId }) {
  const tree = await getFavTree();
  const node = { id: 'fav_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), title, type, parentId };
  if (type === 'link') node.url = url;
  tree.push(node);
  await saveFavTree(tree);
  return node;
}

export async function updateFavNode(id, updates) {
  const tree = await getFavTree();
  const idx = tree.findIndex(n => n.id === id);
  if (idx >= 0) tree[idx] = { ...tree[idx], ...updates };
  await saveFavTree(tree);
}

export async function deleteFavNode(id) {
  const tree = await getFavTree();
  const toRemove = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of tree) {
      if (toRemove.has(n.parentId) && !toRemove.has(n.id)) { toRemove.add(n.id); changed = true; }
    }
  }
  await saveFavTree(tree.filter(n => !toRemove.has(n.id)));
}

export async function getFavSubtreeInfo(id) {
  const tree = await getFavTree();
  const idSet = new Set([id]);
  let linkCount = 0, folderCount = 0;
  (function walk(parentId) {
    for (const c of tree.filter(n => n.parentId === parentId)) {
      idSet.add(c.id);
      if (c.type === 'folder') { folderCount++; walk(c.id); }
      else linkCount++;
    }
  })(id);
  return { idSet, linkCount, folderCount };
}

/* ---------------- hidden nodes (show/hide parts of the graph) ---------------- */

export async function getHiddenSets() {
  const res = await chrome.storage.local.get([HIDDEN_KEY]);
  return { favorites: [], bookmarks: [], ...(res[HIDDEN_KEY] || {}) };
}

export async function setHidden(modeKey, idsArray) {
  const sets = await getHiddenSets();
  sets[modeKey] = idsArray;
  await chrome.storage.local.set({ [HIDDEN_KEY]: sets });
  return sets;
}

export async function toggleHidden(modeKey, id) {
  const sets = await getHiddenSets();
  const set = new Set(sets[modeKey]);
  if (set.has(id)) set.delete(id); else set.add(id);
  sets[modeKey] = [...set];
  await chrome.storage.local.set({ [HIDDEN_KEY]: sets });
  return sets;
}

export async function clearHidden(modeKey) {
  return setHidden(modeKey, []);
}

/* ---------------- expanded nodes (Explore-view unfold/collapse in place) ---------------- */

export async function getExpandedSets() {
  const res = await chrome.storage.local.get([EXPANDED_KEY]);
  return { favorites: [], bookmarks: [], ...(res[EXPANDED_KEY] || {}) };
}

export async function setExpanded(modeKey, idsArray) {
  const sets = await getExpandedSets();
  sets[modeKey] = idsArray;
  await chrome.storage.local.set({ [EXPANDED_KEY]: sets });
  return sets;
}

export async function toggleExpanded(modeKey, id) {
  const sets = await getExpandedSets();
  const set = new Set(sets[modeKey]);
  if (set.has(id)) set.delete(id); else set.add(id);
  sets[modeKey] = [...set];
  await chrome.storage.local.set({ [EXPANDED_KEY]: sets });
  return sets;
}

/** Collapses a node and everything nested under it (used when a folder is deleted/hidden so stale ids don't linger in storage). */
export async function collapseSubtree(modeKey, idsToRemove) {
  const sets = await getExpandedSets();
  const remove = new Set(idsToRemove);
  sets[modeKey] = sets[modeKey].filter(id => !remove.has(id));
  await chrome.storage.local.set({ [EXPANDED_KEY]: sets });
  return sets;
}

/* ---------------- versioned auto-backups ---------------- */

export async function pushBackup(tree) {
  const settings = getSettings();
  if (!settings.autoBackupEnabled) return;
  const res = await chrome.storage.local.get([BACKUPS_KEY]);
  const backups = res[BACKUPS_KEY] || [];
  backups.push({ ts: Date.now(), tree: JSON.parse(JSON.stringify(tree)) });
  const keep = Math.max(1, settings.autoBackupKeep || 10);
  while (backups.length > keep) backups.shift();
  await chrome.storage.local.set({ [BACKUPS_KEY]: backups });
}

export async function listBackups() {
  const res = await chrome.storage.local.get([BACKUPS_KEY]);
  return (res[BACKUPS_KEY] || []).slice().reverse(); // most recent first
}

export async function restoreBackup(ts) {
  const backups = await listBackups();
  const found = backups.find(b => b.ts === ts);
  if (!found) throw new Error('Backup not found');
  await saveFavTree(JSON.parse(JSON.stringify(found.tree)), { backup: true });
  return found.tree;
}

/* ---------------- manual export / import ---------------- */

export async function buildExportPayload() {
  const [tree, hidden, settingsRes] = await Promise.all([
    getFavTree(),
    getHiddenSets(),
    chrome.storage.local.get(['settings'])
  ]);
  return {
    exportedAt: new Date().toISOString(),
    version: 2,
    favoriteTree: tree,
    hiddenNodes: hidden,
    settings: settingsRes.settings || null
  };
}

export async function exportToFile() {
  const payload = await buildExportPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `graphhome-backup-${stamp}.json`;

  // Use chrome.downloads (the permission the manifest already declares) so
  // the file lands in the user's actual Downloads folder with the browser's
  // normal download-complete affordances, instead of the old anchor-click
  // trick, which worked but never used the declared `downloads` permission.
  if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
    await new Promise((resolve) => {
      chrome.downloads.download({ url, filename, saveAs: false }, () => {
        // Give the browser time to read the blob before we free it.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        resolve();
      });
    });
  } else {
    // Fallback (e.g. running this module outside the extension context).
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const { updateSettings } = await import('./settings.js');
  await updateSettings({ lastExportAt: Date.now() });
}

/**
 * Imports a JSON payload (from exportToFile, or a hand-edited/older file).
 * mode: 'replace' overwrites the current favorites tree entirely;
 *       'merge' appends imported nodes with fresh ids, remapping parents,
 *       dropped into 'root' if their original parent isn't found.
 */
export async function importFromPayload(payload, { mode = 'merge' } = {}) {
  if (!payload || !Array.isArray(payload.favoriteTree)) {
    throw new Error('Invalid backup file: missing favoriteTree array.');
  }
  const incoming = payload.favoriteTree;

  if (mode === 'replace') {
    await saveFavTree(JSON.parse(JSON.stringify(incoming)));
  } else {
    const current = await getFavTree();
    const idMap = new Map();
    const remapped = incoming.map(n => {
      const newId = 'fav_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      idMap.set(n.id, newId);
      return { ...n, _oldId: n.id, _oldParent: n.parentId, id: newId };
    });
    for (const n of remapped) {
      n.parentId = n._oldParent === 'root' ? 'root' : (idMap.get(n._oldParent) || 'root');
      delete n._oldId; delete n._oldParent;
    }
    await saveFavTree([...current, ...remapped]);
  }

  if (payload.hiddenNodes) {
    await chrome.storage.local.set({ [HIDDEN_KEY]: payload.hiddenNodes });
  }
  return true;
}

/** True if it's been longer than settings.exportReminderDays since the last export. */
export function isExportReminderDue(settings) {
  if (!settings.exportReminderDays) return false;
  if (!settings.lastExportAt) return true;
  const days = (Date.now() - settings.lastExportAt) / 86400000;
  return days >= settings.exportReminderDays;
}
