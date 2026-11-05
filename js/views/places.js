// Places list (spec §4.2): name search, filters sheet (state, category, country, tag, favourites) with removable
// chips, sort. Filters live in module scope so coming back to the tab shows the same list (no storage).
import * as store from '../store.js';
import { placeState, fold } from '../logic.js';
import { haversine } from '../geo.js';
import { esc, CATEGORIES, catLabel, openSheet } from '../ui.js';

const LABEL = { visited: 'Visitato', planned: 'In programma', wish: 'Da visitare' };
const STATE_FILTERS = [['', 'Tutti'], ['visited', 'Visitati'], ['planned', 'In programma'], ['wish', 'Da visitare']];
const SORTS = [['recent', 'Modificati di recente'], ['name', 'Nome'], ['rating', 'Voto'], ['dist', 'Distanza da casa']];
const TITLE = 'places-sheet-title';

const filter = { q: '', state: '', cat: '', country: '', tag: '', fav: false };
let sort = 'recent';

const live = (list) => (list || []).filter((x) => !x.deleted);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const catKey = (c) => (CATEGORIES.some((x) => x.key === c) ? c : 'altro');
const active = () => !!(filter.q || filter.state || filter.cat || filter.country || filter.tag || filter.fav);

function stars(r) {
  return num(r) && r > 0 ? `<span class="muted" aria-label="Voto ${r} su 5">${'★'.repeat(r)}</span>` : '';
}

export async function render(el, ctx) {
  let names = new Map();                             // country code → name
  try {
    const geo = await store.getGeo();
    names = new Map(geo.world.features.map((f) => [f.k, f.n]));
  } catch (e) {
    console.error(e);                                // list still works, with codes instead of names
  }
  if (ctx.stale()) return;
  const cname = (c) => names.get(c) ?? c;

  let cur = ctx, sheet = null;                       // sheet = { s, draw } while the filters sheet is open

  el.innerHTML = `<div class="top"><h1 class="grow">Luoghi</h1></div>
    <div class="places-tools">
      <input type="search" data-q placeholder="Cerca per nome" aria-label="Cerca per nome" autocomplete="off">
      <div class="two">
        <button type="button" class="btn" data-act="filters" aria-haspopup="dialog">Filtri</button>
        <select data-sort aria-label="Ordina">${SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </div>
      <div class="chips" data-chips></div>
    </div>
    <p class="muted" data-count></p>
    <div data-list></div>
    <a class="fab" href="#luogo/nuovo" aria-label="Nuovo luogo">+</a>`;
  const q = el.querySelector('[data-q]'), sel = el.querySelector('[data-sort]');
  q.value = filter.q;
  sel.value = sort;

  function visible() {
    const { doc, today } = cur;
    const home = doc.settings?.home;
    const needle = fold(filter.q.trim());
    const list = live(doc.places).map((p) => ({ p, state: placeState(doc, p, today) }))
      .filter(({ p, state }) => (!needle || fold(p.name).includes(needle))
        && (!filter.state || state === filter.state)
        && (!filter.cat || catKey(p.cat) === filter.cat)
        && (!filter.country || p.country === filter.country)
        && (!filter.tag || (p.tags || []).includes(filter.tag))
        && (!filter.fav || p.fav));
    const by = {
      recent: (a, b) => (b.p.updatedAt || 0) - (a.p.updatedAt || 0),
      name: (a, b) => String(a.p.name).localeCompare(String(b.p.name), 'it'),
      rating: (a, b) => (num(b.p.rating) ? b.p.rating : -1) - (num(a.p.rating) ? a.p.rating : -1),
    };
    if (sort === 'dist' && home && num(home.lat) && num(home.lon)) {
      const d = (x) => (num(x.p.lat) && num(x.p.lon) ? haversine(home.lat, home.lon, x.p.lat, x.p.lon) : Infinity);
      list.sort((a, b) => {
        const da = d(a), db = d(b);
        return da === db ? 0 : da < db ? -1 : 1;     // Infinity - Infinity would be NaN
      });
    } else {
      list.sort(by[sort] ?? by.recent);
    }
    return list;
  }

  function row({ p, state }) {
    const where = [catLabel(p.cat), p.country ? cname(p.country) : ''].filter(Boolean).join(' · ');
    return `<li><a class="row" href="#luogo/${esc(encodeURIComponent(p.id))}"><span class="badge" aria-hidden="true">${esc(catLabel(p.cat).charAt(0))}</span>`
      + `<span><b>${esc(p.name || 'Senza nome')}${p.fav ? ' <span aria-label="Preferito">♥</span>' : ''}</b>`
      + `<small>${esc(where)} ${stars(p.rating)}</small></span><span class="pill ${state}">${LABEL[state]}</span></a></li>`;
  }

  function drawChips() {
    const on = [];
    if (filter.state) on.push(['state', STATE_FILTERS.find(([v]) => v === filter.state)[1]]);
    if (filter.cat) on.push(['cat', catLabel(filter.cat)]);
    if (filter.country) on.push(['country', cname(filter.country)]);
    if (filter.tag) on.push(['tag', `#${filter.tag}`]);
    if (filter.fav) on.push(['fav', 'Preferiti']);
    el.querySelector('[data-chips]').innerHTML = on.map(([f, l]) =>
      `<button type="button" class="chip on" data-clear="${f}" aria-label="Togli il filtro ${esc(l)}">${esc(l)} <span aria-hidden="true">×</span></button>`).join('');
    el.querySelector('[data-act="filters"]').innerHTML = `Filtri${on.length ? ` <small>(${on.length})</small>` : ''}`;
  }

  function drawList() {
    const total = live(cur.doc.places).length;
    const list = visible();
    el.querySelector('[data-count]').textContent = total ? `${list.length} ${list.length === 1 ? 'luogo' : 'luoghi'}` : '';
    el.querySelector('[data-list]').innerHTML = !total
      ? `<div class="card empty"><h2>Nessun luogo</h2><p class="muted">Aggiungi il primo luogo che hai visitato o che vuoi visitare.</p>
          <a class="btn primary" href="#luogo/nuovo">Aggiungi luogo</a></div>`
      : !list.length
        ? `<div class="card empty"><h2>Nessun luogo con questi filtri</h2>
            <button type="button" class="btn primary" data-act="reset">Azzera filtri</button></div>`
        : `<div class="card list"><ul class="rows">${list.map(row).join('')}</ul></div>`;
    drawChips();
  }

  // ---- Filters sheet ----

  function chip(f, v, label) {
    const on = filter[f] === v;
    return `<button type="button" class="chip${on ? ' on' : ''}" data-f="${f}" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`;
  }

  function filtersHtml() {
    const ps = live(cur.doc.places);
    const countries = [...new Set(ps.map((p) => p.country).filter(Boolean))].sort((a, b) => cname(a).localeCompare(cname(b), 'it'));
    const tags = [...new Set(ps.flatMap((p) => p.tags || []))].sort((a, b) => a.localeCompare(b, 'it'));
    return `<h2 id="${TITLE}">Filtri</h2>
      <h3 class="list-title">Stato</h3>
      <div class="chips">${STATE_FILTERS.map(([v, l]) => chip('state', v, l)).join('')}</div>
      <h3 class="list-title">Categoria</h3>
      <div class="chips">${chip('cat', '', 'Tutte')}${CATEGORIES.map((c) => chip('cat', c.key, c.label)).join('')}</div>
      <h3 class="list-title">Paese</h3>
      <div class="chips">${countries.length ? chip('country', '', 'Tutti') + countries.map((c) => chip('country', c, cname(c))).join('') : '<p class="muted">Nessun paese.</p>'}</div>
      <h3 class="list-title">Tag</h3>
      <div class="chips">${tags.length ? chip('tag', '', 'Tutti') + tags.map((t) => chip('tag', t, t)).join('') : '<p class="muted">Nessun tag.</p>'}</div>
      <h3 class="list-title">Preferiti</h3>
      <label class="check"><input type="checkbox" data-fav${filter.fav ? ' checked' : ''}><span>Solo preferiti</span></label>
      <div class="btn-row"><button type="button" class="btn" data-act="reset">Azzera</button><button type="button" class="btn primary" data-act="done">Fatto</button></div>`;
  }

  function resetFilters() {
    Object.assign(filter, { q: '', state: '', cat: '', country: '', tag: '', fav: false });
    q.value = '';
  }

  function openFilters() {
    const s = openSheet(filtersHtml(), { onClose: () => { if (sheet?.s === s) sheet = null; } });
    sheet = { s };
    s.el.onchange = (e) => {
      if (e.target.matches('[data-fav]')) {
        filter.fav = e.target.checked;
        drawList();
      }
    };
    s.el.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'done') return s.close();
      if (b.dataset.act === 'reset') {
        resetFilters();
        s.el.innerHTML = filtersHtml();
      } else if (b.dataset.f) {
        filter[b.dataset.f] = b.dataset.v;
        for (const c of s.el.querySelectorAll('[data-f]')) {   // in place: the tapped chip keeps focus
          const on = filter[c.dataset.f] === c.dataset.v;
          c.classList.toggle('on', on);
          c.setAttribute('aria-pressed', on);
        }
      } else return;
      drawList();
    };
  }

  // ---- Wiring ----

  drawList();
  el.oninput = (e) => {
    if (e.target === q) {
      filter.q = q.value;
      drawList();
    }
  };
  el.onchange = (e) => {
    if (e.target === sel) {
      sort = sel.value;
      drawList();
    }
  };
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'filters') openFilters();
    else if (b.dataset.act === 'reset') {
      resetFilters();
      drawList();
    } else if (b.dataset.clear) {
      filter[b.dataset.clear] = b.dataset.clear === 'fav' ? false : '';
      drawList();
      el.querySelector('[data-act="filters"]')?.focus();
    }
  };

  return {
    update(c) {                                      // the search box and open sheet keep their state
      cur = c;
      drawList();
    },
    destroy() {
      sheet?.s.close(true);
    },
  };
}
