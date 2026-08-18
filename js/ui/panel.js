/**
 * panel.js — renders the full Settings UI into any container element.
 * Used both as the slide-out right panel on the New Tab page and as the
 * body of the standalone options.html page, so all logic lives here once.
 */
import { getSettings, updateSettings, resetSettings, onSettingsChange } from '../core/settings.js';
import { PRESETS, THEME_VARS, applyThemeVars, resolveThemeVars } from '../core/themes.js';
import {
  exportToFile, importFromPayload, listBackups, restoreBackup,
  getHiddenSets, clearHidden
} from '../core/storage.js';
import { showToast } from './toast.js';

const TABS = ['Appearance', 'Graph', 'Visibility', 'Data', 'About'];

/**
 * @param {HTMLElement} root - element to render into (cleared first)
 * @param {object} opts { onGraphSettingsChange?: fn, standalone?: boolean }
 */
export function mountSettingsPanel(root, opts = {}) {
  root.innerHTML = '';
  root.classList.add('settings-panel');

  const tabBar = document.createElement('div');
  tabBar.className = 'settings-tabs';
  const body = document.createElement('div');
  body.className = 'settings-body';

  let activeTab = TABS[0];
  const panes = {};

  TABS.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'settings-tab-btn' + (tab === activeTab ? ' active' : '');
    btn.textContent = tab;
    btn.addEventListener('click', () => {
      activeTab = tab;
      tabBar.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      Object.entries(panes).forEach(([k, el]) => el.classList.toggle('hidden', k !== tab));
    });
    tabBar.appendChild(btn);
  });

  TABS.forEach(tab => {
    const pane = document.createElement('div');
    pane.className = 'settings-pane' + (tab === activeTab ? '' : ' hidden');
    panes[tab] = pane;
    body.appendChild(pane);
  });

  root.appendChild(tabBar);
  root.appendChild(body);

  renderAppearance(panes.Appearance, opts);
  renderGraph(panes.Graph, opts);
  renderVisibility(panes.Visibility, opts);
  renderData(panes.Data, opts);
  renderAbout(panes.About, opts);
}

/* ---------------- Appearance tab ---------------- */
function renderAppearance(pane, opts) {
  const s = getSettings();

  pane.innerHTML = `
    <h3>Theme</h3>
    <div class="preset-grid" id="presetGrid"></div>

    <div class="settings-row">
      <label class="settings-checkbox">
        <input type="checkbox" id="useCustomTheme" ${s.theme.preset === 'custom' ? 'checked' : ''}>
        Use custom colors instead
      </label>
    </div>

    <div id="customColors" class="custom-colors ${s.theme.preset === 'custom' ? '' : 'hidden'}"></div>

    <h3>Display</h3>
    <div class="settings-row">
      <label class="settings-checkbox">
        <input type="checkbox" id="showLabels" ${s.showLabels ? 'checked' : ''}>
        Show node labels
      </label>
    </div>
    <div class="settings-row">
      <label class="settings-checkbox">
        <input type="checkbox" id="reduceMotion" ${s.reduceMotion ? 'checked' : ''}>
        Reduce motion (freeze physics)
      </label>
    </div>
    <div class="settings-row">
      <label>Label density
        <select id="labelDensity">
          <option value="compact" ${s.labelDensity === 'compact' ? 'selected' : ''}>Compact</option>
          <option value="normal" ${s.labelDensity === 'normal' ? 'selected' : ''}>Normal</option>
          <option value="roomy" ${s.labelDensity === 'roomy' ? 'selected' : ''}>Roomy</option>
        </select>
      </label>
    </div>

    <h3>Sound</h3>
    <div class="settings-row">
      <label class="settings-checkbox">
        <input type="checkbox" id="soundEnabled" ${s.soundEnabled ? 'checked' : ''}>
        Enable sound effects
      </label>
    </div>
    <div class="settings-row">
      <label>Volume
        <input type="range" id="soundVolume" min="0" max="1" step="0.05" value="${s.soundVolume}">
      </label>
    </div>
  `;

  const presetGrid = pane.querySelector('#presetGrid');
  Object.entries(PRESETS).forEach(([key, preset]) => {
    const swatch = document.createElement('button');
    swatch.className = 'preset-swatch' + (s.theme.preset === key ? ' active' : '');
    swatch.title = preset.label;
    swatch.innerHTML = `
      <span class="swatch-colors">
        <i style="background:${preset.vars.bg}"></i><i style="background:${preset.vars.purple}"></i><i style="background:${preset.vars.teal}"></i><i style="background:${preset.vars.amber}"></i>
      </span>
      <span class="swatch-label">${preset.label}</span>
    `;
    swatch.addEventListener('click', async () => {
      pane.querySelector('#useCustomTheme').checked = false;
      pane.querySelector('#customColors').classList.add('hidden');
      presetGrid.querySelectorAll('.preset-swatch').forEach(b => b.classList.remove('active'));
      swatch.classList.add('active');
      const updated = await updateSettings({ theme: { preset: key, custom: null } });
      applyThemeVars(resolveThemeVars(updated.theme));
    });
    presetGrid.appendChild(swatch);
  });

  const customColorsEl = pane.querySelector('#customColors');
  const baseCustom = s.theme.custom || PRESETS.midnight.vars;
  THEME_VARS.forEach(key => {
    const row = document.createElement('label');
    row.className = 'color-row';
    row.innerHTML = `<span>${key}</span><input type="color" data-var="${key}" value="${toHex(baseCustom[key])}">`;
    customColorsEl.appendChild(row);
  });
  customColorsEl.addEventListener('input', async (e) => {
    if (e.target.dataset.var) {
      const current = getSettings().theme.custom || { ...baseCustom };
      current[e.target.dataset.var] = e.target.value;
      const updated = await updateSettings({ theme: { preset: 'custom', custom: current } });
      applyThemeVars(resolveThemeVars(updated.theme));
    }
  });

  pane.querySelector('#useCustomTheme').addEventListener('change', async (e) => {
    presetGrid.querySelectorAll('.preset-swatch').forEach(b => b.classList.remove('active'));
    customColorsEl.classList.toggle('hidden', !e.target.checked);
    if (e.target.checked) {
      const custom = getSettings().theme.custom || { ...baseCustom };
      const updated = await updateSettings({ theme: { preset: 'custom', custom } });
      applyThemeVars(resolveThemeVars(updated.theme));
    } else {
      const updated = await updateSettings({ theme: { preset: 'midnight', custom: null } });
      applyThemeVars(resolveThemeVars(updated.theme));
      presetGrid.querySelector('.preset-swatch')?.classList.add('active');
    }
  });

  pane.querySelector('#showLabels').addEventListener('change', async (e) => {
    const updated = await updateSettings({ showLabels: e.target.checked });
    opts.onGraphSettingsChange?.(updated);
  });
  pane.querySelector('#reduceMotion').addEventListener('change', async (e) => {
    const updated = await updateSettings({ reduceMotion: e.target.checked });
    opts.onGraphSettingsChange?.(updated);
  });
  pane.querySelector('#labelDensity').addEventListener('change', async (e) => {
    document.documentElement.dataset.labelDensity = e.target.value;
    await updateSettings({ labelDensity: e.target.value });
  });
  pane.querySelector('#soundEnabled').addEventListener('change', async (e) => {
    const updated = await updateSettings({ soundEnabled: e.target.checked });
    opts.onGraphSettingsChange?.(updated);
  });
  pane.querySelector('#soundVolume').addEventListener('input', async (e) => {
    const updated = await updateSettings({ soundVolume: parseFloat(e.target.value) });
    opts.onGraphSettingsChange?.(updated);
  });
}

function toHex(v) {
  if (!v) return '#000000';
  if (v.startsWith('#')) return v.length === 7 ? v : '#000000';
  return '#000000';
}

/* ---------------- Graph tab ---------------- */
function renderGraph(pane, opts) {
  const s = getSettings();
  pane.innerHTML = `
    <h3>Rendering mode</h3>
    <div class="settings-row toggle-pair">
      <button class="mode-toggle-btn ${s.graphMode === '3d' ? 'active' : ''}" data-mode="3d">🌐 3D</button>
      <button class="mode-toggle-btn ${s.graphMode === '2d' ? 'active' : ''}" data-mode="2d">📐 2D (faster)</button>
    </div>
    <p class="settings-hint">2D mode uses less GPU and is easier to navigate with very large trees.</p>

    <h3>Physics</h3>
    <div class="settings-row">
      <label>Repulsion strength <span class="val" id="valRepel">${s.physics.repel}</span>
        <input type="range" id="repel" min="2000" max="60000" step="1000" value="${s.physics.repel}">
      </label>
    </div>
    <div class="settings-row">
      <label>Edge length <span class="val" id="valSpring">${s.physics.springLength}</span>
        <input type="range" id="springLength" min="40" max="300" step="5" value="${s.physics.springLength}">
      </label>
    </div>
    <div class="settings-row">
      <label>Damping <span class="val" id="valDamping">${s.physics.damping}</span>
        <input type="range" id="damping" min="0.6" max="0.98" step="0.01" value="${s.physics.damping}">
      </label>
    </div>
    <div class="settings-row">
      <label>Gravity (pull to center) <span class="val" id="valGravity">${s.physics.gravity}</span>
        <input type="range" id="gravity" min="0" max="0.01" step="0.0002" value="${s.physics.gravity}">
      </label>
    </div>
    <button class="ghost-btn" id="resetPhysics">Reset physics to defaults</button>

    <h3>Performance</h3>
    <div class="settings-row">
      <label>Max visible nodes at once (0 = unlimited) <span class="val" id="valMaxNodes">${s.maxVisibleNodes || 'Unlimited'}</span>
        <input type="range" id="maxVisibleNodes" min="0" max="300" step="10" value="${s.maxVisibleNodes}">
      </label>
    </div>
  `;

  pane.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      pane.querySelectorAll('.mode-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const updated = await updateSettings({ graphMode: btn.dataset.mode });
      opts.onGraphSettingsChange?.(updated, { modeChanged: true });
    });
  });

  const sliderMap = [
    ['repel', 'valRepel', v => v],
    ['springLength', 'valSpring', v => v],
    ['damping', 'valDamping', v => v],
    ['gravity', 'valGravity', v => v]
  ];
  sliderMap.forEach(([id, valId]) => {
    pane.querySelector('#' + id).addEventListener('input', async (e) => {
      const v = parseFloat(e.target.value);
      pane.querySelector('#' + valId).textContent = v;
      const key = id === 'repel' ? 'repel' : id === 'springLength' ? 'springLength' : id === 'damping' ? 'damping' : 'gravity';
      const updated = await updateSettings({ physics: { [key]: v } });
      opts.onGraphSettingsChange?.(updated);
    });
  });

  pane.querySelector('#resetPhysics').addEventListener('click', async () => {
    const defaults = { repel: 26000, springLength: 130, damping: 0.86, gravity: 0.0022 };
    const updated = await updateSettings({ physics: defaults });
    opts.onGraphSettingsChange?.(updated);
    renderGraph(pane, opts);
  });

  pane.querySelector('#maxVisibleNodes').addEventListener('input', async (e) => {
    const v = parseInt(e.target.value, 10);
    pane.querySelector('#valMaxNodes').textContent = v || 'Unlimited';
    const updated = await updateSettings({ maxVisibleNodes: v });
    opts.onGraphSettingsChange?.(updated, { needsRerender: true });
  });
}

/* ---------------- Visibility tab ---------------- */
async function renderVisibility(pane, opts) {
  pane.innerHTML = `
    <h3>Hidden items</h3>
    <p class="settings-hint">Right-click any node in the graph and choose "Hide" to declutter without deleting anything. Manage what's hidden here.</p>
    <div id="hiddenLists"></div>
  `;
  await refreshHiddenLists(pane, opts);
}

async function refreshHiddenLists(pane, opts) {
  const sets = await getHiddenSets();
  const container = pane.querySelector('#hiddenLists');
  container.innerHTML = '';
  for (const modeKey of ['favorites', 'bookmarks']) {
    const ids = sets[modeKey] || [];
    const block = document.createElement('div');
    block.className = 'hidden-block';
    block.innerHTML = `
      <div class="hidden-block-header">
        <strong>${modeKey === 'favorites' ? '⭐ Favorites' : '📁 Bookmarks'}</strong>
        <span class="settings-hint">${ids.length} hidden</span>
      </div>
    `;
    const btn = document.createElement('button');
    btn.className = 'ghost-btn';
    btn.textContent = 'Show all in ' + modeKey;
    btn.disabled = ids.length === 0;
    btn.addEventListener('click', async () => {
      await clearHidden(modeKey);
      showToast(`All ${modeKey} nodes are visible again.`, { type: 'success' });
      opts.onGraphSettingsChange?.(getSettings(), { needsRerender: true });
      await refreshHiddenLists(pane, opts);
    });
    block.appendChild(btn);
    container.appendChild(block);
  }
}

/* ---------------- Data tab ---------------- */
async function renderData(pane, opts) {
  const s = getSettings();
  pane.innerHTML = `
    <h3>Backup &amp; restore</h3>
    <div class="settings-row">
      <label class="settings-checkbox">
        <input type="checkbox" id="autoBackupEnabled" ${s.autoBackupEnabled ? 'checked' : ''}>
        Keep automatic local backups
      </label>
    </div>
    <div class="settings-row">
      <label>Backups to keep <span class="val" id="valKeep">${s.autoBackupKeep}</span>
        <input type="range" id="autoBackupKeep" min="3" max="30" step="1" value="${s.autoBackupKeep}">
      </label>
    </div>
    <div id="backupList" class="backup-list"></div>

    <h3>Export / Import</h3>
    <div class="settings-row">
      <label>Remind me to export every <span class="val" id="valReminder">${s.exportReminderDays}</span> days
        <input type="range" id="exportReminderDays" min="0" max="60" step="1" value="${s.exportReminderDays}">
      </label>
    </div>
    <button class="primary-btn" id="exportBtn">⬇️ Export everything to a file</button>
    <label class="ghost-btn file-btn">
      ⬆️ Import from a file
      <input type="file" id="importFile" accept="application/json" class="hidden">
    </label>
    <div class="settings-row" id="importModeRow" style="display:none">
      <label class="settings-checkbox">
        <input type="checkbox" id="importReplace">
        Replace everything instead of merging
      </label>
      <button class="primary-btn" id="confirmImportBtn">Import now</button>
    </div>
    <p class="settings-hint" id="lastExportHint"></p>
  `;

  pane.querySelector('#autoBackupEnabled').addEventListener('change', async (e) => {
    await updateSettings({ autoBackupEnabled: e.target.checked });
  });
  pane.querySelector('#autoBackupKeep').addEventListener('input', async (e) => {
    pane.querySelector('#valKeep').textContent = e.target.value;
    await updateSettings({ autoBackupKeep: parseInt(e.target.value, 10) });
  });
  pane.querySelector('#exportReminderDays').addEventListener('input', async (e) => {
    pane.querySelector('#valReminder').textContent = e.target.value;
    await updateSettings({ exportReminderDays: parseInt(e.target.value, 10) });
  });

  pane.querySelector('#exportBtn').addEventListener('click', async () => {
    await exportToFile();
    showToast('Exported to your Downloads folder.', { type: 'success' });
    updateLastExportHint(pane);
  });

  let pendingFile = null;
  pane.querySelector('#importFile').addEventListener('change', (e) => {
    pendingFile = e.target.files[0] || null;
    pane.querySelector('#importModeRow').style.display = pendingFile ? 'flex' : 'none';
  });
  pane.querySelector('#confirmImportBtn').addEventListener('click', async () => {
    if (!pendingFile) return;
    try {
      const text = await pendingFile.text();
      const payload = JSON.parse(text);
      const replace = pane.querySelector('#importReplace').checked;
      await importFromPayload(payload, { mode: replace ? 'replace' : 'merge' });
      showToast('Import complete.', { type: 'success' });
      opts.onGraphSettingsChange?.(getSettings(), { needsRerender: true, needsFullReload: true });
      pane.querySelector('#importModeRow').style.display = 'none';
      pendingFile = null;
    } catch (err) {
      showToast('Import failed: ' + err.message, { type: 'error', duration: 6000 });
    }
  });

  await refreshBackupList(pane, opts);
  updateLastExportHint(pane);
}

function updateLastExportHint(pane) {
  const s = getSettings();
  const hint = pane.querySelector('#lastExportHint');
  if (!hint) return;
  hint.textContent = s.lastExportAt
    ? `Last exported ${new Date(s.lastExportAt).toLocaleString()}`
    : 'You haven\u2019t exported a backup file yet.';
}

async function refreshBackupList(pane, opts) {
  const backups = await listBackups();
  const listEl = pane.querySelector('#backupList');
  if (!backups.length) {
    listEl.innerHTML = '<p class="settings-hint">No automatic backups yet — they\'re created whenever you add, edit, or delete favorites.</p>';
    return;
  }
  listEl.innerHTML = '';
  backups.slice(0, 10).forEach(b => {
    const row = document.createElement('div');
    row.className = 'backup-row';
    const date = new Date(b.ts);
    row.innerHTML = `<span>${date.toLocaleString()} <span class="settings-hint">(${b.tree.length} items)</span></span>`;
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'ghost-btn';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', async () => {
      if (!confirm(`Restore favorites to the snapshot from ${date.toLocaleString()}? This replaces your current favorites.`)) return;
      await restoreBackup(b.ts);
      showToast('Restored from backup.', { type: 'success' });
      opts.onGraphSettingsChange?.(getSettings(), { needsRerender: true, needsFullReload: true });
    });
    row.appendChild(restoreBtn);
    listEl.appendChild(row);
  });
}

/* ---------------- About tab ---------------- */
function renderAbout(pane) {
  pane.innerHTML = `
    <h3>Graph Home Advanced</h3>
    <p class="settings-hint">A themeable, force-directed graph New Tab page for your bookmarks and favorites — 2D/3D rendering, deep customization, and local backups so your data stays safe.</p>
    <p class="settings-hint">No data ever leaves your browser. Favorites are stored in <code>chrome.storage.local</code>; Bookmarks mode reads/writes your real Chrome bookmarks directly.</p>
    <button class="ghost-btn" id="resetAllBtn">Reset all settings to defaults</button>
  `;
  pane.querySelector('#resetAllBtn').addEventListener('click', async () => {
    if (!confirm('Reset all appearance, graph, and data settings to their defaults? This does not delete your favorites.')) return;
    await resetSettings();
    location.reload();
  });
}
