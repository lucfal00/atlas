// Formatting and escaping helpers shared by views and charts.
import { fromKey, COST_CATS as COST_KEYS } from './logic.js';

// Order validated for adjacent-pair separation (dataviz validate_palette.js); identity also carried by label.
export const COLORS = ['#6366f1', '#14b8a6', '#f43f5e', '#f59e0b', '#0ea5e9', '#a855f7', '#22c55e', '#f97316'];
export const DAY_SHORT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
export const MONTHS = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Colours may come from an imported file: only allow #rrggbb. */
export const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : COLORS[0]);

/** Links come from user input or imports: only http(s) URLs; anything else → null. */
export function safeUrl(u) {
  const s = String(u ?? '').trim();
  try {
    const p = new URL(s).protocol;
    return p === 'http:' || p === 'https:' ? s : null;
  } catch {
    return null;
  }
}

const dayFmt = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const fmtDay = (key) => cap(dayFmt.format(fromKey(key)));
export const fmtShort = (key) => `${+key.slice(8)}/${+key.slice(5, 7)}`;
export const fmtFull = (key) => `${fmtShort(key)}/${key.slice(0, 4)}`;
export const fmtNum = (n) => n.toLocaleString('it-IT', { maximumFractionDigits: 2 });
export const pct = (f) => (f == null ? '–' : `${Math.round(f * 100)}%`);
export const parseNum = (s) => parseFloat(String(s).replace(',', '.'));

// it-IT drops the thousands separator on 4-digit numbers unless grouping is forced: '1.234,50 €', '1.234 km'.
const money = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', useGrouping: 'always' });
const whole = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0, useGrouping: 'always' });

/** Euro amount, e.g. '1.234,50 €' (plain space before the sign). */
export const fmtMoney = (n) => money.format(n).replace(/ /g, ' ');

/** Distance rounded to whole km, e.g. '1.234 km'. */
export const fmtKm = (n) => `${whole.format(n)} km`;

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

const COST_LABEL = { trasporti: 'Trasporti', alloggio: 'Alloggio', cibo: 'Cibo', attivita: 'Attività', altro: 'Altro' };

/** Trip cost categories in the order of logic.COST_CATS. */
export const COST_CATS = COST_KEYS.map((key) => ({ key, label: COST_LABEL[key] ?? key }));
