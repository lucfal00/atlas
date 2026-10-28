// SVG chart builders (return markup strings) and a shared hover/tap tooltip.
// Marks: 2px lines, 8px dots, 4px rounded bar tops on the baseline, 2px gaps; text uses text tokens only.
import { addDays, fromKey } from './logic.js';
import { esc, safeColor, fmtFull, fmtNum, pct, MONTHS, DAY_SHORT } from './ui.js';

const weekStart = (key) => addDays(key, -((fromKey(key).getDay() + 6) % 7));   // Monday of that week

const VAR_COLOR = /^var\(--[a-z0-9-]+\)$/;
/** Colours are inlined in style attributes: CSS tokens (`var(--x)`) or #rrggbb only, anything else → safeColor fallback. */
const paint = (c) => (VAR_COLOR.test(c) ? c : safeColor(c));

// ---- Progress ring -----------------------------------------------------

export function ring(f, color, size = 46, stroke = 5) {
  color = paint(color);
  const c = size / 2;
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, f || 0));
  const arc = v > 0
    ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" style="stroke:${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${(v * len).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`
    : '';
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" style="stroke:var(--track)" stroke-width="${stroke}"/>${arc}</svg>`;
}

// ---- Calendar heatmap (sequential: one hue, quantised opacity) --------

const STEPS = [0.35, 0.55, 0.78, 1];
const level = (v) => STEPS[Math.min(3, Math.ceil(v * 4) - 1)];

function cellStyle(v, color) {
  if (v == null) return 'fill:var(--empty)';
  if (v === 0) return 'fill:var(--track)';
  return `fill:${color};fill-opacity:${level(v)}`;
}

/** valueAt(key) → null (not applicable) | 0..1. Last 53 weeks ending with the week of `today`. */
export function heatmap(valueAt, color, today) {
  color = paint(color);
  const cell = 12;
  const step = cell + 3;
  const top = 18;
  const left = 30;
  const weeks = 53;
  const first = addDays(weekStart(today), -7 * (weeks - 1));
  let cells = '';
  let months = '';
  let lastMonth = -1;
  let lastX = -99;
  for (let w = 0; w < weeks; w++) {
    const ws = addDays(first, 7 * w);
    const x = left + w * step;
    const m = fromKey(ws).getMonth();
    if (m !== lastMonth && x - lastX >= 3 * step) {
      months += `<text x="${x}" y="11">${MONTHS[m]}</text>`;
      lastX = x;
    }
    lastMonth = m;
    for (let d = 0; d < 7; d++) {
      const k = addDays(ws, d);
      if (k > today) break;
      const v = valueAt(k);
      const tip = `${fmtFull(k)} · ${v == null ? 'nessun dato' : pct(v)}`;
      cells += `<rect x="${x}" y="${top + d * step}" width="${cell}" height="${cell}" rx="3" style="${cellStyle(v, color)}" data-tip="${esc(tip)}"/>`;
    }
  }
  const days = [0, 2, 4].map((d) => `<text x="0" y="${top + d * step + 10}">${DAY_SHORT[d]}</text>`).join('');
  const W = left + weeks * step;
  const H = top + 7 * step;
  const swatch = (v) => `<i style="background:${v == null ? 'var(--track)' : color};opacity:${v ?? 1}"></i>`;
  return `<div class="heat-scroll"><svg class="chart heatmap" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
      role="img" aria-label="Calendario degli ultimi 12 mesi">${months}${days}${cells}</svg></div>
    <div class="heat-legend">Meno ${swatch(null)}${STEPS.map(swatch).join('')} Più</div>`;
}

// ---- Shared axes frame -------------------------------------------------

const FRAME = { W: 320, H: 160, L: 36, R: 16, T: 14, B: 24 };

/** Labels: every point up to 12 (a full week / year); if the caller left some labels empty it chose them; else every k-th. */
function xLabels(points, x, h = FRAME.H) {
  const chosen = points.some((p) => !p.label);
  const every = points.length <= 12 ? 1 : Math.ceil(points.length / 6);
  return points.map((p, i) => ((chosen ? p.label : (points.length - 1 - i) % every === 0)
    ? `<text x="${x(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(p.label)}</text>` : '')).join('');
}

/** Equal slots across the plot width: point i sits in the middle of slot i. */
function slots(n) {
  const slot = (FRAME.W - FRAME.L - FRAME.R) / n;
  return { slot, x: (i) => FRAME.L + (i + 0.5) * slot };
}

// ---- Line: % over time (single series, no legend) ---------------------

/** points: [{ label, tip, value: null | 0..1 }]; one slot per point, so the axis is always complete.
 *  shade: colour each dot with the heatmap scale (same steps as "Meno → Più"). */
export function lineChart(points, color, ariaLabel, { shade = false } = {}) {
  color = paint(color);
  const { W, H, L, R, T } = FRAME;
  const ih = H - T - FRAME.B;
  const { x } = slots(points.length);
  const y = (v) => T + ih * (1 - v);
  const dotR = (points.length > 20 ? 3 : 4) + (shade ? 1.5 : 0);   // shaded dots need area to read the step
  const grid = [0, 0.5, 1].map((g) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/>
    <text x="${L - 6}" y="${y(g) + 3}" text-anchor="end">${g * 100}%</text>`).join('');
  let d = '';
  let pen = false;
  let dots = '';
  points.forEach((p, i) => {
    if (p.value == null) { pen = false; return; }
    const px = x(i).toFixed(1);
    const py = y(p.value).toFixed(1);
    d += `${pen ? 'L' : 'M'}${px} ${py}`;
    pen = true;
    // shaded: an opaque card disc underneath, so the line doesn't show through and the tint matches the heatmap cell
    const fill = shade ? cellStyle(p.value, color) : `fill:${color}`;
    if (shade) dots += `<circle cx="${px}" cy="${py}" r="${dotR}" style="fill:var(--card)"/>`;
    dots += `<circle cx="${px}" cy="${py}" r="${dotR}" style="${fill};stroke:var(--card)" stroke-width="2"/>
      <circle class="hit" cx="${px}" cy="${py}" r="14" data-tip="${esc(`${p.tip} · ${pct(p.value)}`)}"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">${grid}${xLabels(points, x)}
    <path d="${d}" fill="none" style="stroke:${color};stroke-opacity:${shade ? 0.45 : 1}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
}

// ---- Bars: one value per slot, optional target (single series) ---------

/**
 * points: [{ label, tip, value }]. target: a number draws a dashed line and lightens the bars below it;
 * null = plain bars, no target. `unit` follows the value in the tooltip (and in the target legend).
 */
export function barChart(points, target, color, unit, ariaLabel) {
  color = paint(color);
  const { W, H, L, R, T, B } = FRAME;
  const iw = W - L - R;
  const ih = H - T - B;
  const hasTarget = target != null;
  const val = (p) => (Number.isFinite(p.value) ? p.value : null);   // missing value: no bar, '–' in the tooltip
  const max = (Math.max(hasTarget ? target : 0, ...points.map((p) => val(p) ?? 0)) || 1) * 1.1;
  const y = (v) => T + ih * (1 - v / max);
  const base = y(0);
  const slot = iw / points.length;
  const bw = Math.max(2, slot - 2);
  const x = (i) => L + i * slot + 1;
  let bars = '';
  points.forEach((p, i) => {
    const x0 = x(i);
    const v = val(p);
    if (v > 0) {
      const top = y(v);
      const r = Math.min(4, bw / 2, base - top);
      bars += `<path d="M${x0} ${base}V${top + r}Q${x0} ${top} ${x0 + r} ${top}H${x0 + bw - r}Q${x0 + bw} ${top} ${x0 + bw} ${top + r}V${base}Z"
        style="fill:${color};fill-opacity:${!hasTarget || v >= target ? 1 : 0.45}"/>`;
    }
    bars += `<rect class="hit" x="${x0 - 1}" y="${T}" width="${slot}" height="${ih}" data-tip="${esc(`${p.tip} · ${v == null ? '–' : `${fmtNum(v)} ${unit}`}`)}"/>`;
  });
  const goal = hasTarget
    ? `<line class="target" x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}"/>
    <text x="${L - 6}" y="${y(target) + 3}" text-anchor="end">${fmtNum(target)}</text>`
    : '';
  const legend = hasTarget ? `<div class="heat-legend"><span class="dash"></span> obiettivo ${fmtNum(target)} ${esc(unit)}</div>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">
    <line class="grid" x1="${L}" x2="${W - R}" y1="${base}" y2="${base}"/>
    <text x="${L - 6}" y="${base + 3}" text-anchor="end">0</text>
    ${bars}${goal}
    ${xLabels(points, (i) => x(i) + bw / 2)}</svg>${legend}`;
}

// ---- Tooltip -----------------------------------------------------------

let tipEl;

export function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

/** One floating tooltip for every [data-tip] element; hover on desktop, tap on touch. */
export function initTooltips() {
  tipEl = Object.assign(document.createElement('div'), { className: 'tip', hidden: true });
  document.body.append(tipEl);
  const show = (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) { hideTip(); return; }
    tipEl.textContent = t.dataset.tip;
    tipEl.hidden = false;
    const r = t.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    tipEl.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8)}px`;
    tipEl.style.top = `${r.top - h - 8 < 0 ? r.bottom + 8 : r.top - h - 8}px`;
  };
  document.addEventListener('pointerover', show);
  document.addEventListener('click', show);
  addEventListener('scroll', hideTip, { capture: true, passive: true });
}
