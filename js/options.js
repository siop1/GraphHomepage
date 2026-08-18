import { loadSettings, getSettings, onSettingsChange } from './core/settings.js';
import { applyThemeVars, resolveThemeVars } from './core/themes.js';
import { mountSettingsPanel } from './ui/panel.js';

async function init() {
  const settings = await loadSettings();
  applyThemeVars(resolveThemeVars(settings.theme));
  document.documentElement.dataset.labelDensity = settings.labelDensity;

  const root = document.getElementById('optionsPanelRoot');
  mountSettingsPanel(root, { standalone: true });

  onSettingsChange((s) => {
    applyThemeVars(resolveThemeVars(s.theme));
    document.documentElement.dataset.labelDensity = s.labelDensity;
  });
}

init();
