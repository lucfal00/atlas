// Trips list (spec §4.3): In corso / In programma (by start, ascending) / Passati (newest first).
import { tripState } from '../logic.js';
import { esc, fmtRange, fmtMoney, PLUS } from '../ui.js';

const live = (list) => (list || []).filter((x) => !x.deleted);

function card(t, ids) {
  const stops = (t.stops || []).filter((s) => ids.has(s.place)).length;
  const meta = [fmtRange(t.from, t.to), `${stops} ${stops === 1 ? 'tappa' : 'tappe'}`, t.spend > 0 ? fmtMoney(t.spend) : ''].filter(Boolean).join(' · ');
  return `<li><a class="row" href="#viaggio/${esc(encodeURIComponent(t.id))}"><span><b>${esc(t.title || 'Viaggio')}</b>`
    + `<small>${esc(meta)}</small></span></a></li>`;
}

function body(ctx) {
  const trips = live(ctx.doc.trips).filter((t) => t.from && t.to);
  if (!trips.length) {
    return '<div class="card empty"><h2>Nessun viaggio</h2><p class="muted">Pianifica il prossimo viaggio o aggiungi quelli passati.</p><a class="btn primary" href="#viaggio/nuovo">Nuovo viaggio</a></div>';
  }
  const ids = new Set(live(ctx.doc.places).map((p) => p.id));
  const asc = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
  return [['current', 'In corso', asc], ['planned', 'In programma', asc], ['past', 'Passati', (a, b) => asc(b, a)]].map(([state, title, order]) => {
    const list = trips.filter((t) => tripState(t, ctx.today) === state).sort(order);
    return list.length
      ? `<div class="section-head"><h2>${title}</h2></div><div class="card list"><ul class="rows">${list.map((t) => card(t, ids)).join('')}</ul></div>` : '';
  }).join('');
}

export function render(el, ctx) {
  const draw = (c) => {
    el.innerHTML = `<div class="top"><h1 class="grow">Viaggi</h1></div>${body(c)}<a class="fab" href="#viaggio/nuovo" aria-label="Nuovo viaggio">${PLUS}</a>`;
  };
  draw(ctx);
  return { update: draw };
}
