/**
 * graph2d.js — a lighter, faster alternative to the 3D engine, rendered
 * with plain Canvas 2D. Same public API as Graph3D (setData, clear,
 * highlightSubset/clearHighlight, markSearchMatches, onNode* callbacks,
 * destroy) so main.js can swap between them without branching UI logic.
 *
 * Physics reuses the same repel/spring/gravity/damping model, projected to
 * a plane, and also benefits from the spatial-grid neighbor lookup for
 * large trees. Pan (drag empty space) and zoom (wheel) are supported.
 */

// Mutable in place (not reassigned) so setColors() can re-theme an active
// instance without needing to rebuild the canvas or re-issue setData().
const COLORS = {
  hub: '#2a2c3a',
  hubEdge: '#9d7cf5',
  folder: '#9d7cf5',
  bookmark: '#5ecfc4',
  favorite: '#f5b56d',
  edge: '#3a3d4e',
  edgeHighlight: '#ff5c5c',
  edgeDim: '#22242e'
};

class SpatialGrid2D {
  constructor(cellSize) { this.cellSize = cellSize; this.map = new Map(); }
  _key(cx, cy) { return `${cx},${cy}`; }
  clear() { this.map.clear(); }
  insert(node) {
    const cx = Math.floor(node.x / this.cellSize);
    const cy = Math.floor(node.y / this.cellSize);
    const k = this._key(cx, cy);
    let bucket = this.map.get(k);
    if (!bucket) { bucket = []; this.map.set(k, bucket); }
    bucket.push(node);
    node._cell = [cx, cy];
  }
  *neighbors(node) {
    const [cx, cy] = node._cell;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.map.get(this._key(cx + dx, cy + dy));
        if (bucket) for (const n of bucket) yield n;
      }
    }
  }
}

export class Graph2D {
  constructor(container, opts = {}) {
    this.container = container;
    this.nodes = [];
    this.edges = [];
    this.onNodeActivate = null;
    this.onNodeEdit = null;
    this.onNodeHover = null;
    this.onNodeContext = null;

    // Defaults kept identical to DEFAULT_SETTINGS.physics in core/settings.js
    // so a standalone Graph2D (no opts.physics passed) behaves the same as
    // one driven by the app's settings.
    this.physics = { repel: 26000, springLength: 130, damping: 0.86, gravity: 0.0022, ...opts.physics };
    this.reduceMotion = !!opts.reduceMotion;
    this.showLabels = opts.showLabels !== false;

    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.cam = { x: 0, y: 0, zoom: 1 };
    this._grid = new SpatialGrid2D(110);
    this._hovered = null;
    this._dragStart = null;
    this._didDrag = false;
    this._dragNode = null;
    this._dragDescendants = null;
    this._dragStartWorld = null;
    this._dragStartPositions = null;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();

    this.canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const hit = this._pick(e);
      if (hit && !hit.isHub) {
        // Grab a node: drag it (and its whole expanded subtree) around
        // the canvas instead of panning the camera. A plain click (no
        // real movement) still falls through to onNodeActivate on pointerup.
        this._dragNode = hit;
        this._dragDescendants = this._collectDescendants(hit.id);
        this._dragStartWorld = this._pointerWorld(e);
        this._dragStartPositions = new Map();
        this._dragStartPositions.set(hit.id, { x: hit.x, y: hit.y });
        for (const d of this._dragDescendants) this._dragStartPositions.set(d.id, { x: d.x, y: d.y });
        this._didDrag = false;
      } else {
        this._dragStart = { x: e.clientX, y: e.clientY, camX: this.cam.x, camY: this.cam.y };
        this._didDrag = false;
      }
    });
    window.addEventListener('pointermove', e => {
      if (this._dragNode) {
        const w = this._pointerWorld(e);
        const dx = w.x - this._dragStartWorld.x, dy = w.y - this._dragStartWorld.y;
        if (Math.hypot(dx, dy) * this.cam.zoom > 4) this._didDrag = true;
        if (this._didDrag) {
          const startSelf = this._dragStartPositions.get(this._dragNode.id);
          this._dragNode.x = startSelf.x + dx;
          this._dragNode.y = startSelf.y + dy;
          this._dragNode.vx = 0; this._dragNode.vy = 0;
          for (const d of this._dragDescendants) {
            const sp = this._dragStartPositions.get(d.id);
            d.x = sp.x + dx; d.y = sp.y + dy;
            d.vx = 0; d.vy = 0;
          }
          this.canvas.style.cursor = 'grabbing';
        }
        return;
      }
      if (this._dragStart) {
        const dx = e.clientX - this._dragStart.x, dy = e.clientY - this._dragStart.y;
        if (Math.hypot(dx, dy) > 4) this._didDrag = true;
        if (this._didDrag) {
          this.cam.x = this._dragStart.camX - dx / this.cam.zoom;
          this.cam.y = this._dragStart.camY - dy / this.cam.zoom;
        }
      }
      const hit = this._pick(e);
      if (hit !== this._hovered) {
        this._hovered = hit;
        this.canvas.style.cursor = hit ? 'pointer' : (this._dragStart ? 'grabbing' : 'grab');
        if (hit && this.onNodeHover) this.onNodeHover(hit);
      }
    });
    window.addEventListener('pointerup', e => {
      if (this._dragNode) {
        const node = this._dragNode, wasDrag = this._didDrag;
        if (wasDrag) node.pinned = true; // stays exactly where it was dropped; descendants keep following it via springs
        this._dragNode = null; this._dragDescendants = null; this._dragStartWorld = null; this._dragStartPositions = null;
        if (!wasDrag && this.onNodeActivate) this.onNodeActivate(node);
        return;
      }
      if (!this._dragStart) return;
      const wasDrag = this._didDrag;
      this._dragStart = null;
      if (wasDrag) return;
      const hit = this._pick(e);
      if (hit && this.onNodeActivate) this.onNodeActivate(hit);
    });
    this.canvas.addEventListener('contextmenu', e => {
      const hit = this._pick(e);
      if (hit) {
        e.preventDefault();
        if (this.onNodeContext) this.onNodeContext(hit, e.clientX, e.clientY);
      }
    });
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0012);
      this.cam.zoom = Math.min(3, Math.max(0.25, this.cam.zoom * factor));
    }, { passive: false });

    requestAnimationFrame(() => this._tick());
  }

  setPhysics(patch) { this.physics = { ...this.physics, ...patch }; }
  setReduceMotion(v) { this.reduceMotion = v; }
  setShowLabels(v) { this.showLabels = v; }

  /**
   * Re-theme node/edge colors in place. `vars` is any subset of COLORS keys
   * mapped to CSS color strings (typically derived from the active theme
   * via themes.js#resolveGraphColors). No re-render call needed — _draw()
   * reads COLORS fresh every frame.
   */
  setColors(vars = {}) {
    Object.assign(COLORS, vars);
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w; this._h = h;
  }

  _worldToScreen(x, y) {
    return {
      x: (x - this.cam.x) * this.cam.zoom + this._w / 2,
      y: (y - this.cam.y) * this.cam.zoom + this._h / 2
    };
  }
  _screenToWorld(sx, sy) {
    return {
      x: (sx - this._w / 2) / this.cam.zoom + this.cam.x,
      y: (sy - this._h / 2) / this.cam.zoom + this.cam.y
    };
  }
  _pointerWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return this._screenToWorld(e.clientX - r.left, e.clientY - r.top);
  }

  _pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const w = this._screenToWorld(e.clientX - r.left, e.clientY - r.top);
    let best = null, bestD = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d <= n.r + 4 && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  clear() {
    this.nodes = [];
    this.edges = [];
    this._hovered = null;
  }

  /**
   * Rebuilds the node/edge list. Unlike a naive rebuild, this does NOT
   * reshuffle everything on screen: any node that already existed (matched
   * by id — main.js constructs fresh JS objects every render, so identity
   * always changes but id is stable) keeps its current position, velocity,
   * and pinned state. Only genuinely new nodes get an initial position —
   * and that position is close to their parent's *current* position
   * (rather than random-near-origin), so a freshly expanded folder's
   * children appear clustered next to it immediately instead of drifting
   * in from scattered spawn points. This is what makes expand/collapse
   * (and other soft refreshes like hide/show) feel like an in-place update
   * rather than a full page reload of the graph.
   */
  setData(nodes, edges) {
    const oldById = this._nodeById || new Map();
    const parentOf = new Map();
    for (const e of edges) parentOf.set(e.b, e.a);
    const placed = new Map(); // id -> {x,y}, filled in nodes' array order

    for (const n of nodes) {
      if (n.isHub) {
        n.x = 0; n.y = 0; n.vx = 0; n.vy = 0;
        placed.set(n.id, { x: 0, y: 0 });
        continue;
      }
      const old = oldById.get(n.id);
      if (old) {
        n.x = old.x; n.y = old.y; n.vx = old.vx || 0; n.vy = old.vy || 0;
        if (old.pinned) n.pinned = true;
      } else {
        // Brand-new node: spawn tightly around its parent's position.
        // nodes[] is built in parent-before-children order (see
        // buildExpandableFavTree/buildExpandableBookmarkTree in main.js),
        // so the parent's spot is already in `placed` by the time we get
        // here, even for multi-level expansions done in one render.
        const pid = parentOf.get(n.id);
        const parentPos = pid === 'hub' ? { x: 0, y: 0 } : (placed.get(pid) || { x: 0, y: 0 });
        const a = Math.random() * Math.PI * 2;
        const rad = 35 + Math.random() * 20;
        n.x = parentPos.x + Math.cos(a) * rad;
        n.y = parentPos.y + Math.sin(a) * rad;
        n.vx = 0; n.vy = 0;
      }
      placed.set(n.id, { x: n.x, y: n.y });
    }

    this.nodes = nodes;
    this.edges = edges;
    this._nodeById = new Map(nodes.map(n => [n.id, n]));
    this._hovered = null;
    // Camera is intentionally left alone here — main.js calls resetCamera()
    // explicitly only for real navigation (drilling in/out, switching
    // mode/view), not for in-place updates like expand/collapse.
  }

  /** Recenters the camera. Call explicitly on real navigation (main.js decides when), not on every setData(). */
  resetCamera() {
    this.cam.x = 0; this.cam.y = 0;
  }

  /** All descendant nodes of `id` reachable via edges (parent -> child, per buildExpandableFavTree/buildExpandableBookmarkTree), for dragging a folder's whole subtree together. */
  _collectDescendants(id) {
    const childrenOf = new Map();
    for (const e of this.edges) {
      if (!childrenOf.has(e.a)) childrenOf.set(e.a, []);
      childrenOf.get(e.a).push(e.b);
    }
    const result = [];
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const childId of (childrenOf.get(cur) || [])) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        const node = this._nodeById.get(childId);
        if (node) { result.push(node); stack.push(childId); }
      }
    }
    return result;
  }

  highlightSubset(idSet, targetId) {
    this._highlightSet = idSet;
    this._highlightTarget = targetId;
  }
  markSearchMatches(matchIdSet) {
    this._searchSet = matchIdSet.size ? matchIdSet : null;
  }
  clearSearchMatches() { this._searchSet = null; }
  clearHighlight() { this._highlightSet = null; this._highlightTarget = null; }

  _tick() {
    if (!this.reduceMotion) this._step();
    this._draw();
    requestAnimationFrame(() => this._tick());
  }

  _step() {
    const nodes = this.nodes;
    const { repel, springLength, damping, gravity } = this.physics;
    this._grid.clear();
    for (const n of nodes) this._grid.insert(n);

    for (const a of nodes) {
      let fx = 0, fy = 0;
      for (const b of this._grid.neighbors(a)) {
        if (a === b) continue;
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 4) d2 = 4;
        if (d2 > 30000) continue;
        const d = Math.sqrt(d2);
        const f = repel / d2;
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }
      fx += -a.x * gravity;
      fy += -a.y * gravity;
      a._fx = fx; a._fy = fy;
    }
    for (const e of this.edges) {
      const a = this._nodeById.get(e.a), b = this._nodeById.get(e.b);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = 0.02 * (d - springLength);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a._fx += fx; a._fy += fy;
      b._fx -= fx; b._fy -= fy;
    }
    for (const n of nodes) {
      if (n.isHub) { n.x = 0; n.y = 0; continue; }
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; } // dropped by the user — stays exactly there
      n.vx = (n.vx + n._fx * 0.02) * damping;
      n.vy = (n.vy + n._fy * 0.02) * damping;
      n.x += n.vx; n.y += n.vy;
    }
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    if (!this.nodes.length) return;

    const hSet = this._highlightSet, sSet = this._searchSet;

    // edges
    ctx.lineWidth = 1.4;
    for (const e of this.edges) {
      const a = this._nodeById.get(e.a), b = this._nodeById.get(e.b);
      if (!a || !b) continue;
      const pa = this._worldToScreen(a.x, a.y), pb = this._worldToScreen(b.x, b.y);
      let color = COLORS.edge, alpha = 0.55;
      if (hSet) {
        color = (hSet.has(e.a) && hSet.has(e.b)) ? COLORS.edgeHighlight : COLORS.edgeDim;
        alpha = 0.85;
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // nodes
    for (const n of this.nodes) {
      const p = this._worldToScreen(n.x, n.y);
      const r = (n.r || 10) * this.cam.zoom;
      let fill = n.isHub ? COLORS.hub : COLORS[n.type];
      let alpha = 1;

      if (hSet) {
        const inSet = n.isHub || hSet.has(n.id);
        if (n.id === this._highlightTarget) fill = COLORS.edgeHighlight;
        alpha = inSet ? 1 : 0.15;
      } else if (sSet) {
        const isMatch = n.isHub || sSet.has(n.id);
        alpha = isMatch ? 1 : 0.2;
      }

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      if (n.isHub) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = COLORS.hubEdge;
        ctx.stroke();
      } else if (n.isExpanded) {
        // Ring around an unfolded folder so it's visually distinct from a
        // collapsed one, without needing a separate expand/collapse icon.
        ctx.lineWidth = 2;
        ctx.strokeStyle = COLORS.hubEdge;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (this.showLabels && this.cam.zoom > 0.35) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = (getComputedStyle(document.documentElement).getPropertyValue('--text') || '#dfe1ea').trim();
        ctx.font = `${n.isHub ? 'bold ' : ''}12px -apple-system, "Segoe UI", Inter, sans-serif`;
        ctx.textAlign = 'center';
        const label = n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label;
        ctx.fillText(label, p.x, p.y + r + 14);
      }
      ctx.globalAlpha = 1;
    }
  }

  destroy() {
    window.removeEventListener('resize', this._resize);
    this.container.innerHTML = '';
  }
}
