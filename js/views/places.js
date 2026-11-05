// Places list (spec §4.2): search by name (accent-insensitive), newest first, state badge. The search text lives in
// module scope so coming back to the tab shows the same list (no storage).
import * as store from '../store.js';
import { placeState, fold } from '../logic.js';
import { esc, catLabel, fmtMonths, PLUS } from '../ui.js';

const LABEL = { visited: 'Visitato', wish: 'Da visitare' };

let query = '';

const live = (list) => (list || []).filter((x) => !x.deleted);

export async function render(el, ctx) {
  let names = new Map();                             // country code → name
  try {
    const geo = await store.getGeo();
    names = new Map(geo.world.features.map((f) => [f.k, f.n]));
  } catch (e) {
    console.error(e);                                // list still works, with codes instead of names
  }
  if (ctx.stale()) return;

  let cur = ctx;

  el.innerHTML = `<div class="top"><h1 class="grow">Luoghi</h1></div>
    <div class="places-tools">
      <input type="search" data-q placeholder="Cerca per nome" aria-label="Cerca per nome" autocomplete="off">
    </div>
    <div data-list></div>
    <a class="fab" href="#luogo/nuovo" aria-label="Nuovo luogo">${PLUS}</a>`;
  const q = el.querySelector('[data-q]');
  q.value = query;

  function row(p) {
    const state = placeState(cur.doc, p, cur.today);
    const when = state === 'visited' ? fmtMonths(p.from, p.to) : '';
    const where = [catLabel(p.cat), p.country ? names.get(p.country) ?? p.country : '', when].filter(Boolean).join(' · ');
    return `<li><a class="row" href="#luogo/${esc(encodeURIComponent(p.id))}"><span class="badge" aria-hidden="true">${esc(catLabel(p.cat).charAt(0))}</span>`
      + `<span><b>${esc(p.name || 'Senza nome')}</b><small>${esc(where)}</small></span><span class="pill ${state}">${LABEL[state]}</span></a></li>`;
  }

  function drawList() {
    const total = live(cur.doc.places);
    const needle = fold(query.trim());
    const list = total.filter((p) => !needle || fold(p.name).includes(needle)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    el.querySelector('[data-list]').innerHTML = !total.length
      ? `<div class="card empty"><h2>Nessun luogo</h2><p class="muted">Aggiungi il primo luogo che hai visitato o che vuoi visitare.</p>
          <a class="btn primary" href="#luogo/nuovo">Aggiungi luogo</a></div>`
      : !list.length
        ? '<div class="card empty"><h2>Nessun luogo trovato</h2></div>'
        : `<div class="card list"><ul class="rows">${list.map(row).join('')}</ul></div>`;
  }

  drawList();
  el.oninput = (e) => {
    if (e.target === q) {
      query = q.value;
      drawList();
    }
  };

  return {
    update(c) {                                      // the search box keeps its text
      cur = c;
      drawList();
    },
  };
}
