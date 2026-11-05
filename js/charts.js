// SVG chart builders (return markup strings) and a shared hover/tap tooltip.
// Marks: 2px lines, 8px dots, 4px rounded bar tops on the baseline, 2px gaps; text uses text tokens only.
import { esc, safeColor, fmtNum } from './ui.js';

const VAR_COLOR = /^var\(--[a-z0-9-]+\)$/;
/** Colours are inlined in style attributes: CSS tokens (`var(--x)`) or #rrggbb only, anything else → safeColor fallback. */
const paint = (c) => (VAR_COLOR.test(c) ? c : safeColor(c));

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
