/**
 * themes.js — built-in color presets + custom theme application.
 *
 * A theme is a flat map of CSS custom property names (without the leading
 * "--") to color values. Applying a theme just writes each entry onto
 * document.documentElement.style, so it's cheap and reversible.
 */

export const THEME_VARS = [
  'bg', 'bg-panel', 'bg-panel-2', 'line', 'text', 'text-dim',
  'purple', 'purple-dim', 'teal', 'amber', 'danger'
];

export const PRESETS = {
  midnight: {
    label: 'Midnight (default)',
    vars: {
      bg: '#14151b', 'bg-panel': '#1b1d26', 'bg-panel-2': '#21232f',
      line: '#2c2f3d', text: '#dfe1ea', 'text-dim': '#82869c',
      purple: '#9d7cf5', 'purple-dim': '#5a4d8c', teal: '#5ecfc4',
      amber: '#f5b56d', danger: '#e26a6a'
    }
  },
  light: {
    label: 'Light',
    vars: {
      bg: '#f4f5f9', 'bg-panel': '#ffffff', 'bg-panel-2': '#eef0f6',
      line: '#dcdfe8', text: '#20222c', 'text-dim': '#6b7086',
      purple: '#7b5fe0', 'purple-dim': '#c9bdf2', teal: '#1fa596',
      amber: '#d98c2b', danger: '#d1494a'
    }
  },
  forest: {
    label: 'Forest',
    vars: {
      bg: '#0f1a14', 'bg-panel': '#15251c', 'bg-panel-2': '#1b2e22',
      line: '#28402f', text: '#e2ede4', 'text-dim': '#84a08e',
      purple: '#7fd88f', 'purple-dim': '#3f6b49', teal: '#5ecfc4',
      amber: '#e0b465', danger: '#e2726a'
    }
  },
  sunset: {
    label: 'Sunset',
    vars: {
      bg: '#1c1218', 'bg-panel': '#25161e', 'bg-panel-2': '#2e1c26',
      line: '#432a37', text: '#f5e6ea', 'text-dim': '#a88793',
      purple: '#f56d9d', 'purple-dim': '#8c4d67', teal: '#5ecfc4',
      amber: '#f5a15c', danger: '#ff6b6b'
    }
  },
  mono: {
    label: 'Mono',
    vars: {
      bg: '#121212', 'bg-panel': '#1a1a1a', 'bg-panel-2': '#212121',
      line: '#333333', text: '#e8e8e8', 'text-dim': '#8a8a8a',
      purple: '#b0b0b0', 'purple-dim': '#5c5c5c', teal: '#c8c8c8',
      amber: '#dedede', danger: '#e26a6a'
    }
  },
  ocean: {
    label: 'Ocean',
    vars: {
      bg: '#0c1620', 'bg-panel': '#122232', 'bg-panel-2': '#172b3f',
      line: '#20415c', text: '#e1eef7', 'text-dim': '#7fa2bd',
      purple: '#5cb3f5', 'purple-dim': '#2f608c', teal: '#4de0c8',
      amber: '#f5c66d', danger: '#f27979'
    }
  }
};

/** Applies a full vars map to :root as inline custom properties. */
export function applyThemeVars(vars) {
  const root = document.documentElement.style;
  for (const key of THEME_VARS) {
    if (vars[key]) root.setProperty(`--${key}`, vars[key]);
  }
}

/** Resolves a theme setting ({preset} or {preset:'custom', custom:{...}}) to a vars map. */
export function resolveThemeVars(themeSetting) {
  if (!themeSetting || !themeSetting.preset) return PRESETS.midnight.vars;
  if (themeSetting.preset === 'custom') {
    return { ...PRESETS.midnight.vars, ...(themeSetting.custom || {}) };
  }
  const preset = PRESETS[themeSetting.preset];
  return preset ? preset.vars : PRESETS.midnight.vars;
}

/**
 * Maps a resolved theme vars map (from resolveThemeVars) onto the color
 * keys the graph engines understand (graph2d.js / graph3d.js COLORS).
 * This is what makes node/edge colors actually follow the active theme
 * instead of being stuck on the Midnight preset's hardcoded hex values.
 */
export function resolveGraphColors(vars) {
  return {
    hub: vars['bg-panel-2'],
    hubEdge: vars.purple,
    folder: vars.purple,
    bookmark: vars.teal,
    favorite: vars.amber,
    edge: vars.line,
    edgeHighlight: vars.danger,
    edgeDim: vars['bg-panel-2']
  };
}
