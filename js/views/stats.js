// Statistics (spec §4.4, §6.4): countries / regions / provinces, travel per year, km, extremes, spending, list of years.
import * as store from '../store.js';
import {
  areaStates, placeState, travelDays, tripsByYear, yearKm, tripSpend, nights, farthest, extremes,
  favoriteMonth, countriesByContinent, COST_CATS as COST_KEYS,
} from '../logic.js';
import { barChart } from '../charts.js';
import { esc, fmtMoney, fmtKm, COST_CATS } from '../ui.js';

const live = (list) => (list || []).filter((x) => !x.deleted);
const enc = encodeURIComponent;
const MONTH_NAMES = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const CONTINENTS = {
  Europe: 'Europa', Asia: 'Asia', Africa: 'Africa', 'North America': 'Nord America', 'South America': 'Sud America',
  Oceania: 'Oceania', Antarctica: 'Antartide',
};
const rank = (c) => (c in CONTINENTS ? Object.keys(CONTINENTS).indexOf(c) : 99);
const EMPTY = '<div class="card empty"><h2>Ancora nessun dato</h2><p class="muted">Aggiungi luoghi e viaggi: qui compariranno paesi, giorni in viaggio e spese.</p>'
  + '<a class="btn primary" href="#luogo/nuovo">Nuovo luogo</a></div>';

const tile = (n, label) => `<div class="card tile"><b>${esc(n)}</b><small class="muted">${esc(label)}</small></div>`;
const head = (title, meta = '') => `<div class="card-head"><h2>${esc(title)}</h2>${meta}</div>`;
const row = (label, value, href) => {
  const body = `<span><b>${esc(label)}</b></span><span class="stat-meta">${value}</span>`;
  return `<li>${href ? `<a class="row" href="${esc(href)}">${body}</a>` : `<div class="row">${body}</div>`}</li>`;
};
const listCard = (title, rows) => `<section class="card list st-wide"><div class="card-head" style="padding:16px 16px 0">`
  + `<h2>${esc(title)}</h2></div><ul class="rows">${rows}</ul></section>`;

function build(doc, today, geo) {
  const places = live(doc.places);
  const trips = live(doc.trips).filter((t) => t.from && t.to);
  if (!places.length && !trips.length && !Object.keys(doc.marks || {}).length) return EMPTY;

  const names = new Map(geo?.world.features.map((f) => [f.k, f.n]) ?? []);
  const conts = new Map(geo?.world.features.map((f) => [f.k, f.c]) ?? []);
  const regionOf = new Map(geo?.italia.features.map((f) => [f.n, f.r]) ?? []);
  const areas = areaStates(doc, today, (n) => regionOf.get(n) ?? null);
  const visited = (prefix) => [...areas].filter(([k, s]) => s === 'visited' && k.startsWith(prefix)).length;
  const nRegions = geo ? new Set(geo.italia.features.map((f) => f.r)).size : 20;
  const nProv = geo ? geo.italia.features.length : 107;
  const nPlaces = places.filter((p) => placeState(doc, p, today) === 'visited').length;
  const started = tripsByYear(doc, today);
  const nTrips = Object.values(started).reduce((a, n) => a + n, 0);

  const byCont = countriesByContinent(doc, today, (c) => conts.get(c));
  const nCountries = Object.values(byCont).reduce((a, l) => a + l.length, 0);
  const contHtml = Object.keys(byCont).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((c) => `<h3 class="map-sheet-h">${esc(CONTINENTS[c] ?? 'Altro')} · ${byCont[c].length}</h3><div class="chips">`
      + byCont[c].map((k) => `<span class="chip static">${esc(names.get(k) ?? k)}</span>`).join('') + '</div>').join('');

  let html = `<div class="tiles">${tile(nCountries, 'Paesi')}${tile(nPlaces, 'Luoghi')}${tile(nTrips, 'Viaggi')}</div><div class="stats-grid">`;
  html += `<section class="card st-wide">${head('Dove sei stato')}`
    + `<p class="muted">Regioni italiane: ${visited('r:')} su ${nRegions} · Province: ${visited('p:')} su ${nProv}</p>`
    + `${contHtml || '<p class="muted">Nessun paese visitato.</p>'}</section>`;

  const years = Object.keys(started).sort();
  if (years.length) {
    const series = (fn) => years.map((y) => ({ label: y, tip: y, value: fn(Number(y), y) }));
    const days = series((y) => travelDays(doc, y, today));
    const cnt = series((y, k) => started[k]);
    const km = series((y) => Math.round(yearKm(doc, y, today)));
    const spend = series((y) => Math.round(trips.filter((t) => t.from <= today && t.from.startsWith(`${y}-`))
      .reduce((s, t) => s + tripSpend(t).total, 0)));
    const bars = (title, pts, unit, sub = '') => `<section class="card">${head(title)}`
      + `${barChart(pts, null, 'var(--accent)', unit, `Grafico: ${title}`)}${sub}</section>`;
    const fav = favoriteMonth(doc, today);
    html += bars('Giorni in viaggio', days, 'giorni', fav ? `<p class="chart-sub">Mese preferito: ${esc(MONTH_NAMES[fav - 1])}</p>` : '');
    html += bars('Viaggi', cnt, 'viaggi');
    if (km.some((p) => p.value > 0)) html += bars('Chilometri', km, 'km');
    if (spend.some((p) => p.value > 0)) html += bars('Spese per anno', spend, '€');
  }

  const far = farthest(doc, today);
  const ext = extremes(doc, today);
  let rows = '';
  if (far && far.km > 0) rows += row('Più lontano da casa', `${esc(far.place.name)} · ${esc(fmtKm(far.km))}`, `#luogo/${enc(far.place.id)}`);
  if (ext) {
    for (const [k, l] of [['north', 'Più a nord'], ['south', 'Più a sud'], ['east', 'Più a est'], ['west', 'Più a ovest']]) {
      rows += row(l, esc(ext[k].name), `#luogo/${enc(ext[k].id)}`);
    }
  }
  if (rows) html += listCard('Estremi', rows);

  const spent = trips.filter((t) => t.from <= today).map((t) => ({ t, s: tripSpend(t) })).filter((x) => x.s.total > 0);
  if (spent.length) {
    const total = spent.reduce((a, x) => a + x.s.total, 0);
    const byCat = Object.fromEntries(COST_KEYS.map((c) => [c, spent.reduce((a, x) => a + x.s.byCat[c], 0)]));
    const bars = COST_CATS.filter((c) => byCat[c.key] > 0).map((c) => {
      const f = byCat[c.key] / total;
      return `<div><div class="card-head"><b>${esc(c.label)}</b><span class="stat-meta">${esc(fmtMoney(byCat[c.key]))} · ${Math.round(f * 100)}%</span></div>`
        + `<div class="bar"><i style="--w:${(f * 100).toFixed(1)}%"></i></div></div>`;
    }).join('');
    const nn = spent.reduce((a, x) => a + nights(x.t), 0);
    const link = ({ t, s }) => `<a href="#viaggio/${esc(enc(t.id))}">${esc(t.title || 'Viaggio')}</a> · ${esc(fmtMoney(s.total))}`;
    const sorted = [...spent].sort((a, b) => b.s.total - a.s.total);
    html += `<section class="card">${head('Spese', `<span class="stat-meta">${esc(fmtMoney(total))}</span>`)}<div class="form">${bars}</div>`
      + `<p class="chart-sub">Costo medio per notte: ${esc(fmtMoney(nn > 0 ? total / nn : total))}</p>`
      + `<p class="chart-sub">Viaggio più caro: ${link(sorted[0])}</p>`
      + (sorted.length > 1 ? `<p class="chart-sub">Viaggio più economico: ${link(sorted[sorted.length - 1])}</p>` : '') + '</section>';
  }

  if (years.length) {
    html += listCard('Il tuo anno in viaggio', [...years].reverse().map((y) => row(y,
      `${started[y]} ${started[y] === 1 ? 'viaggio' : 'viaggi'} · ${travelDays(doc, Number(y), today)} giorni`, `#anno/${y}`)).join(''));
  }
  return `${html}</div>`;
}

export async function render(el, ctx) {
  let geo = null;
  try {
    geo = await store.getGeo();
  } catch (e) {
    console.error(e);                                // continents and region totals fall back to codes / defaults
  }
  if (ctx.stale()) return;
  const draw = (c) => {
    el.innerHTML = `<div class="top"><h1 class="grow">Statistiche</h1></div>${build(c.doc, c.today, geo)}`;
  };
  draw(ctx);
  return { update: draw };
}
