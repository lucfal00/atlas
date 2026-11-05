// Formatting and escaping helpers shared by views.

import { SCORES } from './logic.js';

const MONTHS = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Italian date range: '10–14 giu 2026', '30 giu – 2 lug 2026', '30 dic 2025 – 2 gen 2026'; one day → '10 giu 2026'. */
export function fmtRange(from, to) {
  const part = (k) => `${+k.slice(8)} ${MONTHS[+k.slice(5, 7) - 1].toLowerCase()}`;
  const y1 = from.slice(0, 4), y2 = (to || from).slice(0, 4);
  if (!to || to === from) return `${part(from)} ${y1}`;
  if (y1 !== y2) return `${part(from)} ${y1} – ${part(to)} ${y2}`;
  if (from.slice(0, 7) === to.slice(0, 7)) return `${+from.slice(8)}–${part(to)} ${y2}`;
  return `${part(from)} – ${part(to)} ${y2}`;
}

/** Month range: 'mar 2024', 'mar–apr 2024', 'dic 2023 – gen 2024'; '' without `from`. */
export function fmtMonths(from, to) {
  if (!from) return '';
  const m = (k) => MONTHS[+k.slice(5, 7) - 1].toLowerCase();
  const t = to || from, y1 = from.slice(0, 4), y2 = t.slice(0, 4);
  if (t === from) return `${m(from)} ${y1}`;
  return y1 === y2 ? `${m(from)}–${m(t)} ${y2}` : `${m(from)} ${y1} – ${m(t)} ${y2}`;
}

/** Five tappable stars per score category (edit and detail share the markup); `vals` = { cibo: 4, … }. */
export function starsHtml(vals) {
  return SCORES.map(({ key, label }) => `<div class="score" role="group" aria-label="${esc(label)}"><span>${esc(label)}</span><span class="stars">`
    + [1, 2, 3, 4, 5].map((n) => `<button type="button" class="star${(vals?.[key] || 0) >= n ? ' on' : ''}" data-score="${key}" data-n="${n}" aria-label="${esc(label)} ${n} su 5" aria-pressed="${vals?.[key] === n}">★</button>`).join('')
    + '</span></div>').join('');
}

export const PLUS = '<svg class="plus" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';

export const fmtShort = (key) => `${+key.slice(8)}/${+key.slice(5, 7)}`;
export const fmtFull = (key) => `${fmtShort(key)}/${key.slice(0, 4)}`;
export const fmtNum = (n) => n.toLocaleString('it-IT', { maximumFractionDigits: 2 });
/** Italian or plain number: '1.234,50' → 1234.5, '12,5' → 12.5, '12.5' → 12.5; anything else → NaN. */
export function parseNum(s) {
  let t = String(s).trim().replace(/\s/g, '');
  if (t.includes(',')) {
    if (t.lastIndexOf('.') > t.indexOf(',')) return NaN;   // '1,234.5' is ambiguous
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');   // '1.234' = 1234 (Italian grouping)
  return /^\d*\.?\d+$/.test(t) ? Number(t) : NaN;
}

// it-IT drops the thousands separator on 4-digit numbers unless grouping is forced: '1.234,50 €'.
const money = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', useGrouping: 'always' });

/** Euro amount, e.g. '1.234,50 €' (plain space before the sign). */
export const fmtMoney = (n) => money.format(n).replace(/ /g, ' ');
// ---- Categories ----------------------------------------------------------

/** Place categories in display order (spec §4.2). */
export const CATEGORIES = [
  { key: 'citta', label: 'Città' },
  { key: 'borgo', label: 'Borgo' },
  { key: 'natura', label: 'Natura' },
  { key: 'mare', label: 'Mare' },
  { key: 'montagna', label: 'Montagna' },
  { key: 'cultura', label: 'Cultura' },
  { key: 'ristorante', label: 'Ristorante' },
  { key: 'locale', label: 'Locale' },
  { key: 'alloggio', label: 'Alloggio' },
  { key: 'esperienza', label: 'Esperienza' },
  { key: 'altro', label: 'Altro' },
];

/** Label of a place category; unknown keys (imports) read as 'Altro'. */
export const catLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label ?? 'Altro';

// ---- Modal sheet and toast -------------------------------------------------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let current = null;                                  // the open sheet: { el, close }
let routeHook = false;

/**
 * Bottom sheet over the screen. `content`: HTML string (already escaped by the caller) or a Node.
 * Closes on backdrop tap, Esc, the × button, close(), or a route change; only one sheet at a time
 * (opening another closes the first). Returns { el, close }: `el` is the content container
 * (attach handlers / query it), `close()` is idempotent. `onClose` runs once, whatever closed it.
 */
export function openSheet(content, { onClose } = {}) {
  current?.close(true);
  if (!routeHook) {
    routeHook = true;
    addEventListener('hashchange', () => current?.close(true));
  }
  const opener = document.activeElement;
  const backdrop = Object.assign(document.createElement('div'), { className: 'sheet-backdrop' });
  const panel = Object.assign(document.createElement('div'), { className: 'sheet', tabIndex: -1 });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const head = Object.assign(document.createElement('div'), { className: 'sheet-head' });
  const x = Object.assign(document.createElement('button'), { type: 'button', className: 'sheet-close', textContent: '×' });
  x.setAttribute('aria-label', 'Chiudi');
  head.append(Object.assign(document.createElement('span'), { className: 'sheet-grab' }), x);
  const el = Object.assign(document.createElement('div'), { className: 'sheet-body' });
  if (typeof content === 'string') el.innerHTML = content;
  else el.append(content);
  const title = el.querySelector('h1, h2, h3');
  if (title) {
    title.id ||= 'sheet-title';
    panel.setAttribute('aria-labelledby', title.id);
  }
  panel.append(head, el);
  backdrop.append(panel);

  let closed = false;
  const api = {
    el,
    close(immediate = false) {                        // a click event passed as `immediate` counts as false
      if (closed) return;
      closed = true;
      if (current === api) current = null;
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('modal-open');
      backdrop.classList.remove('open');
      if (immediate === true) backdrop.remove();
      else setTimeout(() => backdrop.remove(), 250);
      if (opener && document.contains(opener)) opener.focus?.({ preventScroll: true });
      try {
        onClose?.();
      } catch (err) {
        console.error(err);
      }
    },
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();                            // the sheet takes the key: nothing underneath also reacts to Esc
      api.close();
    } else if (e.key === 'Tab') {                     // keep focus inside the sheet
      const items = [...panel.querySelectorAll(FOCUSABLE)];
      const at = items.indexOf(document.activeElement);
      if (!items.length) e.preventDefault();
      else if (e.shiftKey && at <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && (at === -1 || at === items.length - 1)) { e.preventDefault(); items[0].focus(); }
    }
  }
  let downOnBackdrop = false;                         // a drag that starts in the sheet must not close it
  backdrop.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => {
    const tap = downOnBackdrop && e.target === backdrop;
    downOnBackdrop = false;
    if (tap) api.close();
  });
  x.addEventListener('click', () => api.close());
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  panel.focus({ preventScroll: true });
  void panel.offsetHeight;                            // commit the closed position so the slide-in animates
  backdrop.classList.add('open');
  current = api;
  return api;
}

let toastEl = null;
let toastTimer = 0;

/** Short message above the tab bar, hidden after `ms` (default 2.6 s); a new one replaces it. Text only. */
export function toast(message, ms = 2600) {
  if (!toastEl) {
    toastEl = Object.assign(document.createElement('div'), { className: 'toast' });
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.append(toastEl);
  }
  toastEl.textContent = String(message ?? '');
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}
