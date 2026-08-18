/**
 * toast.js — tiny non-blocking notification stack, used for save
 * confirmations, import results, and the periodic export reminder.
 */
let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.id = 'toastStack';
  document.body.appendChild(container);
  return container;
}

/**
 * @param {string} message
 * @param {object} opts { type: 'info'|'success'|'warn'|'error', duration, actionLabel, onAction }
 */
export function showToast(message, opts = {}) {
  const { type = 'info', duration = 4200, actionLabel = null, onAction = null } = opts;
  const c = ensureContainer();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);

  if (actionLabel) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => { onAction && onAction(); dismiss(); });
    el.appendChild(btn);
  }
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '✕';
  close.addEventListener('click', () => dismiss());
  el.appendChild(close);

  c.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  let timer = duration > 0 ? setTimeout(dismiss, duration) : null;
  function dismiss() {
    if (timer) clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  }
  return dismiss;
}
