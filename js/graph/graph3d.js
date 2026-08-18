import * as THREE from '../../vendor/three.module.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from '../../vendor/CSS2DRenderer.js';

// Mutable in place (not reassigned) so setColors() can re-theme an active
// instance. edgeHighlight/edgeDim were previously hardcoded separately from
// this map (a theming gap) — they now live here too, in sync with graph2d.js.
const COLORS = {
  hub: 0x2a2c3a,
  hubEdge: 0x9d7cf5,
  folder: 0x9d7cf5,
  bookmark: 0x5ecfc4,
  favorite: 0xf5b56d,
  edge: 0x3a3d4e,
  edgeHighlight: 0xff5c5c,
  edgeDim: 0x22242e
};

// THREE.Color instances derived from COLORS. Reassigned (not mutated) inside
// setColors() below, since THREE.Color has no bulk in-place "set from int"
// that we rely on elsewhere — a fresh instance is simplest and cheap.
let _edgeBaseColor = new THREE.Color(COLORS.edge);
let _edgeHighlightColor = new THREE.Color(COLORS.edgeHighlight);
let _edgeDimColor = new THREE.Color(COLORS.edgeDim);

function _cssHexToInt(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseInt(v.replace('#', ''), 16);
  return v;
}

/**
 * Uniform spatial grid used to cut repulsion from O(n²) to roughly O(n) for
 * evenly distributed node counts. Cell size is chosen relative to the
 * repulsion falloff distance so we only need to check the 3x3x3 neighboring
 * cells around each node instead of every other node in the scene.
 */
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.map = new Map();
  }
  _key(cx, cy, cz) { return `${cx},${cy},${cz}`; }
  clear() { this.map.clear(); }
  insert(node) {
    const cx = Math.floor(node.x / this.cellSize);
    const cy = Math.floor(node.y / this.cellSize);
    const cz = Math.floor(node.z / this.cellSize);
    const k = this._key(cx, cy, cz);
    let bucket = this.map.get(k);
    if (!bucket) { bucket = []; this.map.set(k, bucket); }
    bucket.push(node);
    node._cell = [cx, cy, cz];
  }
  /** Yields nodes in the 3x3x3 neighborhood of the given node's cell. */
  *neighbors(node) {
    const [cx, cy, cz] = node._cell;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.map.get(this._key(cx + dx, cy + dy, cz + dz));
          if (bucket) for (const n of bucket) yield n;
        }
      }
    }
  }
}

export class Graph3D {
  /**
   * @param {HTMLElement} container
   * @param {object} opts { physics, reduceMotion, showLabels }
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.nodes = [];
    this.edges = [];
    this.onNodeActivate = null;
    this.onNodeEdit = null;
    this.onNodeHover = null;
    this.onNodeContext = null;
    this._hoveredMesh = null;
    this._highlightActive = false;

    this.physics = { repel: 26000, springLength: 130, damping: 0.86, gravity: 0.0022, ...opts.physics };
    this.reduceMotion = !!opts.reduceMotion;
    this.showLabels = opts.showLabels !== false;
    this.maxRadius = 340;

    this._grid = new SpatialGrid(140);

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
      if (e.button !== 0) { this._downPos = null; return; }
      this._downPos = { x: e.clientX, y: e.clientY };
    });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (e.button !== 0) return;
      if (!this._downPos) return;
      const moved = Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y);
      this._downPos = null;
      if (moved > 5) return;
      const hit = this._pick(e);
      if (hit && this.onNodeActivate) this.onNodeActivate(hit.userData);
    });
    this.renderer.domElement.addEventListener('contextmenu', e => {
      const hit = this._pick(e);
      if (hit) {
        e.preventDefault();
        if (this.onNodeContext) this.onNodeContext(hit.userData, e.clientX, e.clientY);
      }
    });
    this.renderer.domElement.addEventListener('pointermove', e => {
      if (this._downPos) return;
      const hit = this._pick(e);
      if (hit !== this._hoveredMesh) {
        this._hoveredMesh = hit;
        this.renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
        if (hit && this.onNodeHover) this.onNodeHover(hit.userData);
      }
    });

    this._running = true;
    requestAnimationFrame(() => this._tick());
  }

  setPhysics(patch) { this.physics = { ...this.physics, ...patch }; }
  setReduceMotion(v) { this.reduceMotion = v; }

  /** Recenters the camera/orbit target. Call explicitly on real navigation (main.js decides when), not on every setData(). */
  resetCamera() {
    this.camera.position.set(0, 40, 460);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /**
   * Re-theme node/edge colors in place. `vars` is any subset of COLORS keys
   * mapped to CSS color strings or numeric hex (typically derived from the
   * active theme via themes.js#resolveGraphColors). Repaints existing
   * meshes/edge-line colors immediately via clearHighlight() rather than
   * requiring a full setData() rebuild.
   */
  setColors(vars = {}) {
    const converted = {};
    for (const k in vars) converted[k] = _cssHexToInt(vars[k]);
    Object.assign(COLORS, converted);
    _edgeBaseColor = new THREE.Color(COLORS.edge);
    _edgeHighlightColor = new THREE.Color(COLORS.edgeHighlight);
    _edgeDimColor = new THREE.Color(COLORS.edgeDim);
    if (this.nodes.length) this.clearHighlight();
  }

  setShowLabels(v) {
    this.showLabels = v;
    for (const n of this.nodes) {
      const labelObj = n.mesh?.children.find(c => c.isCSS2DObject);
      if (labelObj) labelObj.element.style.display = v ? '' : 'none';
    }
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
    if (!w || !h) return;
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

  /** Tints/dims a set of nodes to visually flag search matches, without disturbing highlightSubset. */
  markSearchMatches(matchIdSet) {
    for (const n of this.nodes) {
      const mat = n.mesh.material;
      const isMatch = matchIdSet.has(n.id);
      mat.emissiveIntensity = n.isHub ? 0.25 : (isMatch ? 0.9 : 0.2);
      mat.opacity = matchIdSet.size === 0 || n.isHub ? 1 : (isMatch ? 1 : 0.25);
      mat.transparent = true;
      const labelObj = n.mesh.children.find(c => c.isCSS2DObject);
      if (labelObj) labelObj.element.style.opacity = matchIdSet.size === 0 || n.isHub || isMatch ? '1' : '0.3';
    }
  }
  clearSearchMatches() { this.clearHighlight(); }

  clearHighlight() {
    if (!this._highlightActive) {
      // still reset opacity in case markSearchMatches was used without highlightSubset
    }
    this._highlightActive = false;
    for (const n of this.nodes) {
      const mat = n.mesh.material;
      const baseColor = n.isHub ? COLORS.hub : COLORS[n.type];
      mat.color.setHex(baseColor);
      mat.emissive.setHex(n.isHub || n.isExpanded ? COLORS.hubEdge : baseColor);
      mat.emissiveIntensity = n.isHub ? 0.25 : (n.isExpanded ? 0.55 : 0.35);
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

  /**
   * Rebuilds meshes for the new node/edge list. Meshes are still recreated
   * (Three.js doesn't make in-place mesh diffing worthwhile here), but
   * positions are NOT randomized for nodes that already existed (matched
   * by id, since main.js builds fresh JS objects every render) — they keep
   * their last known spot, so the graph doesn't visually reset on every
   * expand/collapse or hide/show. Genuinely new nodes spawn tightly around
   * their parent's current position instead of randomly, so a freshly
   * expanded folder's children appear clustered next to it immediately.
   */
  setData(nodes, edges) {
    const oldPositions = new Map();
    for (const n of this.nodes) oldPositions.set(n.id, { x: n.x, y: n.y, z: n.z });
    this.clear();

    const parentOf = new Map();
    for (const e of edges) parentOf.set(e.b, e.a);
    const placed = new Map(); // id -> {x,y,z}, filled in nodes' array order (parent-before-children)

    nodes.forEach((n) => {
      if (n.isHub) {
        n.x = 0; n.y = 0; n.z = 0;
      } else {
        const old = oldPositions.get(n.id);
        if (old) {
          n.x = old.x; n.y = old.y; n.z = old.z;
        } else {
          const pid = parentOf.get(n.id);
          const parentPos = pid === 'hub' ? { x: 0, y: 0, z: 0 } : (placed.get(pid) || oldPositions.get(pid) || { x: 0, y: 0, z: 0 });
          const phi = Math.acos(2 * Math.random() - 1);
          const theta = Math.random() * Math.PI * 2;
          const rad = 26 + Math.random() * 16;
          n.x = parentPos.x + rad * Math.sin(phi) * Math.cos(theta);
          n.y = parentPos.y + rad * Math.sin(phi) * Math.sin(theta);
          n.z = parentPos.z + rad * Math.cos(phi);
        }
      }
      n.vx = 0; n.vy = 0; n.vz = 0;
      placed.set(n.id, { x: n.x, y: n.y, z: n.z });

      const color = n.isHub ? COLORS.hub : COLORS[n.type];
      const geo = new THREE.SphereGeometry(n.r, 20, 16);
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.45,
        metalness: 0.05,
        emissive: n.isHub || n.isExpanded ? COLORS.hubEdge : color,
        emissiveIntensity: n.isHub ? 0.25 : (n.isExpanded ? 0.55 : 0.35)
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(n.x, n.y, n.z);
      mesh.userData = n;
      this.scene.add(mesh);
      n.mesh = mesh;

      const div = document.createElement('div');
      div.className = 'node-label' + (n.isHub ? ' hub-label' : '');
      if (!this.showLabels) div.style.display = 'none';
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

    // index nodes by id once per setData rather than re-scanning arrays every physics step
    this._nodeById = new Map(nodes.map(n => [n.id, n]));
  }

  _tick() {
    if (!this.reduceMotion) this._step();
    this._updateEdgeGeometry();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this._tick());
  }

  _step() {
    const nodes = this.nodes;
    const { repel, springLength, damping, gravity } = this.physics;

    // Rebuild the spatial grid each frame (cheap relative to the O(n^2) it replaces).
    this._grid.clear();
    for (const n of nodes) this._grid.insert(n);

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      let fx = 0, fy = 0, fz = 0;
      for (const b of this._grid.neighbors(a)) {
        if (a === b) continue;
        let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 4) d2 = 4;
        if (d2 > 40000) continue; // outside meaningful repulsion range (matches ~3 cell radius)
        const d = Math.sqrt(d2);
        const f = repel / d2;
        fx += (dx / d) * f;
        fy += (dy / d) * f;
        fz += (dz / d) * f;
      }
      fx += -a.x * gravity;
      fy += -a.y * gravity;
      fz += -a.z * gravity;
      a._fx = fx; a._fy = fy; a._fz = fz;
    }
    for (const e of this.edges) {
      const a = this._nodeById.get(e.a);
      const b = this._nodeById.get(e.b);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const f = 0.02 * (d - springLength);
      const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
      a._fx += fx; a._fy += fy; a._fz += fz;
      b._fx -= fx; b._fy -= fy; b._fz -= fz;
    }
    for (const n of nodes) {
      if (n.isHub) { n.x = 0; n.y = 0; n.z = 0; n.mesh.position.set(0, 0, 0); continue; }
      n.vx = (n.vx + n._fx * 0.02) * damping;
      n.vy = (n.vy + n._fy * 0.02) * damping;
      n.vz = (n.vz + n._fz * 0.02) * damping;
      n.x += n.vx; n.y += n.vy; n.z += n.vz;
      const dist = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
      if (dist > this.maxRadius) {
        const s = this.maxRadius / dist;
        n.x *= s; n.y *= s; n.z *= s;
      }
      n.mesh.position.set(n.x, n.y, n.z);
    }
  }

  _updateEdgeGeometry() {
    const attr = this.edgeLines.geometry.getAttribute('position');
    if (!attr || !this._nodeById) return;
    const arr = attr.array;
    let i = 0;
    for (const e of this.edges) {
      const a = this._nodeById.get(e.a);
      const b = this._nodeById.get(e.b);
      if (!a || !b) { i += 6; continue; }
      arr[i++] = a.x; arr[i++] = a.y; arr[i++] = a.z;
      arr[i++] = b.x; arr[i++] = b.y; arr[i++] = b.z;
    }
    attr.needsUpdate = true;
  }

  destroy() {
    this._running = false;
    window.removeEventListener('resize', this._resize);
    this.clear();
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}
