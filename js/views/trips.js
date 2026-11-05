// Trips list (spec §4.3): In corso / In programma (by start, ascending) / Passati (by year, newest first).
import { tripState, nights, tripSpend } from '../logic.js';
import { esc, fmtRange, fmtMoney } from '../ui.js';

const live = (list) => (list || []).filter((x) => !x.deleted);

function card(t, ids) {
  const n = nights(t), stops = (t.stops || []).filter((s) => ids.has(s.place)).length;
  const spend = tripSpend(t);
  const budget = Object.values(t.budget || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const money = spend.total > 0 || budget > 0
    ? `${esc(fmtMoney(spend.total))}${budget > 0 ? ` su ${esc(fmtMoney(budget))}` : ''}` : '';
  const meta = [`${n} ${n === 1 ? 'notte' : 'notti'}`, `${stops} ${stops === 1 ? 'tappa' : 'tappe'}`, money].filter(Boolean).join(' · ');
  return `<li><a class="row" href="#viaggio/${esc(encodeURIComponent(t.id))}"><span><b>${esc(t.title || 'Viaggio')}</b>`
    + `<small>${esc(fmtRange(t.from, t.to))}</small><small>${meta}</small></span></a></li>`;
}

const section = (title, list, ids) => (list.length
  ? `<div class="section-head"><h2>${title}</h2></div><div class="card list"><ul class="rows">${list.map((t) => card(t, ids)).join('')}</ul></div>` : '');

function body(ctx) {
  const trips = live(ctx.doc.trips).filter((t) => t.from && t.to);
  if (!trips.length) {
    return '<div class="card empty"><h2>Nessun viaggio</h2><p class="muted">Pianifica il prossimo viaggio o racconta quelli passati.</p><a class="btn primary" href="#viaggio/nuovo">Nuovo viaggio</a></div>';
  }
  const ids = new Set(live(ctx.doc.places).map((p) => p.id));
  const by = (s) => trips.filter((t) => tripState(t, ctx.today) === s);
  const asc = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
  const past = by('past').sort((a, b) => asc(b, a));
  let pastHtml = '';
  for (const y of [...new Set(past.map((t) => t.from.slice(0, 4)))]) {
    pastHtml += `<h3 class="map-sheet-h">${esc(y)}</h3><div class="card list"><ul class="rows">${past.filter((t) => t.from.startsWith(y)).map((t) => card(t, ids)).join('')}</ul></div>`;
  }
  return section('In corso', by('current').sort(asc), ids) + section('In programma', by('planned').sort(asc), ids)
    + (past.length ? `<div class="section-head"><h2>Passati</h2></div>${pastHtml}` : '');
}

export function render(el, ctx) {
  const draw = (c) => {
    el.innerHTML = `<div class="top"><h1 class="grow">Viaggi</h1></div>${body(c)}<a class="fab" href="#viaggio/nuovo" aria-label="Nuovo viaggio">+</a>`;
  };
  draw(ctx);
  return { update: draw };
}
