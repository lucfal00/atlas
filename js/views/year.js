// Year in travel (spec §6.5): numbers of the year and a static world map with that year's countries.
import * as store from '../store.js';
import { createMap } from '../map.js';
import { yearInTravel, nights } from '../logic.js';
import { esc, fmtRange, fmtKm, fmtMoney } from '../ui.js';

const enc = encodeURIComponent;
const tile = (n, label) => `<div class="card tile"><b>${esc(n)}</b><small class="muted">${esc(label)}</small></div>`;

export async function render(el, ctx) {
  const year = Number(ctx.params[0]);
  if (!/^\d{4}$/.test(String(ctx.params[0] ?? '')) || year < 1900 || year > Number(ctx.today.slice(0, 4))) {
    el.innerHTML = '<div class="card empty"><h2>Anno non valido</h2><p class="muted">Questo anno non esiste tra i tuoi viaggi.</p>'
      + '<a class="btn primary" href="#stats">Vai alle statistiche</a></div>';
    return;
  }
  let geo = null;
  try {
    geo = await store.getGeo();
  } catch (e) {
    console.error(e);                                // numbers still work without the map
  }
  if (ctx.stale()) return;

  let map = null;

  function draw(c) {
    const { doc, today } = c;
    const y = yearInTravel(doc, year, today);
    const names = new Map(geo?.world.features.map((f) => [f.k, f.n]) ?? []);
    const name = (k) => names.get(k) ?? k;
    const places = new Map((doc.places || []).filter((p) => !p.deleted).map((p) => [p.id, p]));
    const empty = !y.trips.length && !y.countries.length;
    const trips = y.trips.map((t) => `<li><a class="row" href="#viaggio/${esc(enc(t.id))}"><span><b>${esc(t.title || 'Viaggio')}</b>`
      + `<small>${esc(fmtRange(t.from, t.to))} · ${nights(t)} ${nights(t) === 1 ? 'notte' : 'notti'}</small></span></a></li>`).join('');
    const chips = (list) => `<div class="chips">${list.map((k) => `<span class="chip static">${esc(name(k))}</span>`).join('')}</div>`;
    const best = y.bestPlace && places.has(y.bestPlace.id) ? y.bestPlace : null;

    map?.destroy();
    map = null;
    el.innerHTML = `<div class="top"><a class="back" href="#stats">‹ Statistiche</a><h1 class="grow">${year}</h1></div>`
      + (empty ? '<div class="card empty"><h2>Nessun viaggio</h2><p class="muted">In questo anno non risultano viaggi né luoghi visitati.</p></div>' : `
      <div class="tiles">${tile(y.days, 'Giorni')}`
      + `${tile(y.trips.length, y.trips.length === 1 ? 'Viaggio' : 'Viaggi')}${tile(y.countries.length, y.countries.length === 1 ? 'Paese' : 'Paesi')}</div>
      <div class="tiles"><div class="card tile" style="grid-column:span 2"><b>${esc(fmtKm(y.km))}</b><small class="muted">Percorsi</small></div>
      ${tile(fmtMoney(y.spend), 'Spesa')}</div>
      <div class="map-wrap mini" data-map></div>
      ${y.newCountries.length ? `<section class="card"><div class="card-head"><h2>Paesi nuovi</h2></div>${chips(y.newCountries)}</section>` : ''}
      ${best ? `<section class="card"><div class="card-head"><h2>Il più bello</h2></div>`
        + `<a class="row" href="#luogo/${esc(enc(best.id))}"><span><b>${esc(best.name)}</b><small>${'★'.repeat(Math.max(0, Math.min(5, Math.round(best.rating))))}</small></span></a></section>` : ''}
      ${trips ? `<div class="section-head"><h2>Viaggi</h2></div><div class="card list"><ul class="rows">${trips}</ul></div>` : ''}`);
    const host = el.querySelector('[data-map]');
    if (host && geo) {
      const areas = new Map(y.countries.map((k) => [`c:${k}`, 'visited']));
      map = createMap(host, { view: 'world', geo, areas, interactive: false });
    }
  }
  draw(ctx);
  return { update: draw, destroy: () => { map?.destroy(); map = null; } };
}
