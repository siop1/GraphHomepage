/**
 * main.js — New Tab page orchestrator. Wires together the graph engine
 * (2D or 3D), favorites/bookmarks state, search, the settings panel, and
 * all the modal/context-menu interactions. Kept as a single file (like the
 * original project) since the app has one shared, tightly-coupled UI
 * state; deeper logic lives in the core/ and graph/ modules.
 */
import { Graph3D } from './graph/graph3d.js';
import { Graph2D } from './graph/graph2d.js';
import { sound } from './core/sound.js';
import { loadSettings, getSettings, updateSettings, onSettingsChange } from './core/settings.js';
import { applyThemeVars, resolveThemeVars, resolveGraphColors } from './core/themes.js';
import { searchNodes } from './core/search.js';
import { showToast } from './ui/toast.js';
import { mountSettingsPanel } from './ui/panel.js';
import {
  getFavTree, addFavNode, updateFavNode, deleteFavNode, getFavSubtreeInfo,
  getHiddenSets, toggleHidden, isExportReminderDue,
  getExpandedSets, toggleExpanded, collapseSubtree
} from './core/storage.js';

/* ---------- boot: settings + theme before first render ---------- */
let settings = await loadSettings();
applyThemeVars(resolveThemeVars(settings.theme));
document.documentElement.dataset.labelDensity = settings.labelDensity;

/* ---------- graph engine (swappable 2D/3D) ---------- */
const sceneContainer = document.getElementById('sceneContainer');
let graph = createGraph();

function createGraph() {
  const opts = { physics: settings.physics, reduceMotion: settings.reduceMotion, showLabels: settings.showLabels };
  const g = settings.graphMode === '2d' ? new Graph2D(sceneContainer, opts) : new Graph3D(sceneContainer, opts);
  g.setColors(resolveGraphColors(resolveThemeVars(settings.theme)));
  wireGraphCallbacks(g);
  return g;
}

function wireGraphCallbacks(g) {
  g.onNodeActivate = onNodeActivate;
  g.onNodeHover = () => sound.hover();
  g.onNodeEdit = onNodeEdit;
  g.onNodeContext = onNodeContext;
}

function switchGraphEngine() {
  graph.destroy();
  graph = createGraph();
  render();
}

/* ---------- DOM refs ---------- */
const crumbBar = document.getElementById('crumbBar');
const emptyState = document.getElementById('emptyState');
const emptyTitle = document.getElementById('emptyTitle');
const emptySub = document.getElementById('emptySub');
const addFavBtn = document.getElementById('addFavBtn');
const ctxMenu = document.getElementById('nodeContextMenu');
const ctxOpenBtn = document.getElementById('ctxOpenBtn');
const ctxAddLinkBtn = document.getElementById('ctxAddLinkBtn');
const ctxAddFolderBtn = document.getElementById('ctxAddFolderBtn');
const ctxEditBtn = document.getElementById('ctxEditBtn');
const ctxHideBtn = document.getElementById('ctxHideBtn');
const ctxDeleteBtn = document.getElementById('ctxDeleteBtn');
const bookmarkModalOverlay = document.getElementById('bookmarkModalOverlay');
const bookmarkModalTitle = document.getElementById('bookmarkModalTitle');
const bmTitleInput = document.getElementById('bmTitleInput');
const bmUrlField = document.getElementById('bmUrlField');
const bmUrlInput = document.getElementById('bmUrlInput');
const deleteConfirmBar = document.getElementById('deleteConfirmBar');
const deleteConfirmText = document.getElementById('deleteConfirmText');

/* ---------- app state ---------- */
let mode = 'favorites';
let bookmarksView = 'drill';
let favoritesView = 'drill';
let bookmarkStack = [{ id: '0', title: 'Bookmarks' }];
let favoriteStack = [{ id: 'root', title: 'Favorites' }];
let editingFavNode = null;
let addFavParentId = 'root';
let addFavType = 'link';
let bookmarkParentMap = {};
let favParentMap = {};
let ctxTargetNode = null;
let editingBookmarkNode = null;
let pendingDelete = null;
let hiddenSets = { favorites: [], bookmarks: [] };
let expandedSets = { favorites: [], bookmarks: [] };
// Tracks which "context" (mode + view + current folder) was last rendered so
// we only recenter the camera on real navigation, not on soft refreshes like
// expand/collapse, hide/show, or add/edit/delete — those should feel like an
// in-place update, not a jump back to a reset viewport.
let lastRenderKey = null;
let keepCameraForThisRender = false;

/* ---------- rendering helpers ---------- */
function setEmpty(show, title, sub) {
  emptyState.classList.toggle('hidden', !show);
  sceneContainer.classList.toggle('hidden', show);
  if (show) { emptyTitle.textContent = title; emptySub.textContent = sub; }
}

/**
 * Pushes new nodes/edges into the graph engine and recenters the camera
 * ONLY when this render represents real navigation (a different mode/view/
 * folder than what was last shown — see lastRenderKey in renderFavorites/
 * renderBookmarks). Soft refreshes (expand/collapse, hide/show, add/edit/
 * delete without moving) leave the camera exactly where the user left it.
 */
function applyGraphData(nodes, edges) {
  graph.setData(nodes, edges);
  if (!keepCameraForThisRender) graph.resetCamera();
}

function applyVisibilityFilter(nodes, edges, hiddenIdSet) {
  if (!settings.hiddenEnabled || hiddenIdSet.size === 0) return applyMaxVisible(nodes, edges);
  const kept = nodes.filter(n => n.isHub || !hiddenIdSet.has(n.id));
  const keptIds = new Set(kept.map(n => n.id));
  const keptEdges = edges.filter(e => keptIds.has(e.a) && keptIds.has(e.b));
  return applyMaxVisible(kept, keptEdges);
}

function applyMaxVisible(nodes, edges) {
  const cap = settings.maxVisibleNodes;
  if (!cap || nodes.length <= cap + 1) return { nodes, edges, truncated: 0 };
  const hub = nodes.find(n => n.isHub);
  const rest = nodes.filter(n => !n.isHub).slice(0, cap);
  const keepIds = new Set(rest.map(n => n.id));
  const finalNodes = hub ? [hub, ...rest] : rest;
  const finalEdges = edges.filter(e => keepIds.has(e.a) && keepIds.has(e.b) || e.a === 'hub' && keepIds.has(e.b));
  return { nodes: finalNodes, edges: finalEdges, truncated: nodes.length - finalNodes.length };
}

async function renderFavorites() {
  addFavBtn.classList.remove('hidden');
  hiddenSets = await getHiddenSets();
  expandedSets = await getExpandedSets();
  const key = `favorites:${favoritesView}:${favoriteStack[favoriteStack.length - 1].id}`;
  keepCameraForThisRender = key === lastRenderKey;
  lastRenderKey = key;
  if (favoritesView === 'full') {
    crumbBar.innerHTML = '';
    await renderFavoritesFull();
  } else {
    await renderFavoritesDrill();
  }
}

async function renderFavoritesDrill() {
  const current = favoriteStack[favoriteStack.length - 1];
  renderCrumbs();

  const tree = await getFavTree();
  const expanded = new Set(expandedSets.favorites);
  const { nodes: builtNodes, edges: builtEdges } = buildExpandableFavTree(tree, current.id, expanded);

  if (builtNodes.length === 0) {
    const atRoot = current.id === 'root';
    setEmpty(true, atRoot ? 'No favorites yet' : 'This folder is empty',
      atRoot ? 'Click the + button to add your first link or folder' : 'Go back, or use + to add something here');
    applyGraphData([], []);
    return;
  }

  const hub = { id: 'hub', label: current.title, isHub: true, r: 9 };
  let nodes = [hub, ...builtNodes];
  let edges = builtEdges;

  const filtered = applyVisibilityFilter(nodes, edges, new Set(hiddenSets.favorites));
  if (filtered.nodes.length <= 1) {
    setEmpty(true, 'Everything here is hidden', 'Open Settings → Visibility to show items again');
    applyGraphData([], []);
    return;
  }
  setEmpty(false);
  applyGraphData(filtered.nodes, filtered.edges);
  showTruncationNotice(filtered.truncated);
}

/**
 * Builds nodes/edges for the Explore (drill) view starting at `rootId`.
 * Immediate children of `rootId` are always included. Any folder whose id
 * is in `expandedSet` also has ITS children pulled in (recursively — a
 * grandchild folder that's also expanded keeps unfolding), so a click on a
 * folder can reveal its contents in place without navigating away. Also
 * merges discovered parent relationships into `favParentMap` so features
 * like search-jump and "Open folder" work even for nodes only ever seen
 * via in-place expansion (never visited through Whole Picture).
 */
function buildExpandableFavTree(tree, rootId, expandedSet) {
  const nodes = [];
  const edges = [];

  function addChildrenOf(parentRealId, edgeParentId) {
    for (const item of tree.filter(n => n.parentId === parentRealId)) {
      favParentMap[item.id] = { parentId: parentRealId, title: item.title || '(untitled)' };
      const isFolder = item.type === 'folder';
      const isExpanded = isFolder && expandedSet.has(item.id);
      nodes.push({
        id: item.id,
        label: item.title || '(untitled)',
        url: item.url,
        type: isFolder ? 'folder' : 'favorite',
        r: isFolder ? 15 : 12,
        isExpandable: isFolder,
        isExpanded
      });
      edges.push({ a: edgeParentId, b: item.id });
      if (isExpanded) addChildrenOf(item.id, item.id);
    }
  }

  addChildrenOf(rootId, 'hub');
  return { nodes, edges };
}

async function renderFavoritesFull() {
  const tree = await getFavTree();
  favParentMap = {};
  const nodes = [{ id: 'hub', label: 'All favorites', isHub: true, r: 9 }];
  const edges = [];

  function walk(parentId) {
    for (const item of tree.filter(n => n.parentId === parentId)) {
      favParentMap[item.id] = { parentId, title: item.title || '(untitled)' };
      nodes.push({
        id: item.id,
        label: item.title || '(untitled)',
        url: item.url,
        type: item.type === 'folder' ? 'folder' : 'favorite',
        r: item.type === 'folder' ? 14 : 9
      });
      edges.push({ a: parentId === 'root' ? 'hub' : parentId, b: item.id });
      if (item.type === 'folder') walk(item.id);
    }
  }
  walk('root');

  if (nodes.length === 1) {
    setEmpty(true, 'No favorites yet', 'Click the + button to add your first link or folder');
    applyGraphData([], []);
    return;
  }
  const filtered = applyVisibilityFilter(nodes, edges, new Set(hiddenSets.favorites));
  if (filtered.nodes.length <= 1) {
    setEmpty(true, 'Everything here is hidden', 'Open Settings → Visibility to show items again');
    applyGraphData([], []);
    return;
  }
  setEmpty(false);
  applyGraphData(filtered.nodes, filtered.edges);
  showTruncationNotice(filtered.truncated);
}

function favPathTo(id) {
  const chain = [];
  let cur = id;
  while (cur && cur !== 'root' && favParentMap[cur]) {
    chain.unshift({ id: cur, title: favParentMap[cur].title });
    cur = favParentMap[cur].parentId;
  }
  chain.unshift({ id: 'root', title: 'Favorites' });
  return chain;
}

async function renderBookmarks() {
  addFavBtn.classList.add('hidden');
  hiddenSets = await getHiddenSets();
  expandedSets = await getExpandedSets();
  const key = `bookmarks:${bookmarksView}:${bookmarkStack[bookmarkStack.length - 1].id}`;
  keepCameraForThisRender = key === lastRenderKey;
  lastRenderKey = key;
  if (bookmarksView === 'full') {
    crumbBar.innerHTML = '';
    await renderBookmarksFull();
  } else {
    await renderBookmarksDrill();
  }
}

async function renderBookmarksDrill() {
  const current = bookmarkStack[bookmarkStack.length - 1];
  renderCrumbs();

  const expanded = new Set(expandedSets.bookmarks);
  let built;
  try {
    built = await buildExpandableBookmarkTree(current.id, expanded);
  } catch (err) {
    setEmpty(true, 'Could not load bookmarks', 'Try reloading this page');
    applyGraphData([], []);
    return;
  }

  if (built.nodes.length === 0) {
    setEmpty(true, 'This folder is empty', 'Go back and pick another folder');
    applyGraphData([], []);
    return;
  }

  const hub = { id: 'hub', label: current.title, isHub: true, r: 9 };
  let nodes = [hub, ...built.nodes];
  let edges = built.edges;

  const filtered = applyVisibilityFilter(nodes, edges, new Set(hiddenSets.bookmarks));
  if (filtered.nodes.length <= 1) {
    setEmpty(true, 'Everything here is hidden', 'Open Settings → Visibility to show items again');
    applyGraphData([], []);
    return;
  }
  setEmpty(false);
  applyGraphData(filtered.nodes, filtered.edges);
  showTruncationNotice(filtered.truncated);
}

/**
 * Same idea as buildExpandableFavTree but sourced from the live
 * chrome.bookmarks tree (async per folder, so it's a recursive async walk
 * rather than a synchronous filter over an in-memory array). Also merges
 * discovered parent relationships into bookmarkParentMap so search-jump and
 * "Open folder" work for nodes only ever seen via in-place expansion.
 */
async function buildExpandableBookmarkTree(rootId, expandedSet) {
  const nodes = [];
  const edges = [];

  async function addChildrenOf(parentRealId, edgeParentId) {
    const children = await chrome.bookmarks.getChildren(parentRealId);
    for (const item of children) {
      bookmarkParentMap[item.id] = { parentId: parentRealId, title: item.title || '(untitled)' };
      const isFolder = !item.url;
      const isExpanded = isFolder && expandedSet.has(item.id);
      nodes.push({
        id: item.id,
        label: item.title || '(untitled)',
        url: item.url,
        bookmarkId: item.id,
        type: isFolder ? 'folder' : 'bookmark',
        r: isFolder ? 15 : 10,
        isExpandable: isFolder,
        isExpanded
      });
      edges.push({ a: edgeParentId, b: item.id });
      if (isExpanded) await addChildrenOf(item.id, item.id);
    }
  }

  await addChildrenOf(rootId, 'hub');
  return { nodes, edges };
}

async function renderBookmarksFull() {
  let tree;
  try {
    tree = await chrome.bookmarks.getTree();
  } catch (err) {
    setEmpty(true, 'Could not load bookmarks', 'Try reloading this page');
    applyGraphData([], []);
    return;
  }

  bookmarkParentMap = {};
  const nodes = [{ id: 'hub', label: 'All bookmarks', isHub: true, r: 9 }];
  const edges = [];

  function walk(items, parentId) {
    for (const item of items) {
      bookmarkParentMap[item.id] = { parentId, title: item.title || '(untitled)' };
      const isFolder = !item.url;
      nodes.push({
        id: item.id,
        label: item.title || '(untitled)',
        url: item.url,
        bookmarkId: item.id,
        type: isFolder ? 'folder' : 'bookmark',
        r: isFolder ? 14 : 9
      });
      edges.push({ a: parentId, b: item.id });
      if (item.children && item.children.length) walk(item.children, item.id);
    }
  }

  const topLevel = tree[0].children || [];
  walk(topLevel, 'hub');

  if (nodes.length === 1) {
    setEmpty(true, 'No bookmarks found', '');
    applyGraphData([], []);
    return;
  }
  const filtered = applyVisibilityFilter(nodes, edges, new Set(hiddenSets.bookmarks));
  if (filtered.nodes.length <= 1) {
    setEmpty(true, 'Everything here is hidden', 'Open Settings → Visibility to show items again');
    applyGraphData([], []);
    return;
  }
  setEmpty(false);
  applyGraphData(filtered.nodes, filtered.edges);
  showTruncationNotice(filtered.truncated);
}

function pathToNode(nodeId) {
  const chain = [];
  let cur = nodeId;
  while (cur && cur !== 'hub' && bookmarkParentMap[cur]) {
    chain.unshift({ id: cur, title: bookmarkParentMap[cur].title });
    cur = bookmarkParentMap[cur].parentId;
  }
  chain.unshift({ id: '0', title: 'Bookmarks' });
  return chain;
}

function renderCrumbs() {
  crumbBar.innerHTML = '';
  const stack = mode === 'bookmarks' ? bookmarkStack : favoriteStack;
  stack.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      crumbBar.appendChild(sep);
    }
    const el = document.createElement('span');
    el.textContent = crumb.title;
    const isCurrent = i === stack.length - 1;
    el.className = 'crumb' + (isCurrent ? ' current' : '');
    if (!isCurrent) {
      el.addEventListener('click', () => {
        sound.back();
        cancelPendingDelete();
        if (mode === 'bookmarks') {
          bookmarkStack = bookmarkStack.slice(0, i + 1);
          renderBookmarks();
        } else {
          favoriteStack = favoriteStack.slice(0, i + 1);
          renderFavorites();
        }
      });
    }
    crumbBar.appendChild(el);
  });
}

function cancelPendingDelete() {
  if (!pendingDelete) return;
  pendingDelete = null;
  deleteConfirmBar.classList.add('hidden');
  graph.clearHighlight();
}

let truncationDismiss = null;
function showTruncationNotice(count) {
  if (truncationDismiss) { truncationDismiss(); truncationDismiss = null; }
  if (!count) return;
  truncationDismiss = showToast(
    `${count} node${count === 1 ? '' : 's'} hidden by the "max visible nodes" setting.`,
    { type: 'warn', duration: 5000 }
  );
}

function render() {
  if (mode === 'favorites') renderFavorites();
  else renderBookmarks();
}

/* ---------- node interaction ---------- */
function onNodeActivate(n) {
  cancelPendingDelete();
  closeSearchResults();

  if (n.url) { sound.open(); window.open(n.url, '_blank'); return; }
  if (n.type !== 'folder') return;

  const view = mode === 'bookmarks' ? bookmarksView : favoritesView;

  if (view === 'full') {
    // Whole Picture already shows everything at once — clicking a folder
    // there jumps you into Explore at that folder (unchanged behavior).
    sound.enterFolder();
    if (mode === 'bookmarks') {
      bookmarkStack = pathToNode(n.bookmarkId);
      bookmarksView = 'drill';
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'drill'));
      renderBookmarks();
    } else {
      favoriteStack = favPathTo(n.id);
      favoritesView = 'drill';
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'drill'));
      renderFavorites();
    }
    return;
  }

  // Explore (drill) view: a left-click no longer navigates away — it
  // unfolds the folder in place, adding its children as nodes alongside
  // everything already on screen (multi-level: an already-expanded child
  // folder can itself be expanded again). Clicking an expanded folder
  // again collapses it. Use right-click → "Open folder" to actually
  // navigate into it (replace the view), same as the old click behavior.
  toggleNodeExpansion(n);
}

async function toggleNodeExpansion(n) {
  const id = mode === 'bookmarks' ? n.bookmarkId : n.id;
  const willExpand = !n.isExpanded;
  await toggleExpanded(mode, id);
  sound[willExpand ? 'enterFolder' : 'back']();
  if (mode === 'bookmarks') renderBookmarks();
  else renderFavorites();
}

/** Drill into a folder (replace the current view), the old default click behavior — now reachable via the context menu's "Open folder" item. */
function drillIntoFolder(n) {
  sound.enterFolder();
  if (mode === 'bookmarks') {
    bookmarkStack.push({ id: n.bookmarkId, title: n.label });
    renderBookmarks();
  } else {
    favoriteStack.push({ id: n.id, title: n.label });
    renderFavorites();
  }
}

function onNodeEdit(n) {
  if (n.isHub) return;
  if (mode === 'bookmarks') openBookmarkEditModal(n);
  else openModal({ existing: n });
}

/* ---------- right-click context menu ---------- */
function onNodeContext(n, x, y) {
  if (n.isHub) return;
  ctxTargetNode = n;
  sound.switchTab();
  const isFavFolder = mode === 'favorites' && n.type === 'folder';
  const view = mode === 'bookmarks' ? bookmarksView : favoritesView;
  const showOpen = n.type === 'folder' && view === 'drill';
  ctxOpenBtn.classList.toggle('hidden', !showOpen);
  ctxAddLinkBtn.classList.toggle('hidden', !isFavFolder);
  ctxAddFolderBtn.classList.toggle('hidden', !isFavFolder);
  const itemCount = 3 + (isFavFolder ? 2 : 0) + (showOpen ? 1 : 0); // Edit/Hide/Delete + optional Add Link/Add Folder + optional Open
  const menuHeight = 20 + 38 * itemCount;
  ctxMenu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - menuHeight) + 'px';
  ctxMenu.classList.remove('hidden');
}

function hideCtxMenu() { ctxMenu.classList.add('hidden'); ctxTargetNode = null; }

document.addEventListener('pointerdown', (e) => {
  if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) hideCtxMenu();
});
window.addEventListener('resize', hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

ctxOpenBtn.addEventListener('click', () => {
  const n = ctxTargetNode;
  hideCtxMenu();
  if (n) drillIntoFolder(n);
});

ctxEditBtn.addEventListener('click', () => {
  const n = ctxTargetNode;
  hideCtxMenu();
  if (!n) return;
  if (mode === 'bookmarks') openBookmarkEditModal(n);
  else openModal({ existing: n });
});

ctxHideBtn.addEventListener('click', async () => {
  const n = ctxTargetNode;
  hideCtxMenu();
  if (!n) return;
  await toggleHidden(mode, n.id);
  sound.uiClick();
  showToast(`"${n.label}" hidden. Manage hidden items in Settings → Visibility.`, { type: 'info' });
  render();
});

ctxDeleteBtn.addEventListener('click', () => {
  const n = ctxTargetNode;
  hideCtxMenu();
  if (n) handleDeleteRequest(n);
});

ctxAddLinkBtn.addEventListener('click', () => {
  const n = ctxTargetNode;
  hideCtxMenu();
  if (n) openModal({ parentId: n.id, forcedType: 'link' });
});

ctxAddFolderBtn.addEventListener('click', () => {
  const n = ctxTargetNode;
  hideCtxMenu();
  if (n) openModal({ parentId: n.id, forcedType: 'folder' });
});

/* ---------- edit modal for a real bookmark or folder ---------- */
function openBookmarkEditModal(n) {
  editingBookmarkNode = n;
  const isFolder = n.type === 'folder';
  bookmarkModalTitle.textContent = isFolder ? 'Edit folder' : 'Edit bookmark';
  bmTitleInput.value = n.label;
  bmUrlField.classList.toggle('hidden', isFolder);
  bmUrlInput.value = isFolder ? '' : (n.url || '');
  bookmarkModalOverlay.classList.remove('hidden');
  bmTitleInput.focus();
}
function closeBookmarkEditModal() {
  bookmarkModalOverlay.classList.add('hidden');
  editingBookmarkNode = null;
}
document.getElementById('bmCancelBtn').addEventListener('click', closeBookmarkEditModal);
bookmarkModalOverlay.addEventListener('click', (e) => { if (e.target === bookmarkModalOverlay) closeBookmarkEditModal(); });

document.getElementById('bmSaveBtn').addEventListener('click', async () => {
  const n = editingBookmarkNode;
  if (!n) return;
  const title = bmTitleInput.value.trim();
  if (!title) return;
  const updates = { title };
  if (n.type !== 'folder') {
    let url = bmUrlInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    updates.url = url;
  }
  try {
    await chrome.bookmarks.update(n.bookmarkId, updates);
    sound.add();
  } catch (err) {
    // node may no longer exist — ignore, re-render will reflect current state
  }
  closeBookmarkEditModal();
  await renderBookmarks();
});

/* ---------- delete flow ---------- */
function showDeleteBar(text) {
  deleteConfirmText.textContent = text;
  deleteConfirmBar.classList.remove('hidden');
}
function hideDeleteBar() { deleteConfirmBar.classList.add('hidden'); }

async function handleDeleteRequest(n) {
  if (mode === 'bookmarks') {
    if (n.type === 'folder') {
      await requestDeleteBookmarkFolder(n);
    } else {
      pendingDelete = { kind: 'bookmark', node: n };
      showDeleteBar(`Delete bookmark "${n.label}"?`);
    }
  } else {
    if (n.type === 'folder') {
      await requestDeleteFavFolder(n);
    } else {
      pendingDelete = { kind: 'favorite', node: n };
      showDeleteBar(`Delete favorite "${n.label}"?`);
    }
  }
}

async function requestDeleteBookmarkFolder(n) {
  let subtree;
  try {
    subtree = await chrome.bookmarks.getSubTree(n.bookmarkId);
  } catch (err) {
    pendingDelete = { kind: 'bookmark-folder', node: n };
    showDeleteBar(`Delete folder "${n.label}" and everything inside it?`);
    return;
  }

  const root = subtree[0];
  const idSet = new Set([root.id]);
  let bookmarkCount = 0, folderCount = 0;
  (function walk(items) {
    for (const item of items) {
      idSet.add(item.id);
      if (item.url) bookmarkCount++; else folderCount++;
      if (item.children && item.children.length) walk(item.children);
    }
  })(root.children || []);

  const switchedView = bookmarksView !== 'full';
  const prevView = bookmarksView;
  const prevStack = bookmarkStack.slice();

  if (switchedView) {
    bookmarksView = 'full';
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'full'));
    await renderBookmarks();
  }
  graph.highlightSubset(idSet, root.id);
  pendingDelete = { kind: 'bookmark-folder', node: n, switchedView, prevView, prevStack, idSet };

  const parts = [];
  if (folderCount) parts.push(`${folderCount} subfolder${folderCount === 1 ? '' : 's'}`);
  parts.push(`${bookmarkCount} bookmark${bookmarkCount === 1 ? '' : 's'}`);
  const detail = (bookmarkCount || folderCount)
    ? ` This also removes ${parts.join(' and ')} inside it.`
    : ' (This folder is empty.)';
  showDeleteBar(`Delete folder "${n.label}"?${detail}`);
}

async function requestDeleteFavFolder(n) {
  const { idSet, linkCount, folderCount } = await getFavSubtreeInfo(n.id);

  const switchedView = favoritesView !== 'full';
  const prevView = favoritesView;
  const prevStack = favoriteStack.slice();

  if (switchedView) {
    favoritesView = 'full';
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'full'));
    await renderFavorites();
  }
  graph.highlightSubset(idSet, n.id);
  pendingDelete = { kind: 'favorite-folder', node: n, switchedView, prevView, prevStack, idSet };

  const parts = [];
  if (folderCount) parts.push(`${folderCount} subfolder${folderCount === 1 ? '' : 's'}`);
  parts.push(`${linkCount} favorite${linkCount === 1 ? '' : 's'}`);
  const detail = (linkCount || folderCount)
    ? ` This also removes ${parts.join(' and ')} inside it.`
    : ' (This folder is empty.)';
  showDeleteBar(`Delete folder "${n.label}"?${detail}`);
}

document.getElementById('deleteCancelBtn').addEventListener('click', async () => {
  hideDeleteBar();
  const pd = pendingDelete;
  pendingDelete = null;
  if (!pd) return;
  if (pd.kind === 'bookmark-folder') {
    graph.clearHighlight();
    if (pd.switchedView) {
      bookmarksView = pd.prevView;
      bookmarkStack = pd.prevStack;
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === bookmarksView));
      await renderBookmarks();
    }
  } else if (pd.kind === 'favorite-folder') {
    graph.clearHighlight();
    if (pd.switchedView) {
      favoritesView = pd.prevView;
      favoriteStack = pd.prevStack;
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === favoritesView));
      await renderFavorites();
    }
  }
});

document.getElementById('deleteConfirmBtn').addEventListener('click', async () => {
  const pd = pendingDelete;
  pendingDelete = null;
  hideDeleteBar();
  if (!pd) return;
  try {
    if (pd.kind === 'bookmark-folder') await chrome.bookmarks.removeTree(pd.node.bookmarkId);
    else if (pd.kind === 'bookmark') await chrome.bookmarks.remove(pd.node.bookmarkId);
    else if (pd.kind === 'favorite-folder' || pd.kind === 'favorite') await deleteFavNode(pd.node.id);
    sound.remove();
    // Drop any deleted ids from the persisted expanded-node set so they
    // don't linger forever (they'd never be re-created, so this is purely
    // cleanup, not something that could hide anything).
    const cleanupIds = pd.idSet ? [...pd.idSet] : [pd.node.bookmarkId || pd.node.id];
    const cleanupMode = pd.kind.startsWith('bookmark') ? 'bookmarks' : 'favorites';
    await collapseSubtree(cleanupMode, cleanupIds);
  } catch (err) {
    // already gone — ignore
  }
  graph.clearHighlight();
  if (mode === 'bookmarks') await renderBookmarks();
  else await renderFavorites();
});

/* ---------- mode switch ---------- */
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sound.switchTab();
    cancelPendingDelete();
    closeSearchResults();
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    mode = btn.dataset.mode;
    if (mode === 'bookmarks') {
      bookmarkStack = [{ id: '0', title: 'Bookmarks' }];
    } else {
      favoriteStack = [{ id: 'root', title: 'Favorites' }];
    }
    const currentView = mode === 'bookmarks' ? bookmarksView : favoritesView;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === currentView));
    render();
  });
});

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sound.switchTab();
    cancelPendingDelete();
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    if (mode === 'bookmarks') {
      bookmarksView = view;
      if (bookmarksView === 'drill') bookmarkStack = [{ id: '0', title: 'Bookmarks' }];
      renderBookmarks();
    } else {
      favoritesView = view;
      if (favoritesView === 'drill') favoriteStack = [{ id: 'root', title: 'Favorites' }];
      renderFavorites();
    }
  });
});

/* ---------- modal (add / edit favorite link or folder) ---------- */
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const favTypeToggle = document.getElementById('favTypeToggle');
const favTitleInput = document.getElementById('favTitle');
const favUrlField = document.getElementById('favUrlField');
const favUrlInput = document.getElementById('favUrl');
const deleteFavBtn = document.getElementById('deleteFavBtn');

function openModal(opts = {}) {
  const { existing = null, parentId = null, forcedType = null } = opts;
  editingFavNode = existing;

  if (existing) {
    const isFolder = existing.type === 'folder';
    modalTitle.textContent = isFolder ? 'Edit folder' : 'Edit favorite';
    favTypeToggle.classList.add('hidden');
    favTitleInput.value = existing.label;
    favUrlField.classList.toggle('hidden', isFolder);
    favUrlInput.value = isFolder ? '' : (existing.url || '');
    deleteFavBtn.classList.remove('hidden');
  } else {
    addFavParentId = parentId || (favoritesView === 'full' ? 'root' : favoriteStack[favoriteStack.length - 1].id);
    addFavType = forcedType || 'link';
    modalTitle.textContent = 'Add to favorites';
    favTypeToggle.classList.toggle('hidden', !!forcedType);
    document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === addFavType));
    favTitleInput.value = '';
    favUrlField.classList.toggle('hidden', addFavType === 'folder');
    favUrlInput.value = '';
    deleteFavBtn.classList.add('hidden');
  }

  modalOverlay.classList.remove('hidden');
  favTitleInput.focus();
}
function closeModal() {
  modalOverlay.classList.add('hidden');
  editingFavNode = null;
}

document.querySelectorAll('.type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    addFavType = btn.dataset.type;
    document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b === btn));
    favUrlField.classList.toggle('hidden', addFavType === 'folder');
  });
});

addFavBtn.addEventListener('click', () => openModal());
document.getElementById('cancelBtn').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

document.getElementById('saveFavBtn').addEventListener('click', async () => {
  const title = favTitleInput.value.trim();

  if (editingFavNode) {
    if (!title) return;
    const updates = { title };
    if (editingFavNode.type !== 'folder') {
      let url = favUrlInput.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      updates.url = url;
    }
    await updateFavNode(editingFavNode.id, updates);
  } else if (addFavType === 'folder') {
    if (!title) return;
    await addFavNode({ title, type: 'folder', parentId: addFavParentId });
  } else {
    let url = favUrlInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const finalTitle = title || url.replace(/^https?:\/\//i, '').split('/')[0];
    await addFavNode({ title: finalTitle, url, type: 'link', parentId: addFavParentId });
  }

  sound.add();
  closeModal();
  render();
});

deleteFavBtn.addEventListener('click', async () => {
  if (!editingFavNode) return;
  const n = editingFavNode;
  closeModal();
  await handleDeleteRequest(n);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) closeModal();
});

/* ---------- sound toggle ---------- */
const soundToggleBtn = document.getElementById('soundToggleBtn');
function applySoundIcon(enabled) {
  soundToggleBtn.textContent = enabled ? '🔊' : '🔇';
  soundToggleBtn.classList.toggle('muted', !enabled);
  soundToggleBtn.title = enabled ? 'Sound effects on — click to mute' : 'Sound effects off — click to unmute';
}
soundToggleBtn.addEventListener('click', async () => {
  sound.uiClick();
  const next = !sound.enabled;
  await updateSettings({ soundEnabled: next });
});

/* ---------- search ---------- */
const searchWrap = document.getElementById('searchWrap');
const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');
const searchResults = document.getElementById('searchResults');
let searchableCache = [];

async function buildSearchableIndex() {
  if (mode === 'favorites') {
    const tree = await getFavTree();
    searchableCache = tree.map(f => ({ id: f.id, label: f.title || '(untitled)', url: f.url, type: f.type, parentId: f.parentId }));
  } else {
    let flat = [];
    try {
      const t = await chrome.bookmarks.getTree();
      (function walk(items) {
        for (const item of items) {
          flat.push({ id: item.id, label: item.title || '(untitled)', url: item.url, type: item.url ? 'bookmark' : 'folder' });
          if (item.children) walk(item.children);
        }
      })(t[0].children || []);
    } catch (err) { /* ignore */ }
    searchableCache = flat;
  }
}

function closeSearchResults() {
  searchResults.classList.add('hidden');
  graph.clearSearchMatches?.();
}

searchInput.addEventListener('focus', async () => {
  await buildSearchableIndex();
});

searchInput.addEventListener('input', () => {
  const q = searchInput.value;
  searchWrap.classList.toggle('has-query', !!q);
  if (!q.trim()) { closeSearchResults(); return; }
  const results = searchNodes(searchableCache, q, { limit: 25 });
  renderSearchResults(results);
  graph.markSearchMatches?.(new Set(results.map(r => r.item.id)));
});

function renderSearchResults(results) {
  searchResults.innerHTML = '';
  searchResults.classList.remove('hidden');
  if (!results.length) {
    searchResults.innerHTML = '<div class="search-empty">No matches.</div>';
    return;
  }
  results.forEach(({ item }) => {
    const row = document.createElement('div');
    row.className = 'search-result';
    const icon = item.type === 'folder' ? '📁' : (mode === 'favorites' ? '⭐' : '🔗');
    row.innerHTML = `<span class="sr-type">${icon}</span><span class="sr-label"></span>`;
    row.querySelector('.sr-label').textContent = item.label;
    row.addEventListener('click', () => jumpToSearchResult(item));
    searchResults.appendChild(row);
  });
}

async function jumpToSearchResult(item) {
  sound.enterFolder();
  closeSearchResults();
  searchInput.value = '';
  searchWrap.classList.remove('has-query');

  if (item.url) { window.open(item.url, '_blank'); return; }

  // it's a folder — jump into Explore mode at that folder
  if (mode === 'favorites') {
    favoritesView = 'drill';
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'drill'));
    const tree = await getFavTree();
    const map = {};
    tree.forEach(n => { map[n.id] = n; });
    const chain = [];
    let cur = item.id;
    while (cur && cur !== 'root' && map[cur]) {
      chain.unshift({ id: cur, title: map[cur].title });
      cur = map[cur].parentId;
    }
    chain.unshift({ id: 'root', title: 'Favorites' });
    favoriteStack = chain;
    renderFavorites();
  } else {
    bookmarksView = 'drill';
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'drill'));
    bookmarkStack = pathToNode(item.id);
    // pathToNode relies on bookmarkParentMap being populated (from a Whole Picture render);
    // fall back to walking the live tree if it's empty (single-entry chain = lookup failed).
    if (bookmarkStack.length <= 1) {
      try {
        const t = await chrome.bookmarks.getTree();
        const map = {};
        (function walk(items, parentId) {
          for (const it of items) {
            map[it.id] = { parentId, title: it.title || '(untitled)' };
            if (it.children) walk(it.children, it.id);
          }
        })(t[0].children || [], '0');
        const chain = [];
        let cur = item.id;
        while (cur && cur !== '0' && map[cur]) {
          chain.unshift({ id: cur, title: map[cur].title });
          cur = map[cur].parentId;
        }
        chain.unshift({ id: '0', title: 'Bookmarks' });
        bookmarkStack = chain;
      } catch (err) { /* ignore */ }
    }
    renderBookmarks();
  }
}

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchWrap.classList.remove('has-query');
  closeSearchResults();
  searchInput.focus();
});

document.addEventListener('pointerdown', (e) => {
  if (!searchWrap.contains(e.target)) closeSearchResults();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.blur();
    closeSearchResults();
  }
});

/* ---------- settings panel ---------- */
const settingsToggleBtn = document.getElementById('settingsToggleBtn');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsAside = document.getElementById('settingsAside');
const settingsAsideBody = document.getElementById('settingsAsideBody');
let panelMounted = false;

function openSettings() {
  if (!panelMounted) {
    mountSettingsPanel(settingsAsideBody, { onGraphSettingsChange: handleGraphSettingsChange });
    panelMounted = true;
  }
  settingsOverlay.classList.add('open');
  settingsAside.classList.add('open');
  settingsToggleBtn.classList.add('active-settings');
}
function closeSettings() {
  settingsOverlay.classList.remove('open');
  settingsAside.classList.remove('open');
  settingsToggleBtn.classList.remove('active-settings');
}
settingsToggleBtn.addEventListener('click', () => {
  sound.uiClick();
  settingsAside.classList.contains('open') ? closeSettings() : openSettings();
});
settingsCloseBtn.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsAside.classList.contains('open')) closeSettings(); });

async function handleGraphSettingsChange(newSettings, flags = {}) {
  settings = newSettings;
  if (flags.modeChanged) {
    switchGraphEngine();
    return;
  }
  graph.setPhysics(settings.physics);
  graph.setReduceMotion(settings.reduceMotion);
  graph.setShowLabels(settings.showLabels);
  if (flags.needsFullReload) {
    favoriteStack = [{ id: 'root', title: 'Favorites' }];
    bookmarkStack = [{ id: '0', title: 'Bookmarks' }];
  }
  if (flags.needsRerender || flags.needsFullReload) render();
}

// Keep in sync with settings changed elsewhere (e.g. the options page in another tab).
onSettingsChange((s) => {
  const themeChanged = JSON.stringify(s.theme) !== JSON.stringify(settings.theme);
  settings = s;
  if (themeChanged) {
    applyThemeVars(resolveThemeVars(s.theme));
    graph.setColors(resolveGraphColors(resolveThemeVars(s.theme)));
  }
  document.documentElement.dataset.labelDensity = s.labelDensity;
  sound.setEnabled(s.soundEnabled);
  sound.setVolume(s.soundVolume);
  applySoundIcon(s.soundEnabled);
});

/* ---------- init ---------- */
sound.setEnabled(settings.soundEnabled);
sound.setVolume(settings.soundVolume);
applySoundIcon(settings.soundEnabled);

render();

if (isExportReminderDue(settings)) {
  showToast('It\u2019s been a while since your last backup export.', {
    type: 'warn',
    duration: 8000,
    actionLabel: 'Open Settings',
    onAction: openSettings
  });
}
