import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from './vendor/CSS2DRenderer.js';

/* ---------- constants ---------- */
const COLORS = {
  hub: 0x2a2c3a,
  hubEdge: 0x9d7cf5,
  folder: 0x9d7cf5,
  bookmark: 0x5ecfc4,
  favorite: 0xf5b56d,
  edge: 0x3a3d4e
};

const REPEL_K = 26000;
const SPRING_K = 0.02;
const REST_LEN = 130;
const DAMPING = 0.86;
const GRAVITY = 0.0022;
const MAX_RADIUS = 340;

const _edgeBaseColor = new THREE.Color(COLORS.edge);
const _edgeHighlightColor = new THREE.Color(0xff5c5c);
const _edgeDimColor = new THREE.Color(0x22242e);

/* ---------- synthesized sound effects (Web Audio API, no audio files needed) ---------- */
class SoundManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }
  _ensureCtx() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  setEnabled(v) { this.enabled = v; }

  _tone({ freq = 440, duration = 0.12, type = 'square', gain = 0.13, glideTo = null, delay = 0, filterFreq = null, filterType = 'lowpass', filterQ = 1 } = {}, bypassMute = false) {
    if (!this.enabled && !bypassMute) return;
    this._ensureCtx();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    let out = osc;
    if (filterFreq) {
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.setValueAtTime(filterFreq, t0);
      f.Q.value = filterQ;
      osc.connect(f);
      out = f;
    }
    out.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  }

  // Short burst of filtered white noise — static/relay-click texture
  _noise({ duration = 0.05, gain = 0.1, filterFreq = 3000, filterType = 'bandpass', filterQ = 1.2, delay = 0 } = {}, bypassMute = false) {
    if (!this.enabled && !bypassMute) return;
    this._ensureCtx();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = filterFreq;
    filt.Q.value = filterQ;

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    src.connect(filt);
    filt.connect(g);
    g.connect(ctx.destination);
    src.start(t0);
  }

  // Quick sequence of stepped blips — classic "terminal scan / data read" feel
  _blipSequence(freqs, { duration = 0.045, gap = 0.02, gain = 0.12, type = 'square' } = {}) {
    freqs.forEach((f, i) => {
      this._tone({ freq: f, duration, type, gain, delay: i * (duration + gap), filterFreq: 4200 });
    });
  }

  hover() {
    this._tone({ freq: 1900, duration: 0.025, type: 'square', gain: 0.03, filterFreq: 4500 });
  }
  open() {
    // rising stepped blip run, like an "access granted" handshake, plus a soft static tail
    this._blipSequence([620, 880, 1320], { duration: 0.045, gap: 0.018, gain: 0.13 });
    this._noise({ duration: 0.05, gain: 0.05, filterFreq: 5500, delay: 0.13 });
  }
  enterFolder() {
    this._tone({ freq: 340, duration: 0.1, type: 'sawtooth', gain: 0.13, glideTo: 950, filterFreq: 2400 });
    this._noise({ duration: 0.04, gain: 0.05, filterFreq: 6000, delay: 0.06 });
  }
  back() {
    this._tone({ freq: 950, duration: 0.1, type: 'sawtooth', gain: 0.12, glideTo: 300, filterFreq: 2400 });
  }
  switchTab() {
    this._noise({ duration: 0.02, gain: 0.09, filterFreq: 4500, filterType: 'highpass' });
    this._tone({ freq: 1100, duration: 0.03, type: 'square', gain: 0.07, delay: 0.008, filterFreq: 5000 });
  }
  add() {
    this._blipSequence([523.25, 659.25, 987.77], { duration: 0.05, gap: 0.012, gain: 0.13 });
  }
  remove() {
    this._tone({ freq: 260, duration: 0.18, type: 'sawtooth', gain: 0.1, glideTo: 85, filterFreq: 1200 });
    this._noise({ duration: 0.09, gain: 0.07, filterFreq: 900, filterType: 'lowpass', delay: 0.02 });
  }
  // The mute switch itself always clicks, even when muting — like a real relay toggle
  uiClick() { this._noise({ duration: 0.02, gain: 0.15, filterFreq: 3500, filterQ: 2 }, true); }
}
const sound = new SoundManager();

/* ---------- 3D force-directed graph engine ---------- */
class Graph3D {
  constructor(container) {
    this.container = container;
    this.nodes = [];
    this.edges = [];
    this.onNodeActivate = null;
    this.onNodeEdit = null;
    this.onNodeHover = null;
    this.onNodeContext = null;
    this._hoveredMesh = null;
    this._highlightActive = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, 1, 1, 4000);
    this.camera.position.set(0, 40, 460);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.left = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.labelRenderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(120, 200, 250);
    this.scene.add(dir);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.55;
    this.controls.minDistance = 80;
    this.controls.maxDistance = 1400;

    this.edgeLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 })
    );
    this.scene.add(this.edgeLines);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._downPos = null;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();

    this.renderer.domElement.addEventListener('pointerdown', e => {
      if (e.button !== 0) { this._downPos = null; return; } // ignore right/middle click
      this._downPos = { x: e.clientX, y: e.clientY };
    });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (e.button !== 0) return;
      if (!this._downPos) return;
      const moved = Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y);
      this._downPos = null;
      if (moved > 5) return; // was a rotate/drag, not a click
      const hit = this._pick(e);
      if (hit && this.onNodeActivate) this.onNodeActivate(hit.userData);
    });
    this.renderer.domElement.addEventListener('dblclick', e => {
      const hit = this._pick(e);
      if (hit && this.onNodeEdit) this.onNodeEdit(hit.userData);
    });
    this.renderer.domElement.addEventListener('contextmenu', e => {
      const hit = this._pick(e);
      if (hit) {
        e.preventDefault(); // only suppress the native menu when a node was actually hit
        if (this.onNodeContext) this.onNodeContext(hit.userData, e.clientX, e.clientY);
      }
    });
    this.renderer.domElement.addEventListener('pointermove', e => {
      if (this._downPos) return; // don't fight with rotate-drag
      const hit = this._pick(e);
      if (hit !== this._hoveredMesh) {
        this._hoveredMesh = hit;
        this.renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
        if (hit && this.onNodeHover) this.onNodeHover(hit.userData);
      }
    });

    requestAnimationFrame(() => this._tick());
  }

  _pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = this.nodes.map(n => n.mesh);
    const hits = this.raycaster.intersectObjects(meshes);
    return hits.length ? hits[0].object : null;
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
  }

  clear() {
    for (const n of this.nodes) {
      if (n.mesh) {
        n.mesh.geometry.dispose();
        n.mesh.material.dispose();
        // Removing a mesh from the scene does NOT recursively fire the
        // 'removed' event on its children, so CSS2DObject labels attached
        // to the mesh never get their DOM element cleaned up on their own.
        // Remove the label <div>s explicitly here, or they pile up on
        // every re-render (whole picture <-> explore, folder drills, etc).
        n.mesh.traverse(obj => {
          if (obj.isCSS2DObject && obj.element && obj.element.parentNode) {
            obj.element.parentNode.removeChild(obj.element);
          }
        });
        this.scene.remove(n.mesh);
      }
    }
    this.nodes = [];
    this.edges = [];
    this._hoveredMesh = null;
  }

  // Dim every node except `idSet` (always keeps the hub visible), and tints
  // `targetId` red — used to preview a folder + its contents before deleting it.
  highlightSubset(idSet, targetId) {
    this._highlightActive = true;
    for (const n of this.nodes) {
      const inSet = n.isHub || idSet.has(n.id);
      const mat = n.mesh.material;
      mat.transparent = true;
      if (n.id === targetId) {
        mat.color.setHex(0xff5c5c);
        mat.emissive.setHex(0xff5c5c);
        mat.emissiveIntensity = 0.55;
      } else {
        mat.emissiveIntensity = inSet ? (n.isHub ? 0.25 : 0.35) : 0.05;
      }
      mat.opacity = inSet ? 1 : 0.12;
      const labelObj = n.mesh.children.find(c => c.isCSS2DObject);
      if (labelObj) labelObj.element.style.opacity = inSet ? '1' : '0.15';
    }

    const colorAttr = this.edgeLines.geometry.getAttribute('color');
    if (colorAttr) {
      const arr = colorAttr.array;
      this.edges.forEach((e, i) => {
        const c = (idSet.has(e.a) && idSet.has(e.b)) ? _edgeHighlightColor : _edgeDimColor;
        const base = i * 6;
        arr[base] = c.r; arr[base + 1] = c.g; arr[base + 2] = c.b;
        arr[base + 3] = c.r; arr[base + 4] = c.g; arr[base + 5] = c.b;
      });
      colorAttr.needsUpdate = true;
    }
    this.edgeLines.material.opacity = 0.85;
  }

  clearHighlight() {
    if (!this._highlightActive) return;
    this._highlightActive = false;
    for (const n of this.nodes) {
      const mat = n.mesh.material;
      const baseColor = n.isHub ? COLORS.hub : COLORS[n.type];
      mat.color.setHex(baseColor);
      mat.emissive.setHex(n.isHub ? COLORS.hubEdge : baseColor);
      mat.emissiveIntensity = n.isHub ? 0.25 : 0.35;
      mat.opacity = 1;
      mat.transparent = false;
      const labelObj = n.mesh.children.find(c => c.isCSS2DObject);
      if (labelObj) labelObj.element.style.opacity = '';
    }

    const colorAttr = this.edgeLines.geometry.getAttribute('color');
    if (colorAttr) {
      const arr = colorAttr.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] = _edgeBaseColor.r; arr[i + 1] = _edgeBaseColor.g; arr[i + 2] = _edgeBaseColor.b;
      }
      colorAttr.needsUpdate = true;
    }
    this.edgeLines.material.opacity = 0.55;
  }

  setData(nodes, edges) {
    this.clear();
    nodes.forEach((n) => {
      if (n.isHub) {
        n.x = 0; n.y = 0; n.z = 0;
      } else {
        const phi = Math.acos(2 * Math.random() - 1);
        const theta = Math.random() * Math.PI * 2;
        const rad = 70 + Math.random() * 30;
        n.x = rad * Math.sin(phi) * Math.cos(theta);
        n.y = rad * Math.sin(phi) * Math.sin(theta);
        n.z = rad * Math.cos(phi);
      }
      n.vx = 0; n.vy = 0; n.vz = 0;

      const color = n.isHub ? COLORS.hub : COLORS[n.type];
      const geo = new THREE.SphereGeometry(n.r, 20, 16);
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.45,
        metalness: 0.05,
        emissive: n.isHub ? COLORS.hubEdge : color,
        emissiveIntensity: n.isHub ? 0.25 : 0.35
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(n.x, n.y, n.z);
      mesh.userData = n;
      this.scene.add(mesh);
      n.mesh = mesh;

      const div = document.createElement('div');
      div.className = 'node-label' + (n.isHub ? ' hub-label' : '');
      const label = n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label;
      div.textContent = label;
      const labelObj = new CSS2DObject(div);
      labelObj.position.set(0, -(n.r + 8), 0);
      mesh.add(labelObj);
    });

    this.nodes = nodes;
    this.edges = edges;

    const positions = new Float32Array(edges.length * 2 * 3);
    this.edgeLines.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const colors = new Float32Array(edges.length * 2 * 3);
    for (let i = 0; i < edges.length; i++) {
      const base = i * 6;
      colors[base] = _edgeBaseColor.r; colors[base + 1] = _edgeBaseColor.g; colors[base + 2] = _edgeBaseColor.b;
      colors[base + 3] = _edgeBaseColor.r; colors[base + 4] = _edgeBaseColor.g; colors[base + 5] = _edgeBaseColor.b;
    }
    this.edgeLines.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  _tick() {
    this._step();
    this._updateEdgeGeometry();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this._tick());
  }

  _step() {
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      let fx = 0, fy = 0, fz = 0;
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 4) d2 = 4;
        const d = Math.sqrt(d2);
        const f = REPEL_K / d2;
        fx += (dx / d) * f;
        fy += (dy / d) * f;
        fz += (dz / d) * f;
      }
      fx += -a.x * GRAVITY;
      fy += -a.y * GRAVITY;
      fz += -a.z * GRAVITY;
      a._fx = fx; a._fy = fy; a._fz = fz;
    }
    for (const e of this.edges) {
      const a = nodes.find(n => n.id === e.a);
      const b = nodes.find(n => n.id === e.b);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const f = SPRING_K * (d - REST_LEN);
      const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
      a._fx += fx; a._fy += fy; a._fz += fz;
      b._fx -= fx; b._fy -= fy; b._fz -= fz;
    }
    for (const n of nodes) {
      if (n.isHub) { n.x = 0; n.y = 0; n.z = 0; n.mesh.position.set(0, 0, 0); continue; }
      n.vx = (n.vx + n._fx * 0.02) * DAMPING;
      n.vy = (n.vy + n._fy * 0.02) * DAMPING;
      n.vz = (n.vz + n._fz * 0.02) * DAMPING;
      n.x += n.vx; n.y += n.vy; n.z += n.vz;
      const dist = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
      if (dist > MAX_RADIUS) {
        const s = MAX_RADIUS / dist;
        n.x *= s; n.y *= s; n.z *= s;
      }
      n.mesh.position.set(n.x, n.y, n.z);
    }
  }

  _updateEdgeGeometry() {
    const attr = this.edgeLines.geometry.getAttribute('position');
    if (!attr) return;
    const arr = attr.array;
    let i = 0;
    for (const e of this.edges) {
      const a = this.nodes.find(n => n.id === e.a);
      const b = this.nodes.find(n => n.id === e.b);
      if (!a || !b) { i += 6; continue; }
      arr[i++] = a.x; arr[i++] = a.y; arr[i++] = a.z;
      arr[i++] = b.x; arr[i++] = b.y; arr[i++] = b.z;
    }
    attr.needsUpdate = true;
  }
}

/* ---------- app state ---------- */
const sceneContainer = document.getElementById('sceneContainer');
const graph = new Graph3D(sceneContainer);
const crumbBar = document.getElementById('crumbBar');
const emptyState = document.getElementById('emptyState');
const emptyTitle = document.getElementById('emptyTitle');
const emptySub = document.getElementById('emptySub');
const addFavBtn = document.getElementById('addFavBtn');
const bookmarkViewSwitch = document.getElementById('bookmarkViewSwitch');
const ctxMenu = document.getElementById('nodeContextMenu');
const ctxAddLinkBtn = document.getElementById('ctxAddLinkBtn');
const ctxAddFolderBtn = document.getElementById('ctxAddFolderBtn');
const ctxEditBtn = document.getElementById('ctxEditBtn');
const ctxDeleteBtn = document.getElementById('ctxDeleteBtn');
const bookmarkModalOverlay = document.getElementById('bookmarkModalOverlay');
const bookmarkModalTitle = document.getElementById('bookmarkModalTitle');
const bmTitleInput = document.getElementById('bmTitleInput');
const bmUrlField = document.getElementById('bmUrlField');
const bmUrlInput = document.getElementById('bmUrlInput');
const deleteConfirmBar = document.getElementById('deleteConfirmBar');
const deleteConfirmText = document.getElementById('deleteConfirmText');

let mode = 'favorites';
let bookmarksView = 'drill'; // 'drill' | 'full'
let favoritesView = 'drill'; // 'drill' | 'full'
let bookmarkStack = [{ id: '0', title: 'Bookmarks' }];
let favoriteStack = [{ id: 'root', title: 'Favorites' }];
let editingFavNode = null;      // rendered node ({id,label,url,type}) currently open in the favorite add/edit modal
let addFavParentId = 'root';    // parent folder id a new favorite/folder will be created under
let addFavType = 'link';        // 'link' | 'folder' — selected in the add modal's type toggle
let bookmarkParentMap = {}; // id -> { parentId, title } — built while rendering the full bookmark tree
let favParentMap = {};      // id -> { parentId, title } — built while rendering the full favorites tree
let ctxTargetNode = null;   // node currently targeted by the right-click context menu
let editingBookmarkNode = null; // node currently open in the bookmark edit modal
let pendingDelete = null;   // { kind: 'bookmark'|'bookmark-folder'|'favorite'|'favorite-folder', node, switchedView?, prevView?, prevStack? }

/* ---------- storage helpers: favorites tree ----------
   Stored as a flat array of { id, title, type: 'link'|'folder', url?, parentId }
   where parentId is 'root' for top-level items. This mirrors the shape of
   chrome.bookmarks so the favorites section can support the same
   explore/whole-picture drill-down as real bookmarks. */
async function getFavTree() {
  const res = await chrome.storage.local.get(['favoriteTree', 'favoriteLinks']);
  if (res.favoriteTree) return res.favoriteTree;
  // one-time migration from the old flat favoriteLinks list
  const old = res.favoriteLinks || [];
  const migrated = old.map(f => ({ id: f.id, title: f.title, url: f.url, type: 'link', parentId: 'root' }));
  await chrome.storage.local.set({ favoriteTree: migrated });
  return migrated;
}
async function saveFavTree(list) {
  await chrome.storage.local.set({ favoriteTree: list });
}
async function addFavNode({ title, url, type, parentId }) {
  const tree = await getFavTree();
  const node = { id: 'fav_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), title, type, parentId };
  if (type === 'link') node.url = url;
  tree.push(node);
  await saveFavTree(tree);
  return node;
}
async function updateFavNode(id, updates) {
  const tree = await getFavTree();
  const idx = tree.findIndex(n => n.id === id);
  if (idx >= 0) tree[idx] = { ...tree[idx], ...updates };
  await saveFavTree(tree);
}
// Cascading delete: removes the node and, if it's a folder, everything nested inside it.
async function deleteFavNode(id) {
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
// Walks a folder's subtree to preview a cascading delete (counts + affected ids).
async function getFavSubtreeInfo(id) {
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

/* ---------- rendering per mode ---------- */
function setEmpty(show, title, sub) {
  emptyState.classList.toggle('hidden', !show);
  sceneContainer.classList.toggle('hidden', show);
  if (show) { emptyTitle.textContent = title; emptySub.textContent = sub; }
}

async function renderFavorites() {
  addFavBtn.classList.remove('hidden');
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
  const children = tree.filter(f => f.parentId === current.id);

  if (children.length === 0) {
    const atRoot = current.id === 'root';
    setEmpty(true, atRoot ? 'No favorites yet' : 'This folder is empty',
      atRoot ? 'Click the + button to add your first link or folder' : 'Go back, or use + to add something here');
    graph.setData([], []);
    return;
  }
  setEmpty(false);

  const hub = { id: 'hub', label: current.title, isHub: true, r: 9 };
  const nodes = [hub, ...children.map(f => ({
    id: f.id,
    label: f.title || '(untitled)',
    url: f.url,
    type: f.type === 'folder' ? 'folder' : 'favorite', // render color: folder = purple, link = amber
    r: f.type === 'folder' ? 15 : 12
  }))];
  const edges = children.map(f => ({ a: 'hub', b: f.id }));
  graph.setData(nodes, edges);
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
    graph.setData([], []);
    return;
  }
  setEmpty(false);
  graph.setData(nodes, edges);
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

  let children;
  try {
    children = await chrome.bookmarks.getChildren(current.id);
  } catch (err) {
    setEmpty(true, 'Could not load bookmarks', 'Try reloading this page');
    graph.setData([], []);
    return;
  }

  if (!children || children.length === 0) {
    setEmpty(true, 'This folder is empty', 'Go back and pick another folder');
    graph.setData([], []);
    return;
  }
  setEmpty(false);

  const hub = { id: 'hub', label: current.title, isHub: true, r: 9 };
  const nodes = [hub, ...children.map(c => ({
    id: c.id,
    label: c.title || '(untitled)',
    url: c.url,
    bookmarkId: c.id,
    type: c.url ? 'bookmark' : 'folder',
    r: c.url ? 10 : 15
  }))];
  const edges = children.map(c => ({ a: 'hub', b: c.id }));
  graph.setData(nodes, edges);
}

async function renderBookmarksFull() {
  let tree;
  try {
    tree = await chrome.bookmarks.getTree();
  } catch (err) {
    setEmpty(true, 'Could not load bookmarks', 'Try reloading this page');
    graph.setData([], []);
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
    graph.setData([], []);
    return;
  }
  setEmpty(false);
  graph.setData(nodes, edges);
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

// Drops any in-progress delete confirmation (and its graph highlight) when the
// user navigates away instead of answering Cancel/Delete.
function cancelPendingDelete() {
  if (!pendingDelete) return;
  pendingDelete = null;
  deleteConfirmBar.classList.add('hidden');
  graph.clearHighlight();
}

function render() {
  if (mode === 'favorites') renderFavorites();
  else renderBookmarks();
}

/* ---------- node interaction ---------- */
graph.onNodeActivate = (n) => {
  cancelPendingDelete();

  if (n.url) { sound.open(); window.open(n.url, '_blank'); return; }
  if (n.type !== 'folder') return;

  sound.enterFolder();
  if (mode === 'bookmarks') {
    if (bookmarksView === 'full') {
      bookmarkStack = pathToNode(n.bookmarkId);
      bookmarksView = 'drill';
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'drill'));
      renderBookmarks();
    } else {
      bookmarkStack.push({ id: n.bookmarkId, title: n.label });
      renderBookmarks();
    }
  } else {
    if (favoritesView === 'full') {
      favoriteStack = favPathTo(n.id);
      favoritesView = 'drill';
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'drill'));
      renderFavorites();
    } else {
      favoriteStack.push({ id: n.id, title: n.label });
      renderFavorites();
    }
  }
};

graph.onNodeHover = () => { sound.hover(); };

graph.onNodeEdit = (n) => {
  if (n.isHub) return;
  if (mode === 'bookmarks') openBookmarkEditModal(n);
  else openModal({ existing: n });
};

/* ---------- right-click context menu ---------- */
graph.onNodeContext = (n, x, y) => {
  if (n.isHub) return;
  ctxTargetNode = n;
  sound.switchTab();
  const isFavFolder = mode === 'favorites' && n.type === 'folder';
  ctxAddLinkBtn.classList.toggle('hidden', !isFavFolder);
  ctxAddFolderBtn.classList.toggle('hidden', !isFavFolder);
  ctxMenu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - (isFavFolder ? 150 : 90)) + 'px';
  ctxMenu.classList.remove('hidden');
};

function hideCtxMenu() { ctxMenu.classList.add('hidden'); ctxTargetNode = null; }

document.addEventListener('pointerdown', (e) => {
  if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) hideCtxMenu();
});
window.addEventListener('resize', hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

ctxEditBtn.addEventListener('click', () => {
  const n = ctxTargetNode;
  hideCtxMenu();
  if (!n) return;
  if (mode === 'bookmarks') openBookmarkEditModal(n);
  else openModal({ existing: n });
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

/* ---------- delete flow: links/bookmarks are deleted right away, folders show a preview first ---------- */
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
    // fall back to a plain confirm if we can't inspect the contents
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
  pendingDelete = { kind: 'bookmark-folder', node: n, switchedView, prevView, prevStack };

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
  pendingDelete = { kind: 'favorite-folder', node: n, switchedView, prevView, prevStack };

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

// opts: { existing } to edit a real node, or { parentId, forcedType } to add a new one.
// With no opts at all, adds a new link/folder into whatever folder is currently active.
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
    // If the type was already decided (via a right-click "Add ... here"), skip the toggle.
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

async function initSound() {
  const res = await chrome.storage.local.get(['soundEnabled']);
  const enabled = res.soundEnabled !== false; // default: on
  sound.setEnabled(enabled);
  applySoundIcon(enabled);
}

soundToggleBtn.addEventListener('click', async () => {
  sound.uiClick();
  const next = !sound.enabled;
  sound.setEnabled(next);
  applySoundIcon(next);
  await chrome.storage.local.set({ soundEnabled: next });
});

initSound();

/* ---------- init ---------- */
render();
