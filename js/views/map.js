// Map screen (spec §4.1): Mondo | Italia, Regioni | Province, point filters, legend, area sheet with the manual
// mark, point preview, long press / + for a new place. Store changes go through update(): the map keeps its zoom.
import * as store from '../store.js';
import { createMap } from '../map.js';
import { areaStates, placeState } from '../logic.js';
import { esc, CATEGORIES, catLabel, openSheet, toast, fmtFull } from '../ui.js';

const LABEL = { visited: 'Visitato', planned: 'In programma', wish: 'Da visitare' };
const STATE_FILTERS = [['', 'Tutti'], ['visited', 'Visitati'], ['planned', 'In programma'], ['wish', 'Da visitare']];
const TITLE = 'map-sheet-title';

// Kept while the app is open, so coming back to the tab shows the same map (module scope, no storage).
let view = 'world';
let level = 'regions';
const filter = { state: '', cat: '', year: '' };
const cams = {};                                    // last camera per view

const live = (list) => (list || []).filter((x) => !x.deleted);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const newHere = (lat, lon) => `#luogo/nuovo?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
const link = (kind, id) => esc(`#${kind}/${encodeURIComponent(id)}`);
const day = (k) => (typeof k === 'string' && k.length === 10 ? fmtFull(k) : '');
const catKey = (c) => (CATEGORIES.some((x) => x.key === c) ? c : 'altro');
const radio = (name, value, label, on) =>
  `<label class="pick"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}><span>${label}</span></label>`;

/** Years (≤ today) of visits and stops per place id: only visited places have them. */
function visitYears(doc, today) {
  const m = new Map();
  const add = (id, d) => {
    if (typeof d !== 'string' || d > today) return;
    if (!m.has(id)) m.set(id, new Set());
    m.get(id).add(d.slice(0, 4));
  };
  for (const p of live(doc.places)) for (const d of p.visits || []) add(p.id, d);
  for (const t of live(doc.trips)) for (const s of t.stops || []) add(s.place, s.from ?? t.from);
  return m;
}

function placeRow(doc, p, today) {
  const s = placeState(doc, p, today);
  return `<li><a class="row" href="${link('luogo', p.id)}"><i class="st-dot st-${s}"></i>`
    + `<span><b>${esc(p.name || 'Senza nome')}</b><small>${esc(catLabel(p.cat))} · ${LABEL[s]}</small></span></a></li>`;
}

export async function render(el, ctx) {
  el.innerHTML = '<div class="map-wrap full"><p class="map-msg">Caricamento della mappa…</p></div>';
  let geo;
  try {
    geo = await store.getGeo();
  } catch (e) {
    console.error(e);
    if (ctx.stale()) return;
    el.innerHTML = '<div class="map-wrap full"><div class="map-msg"><p>Impossibile caricare i dati della mappa.</p>'
      + '<button type="button" class="btn" data-act="retry">Riprova</button></div></div>';
    el.onclick = (e) => { if (e.target.closest('[data-act="retry"]')) ctx.refresh(); };
    return;
  }
  if (ctx.stale()) return;

  const regionOf = new Map(geo.italia.features.map((f) => [f.n, f.r]));
  const names = new Map(geo.world.features.map((f) => [`c:${f.k}`, f.n]));
  for (const f of geo.italia.features) {
    names.set(`r:${f.r}`, f.r);
    names.set(`p:${f.n}`, f.n);
  }

  let cur = ctx, data = null, sheet = null;      // sheet = { s, draw } of an open sheet that follows the data

  function compute() {
    const { doc, today } = cur;
    data = {
      areas: areaStates(doc, today, (n) => regionOf.get(n) ?? null),
      places: live(doc.places).filter((p) => num(p.lat) && num(p.lon)).map((p) => ({ p, state: placeState(doc, p, today) })),
      years: visitYears(doc, today),
    };
  }

  const points = () => data.places
    .filter(({ p, state }) => (!filter.state || state === filter.state) && (!filter.cat || catKey(p.cat) === filter.cat)
      && (!filter.year || data.years.get(p.id)?.has(filter.year)))
    .map(({ p, state }) => ({ id: p.id, lat: p.lat, lon: p.lon, state }));

  const allYears = () => [...new Set([...data.years.values()].flatMap((s) => [...s]))].sort().reverse();

  el.innerHTML = `<div class="map-wrap full">
    <div class="map-bar">
      <div class="seg" role="radiogroup" aria-label="Vista">${radio('view', 'world', 'Mondo', view === 'world')}${radio('view', 'italia', 'Italia', view === 'italia')}</div>
      <div class="seg" role="radiogroup" aria-label="Livello" data-level${view === 'world' ? ' hidden' : ''}>${radio('level', 'regions', 'Regioni', level === 'regions')}${radio('level', 'provinces', 'Province', level === 'provinces')}</div>
      <div class="map-filters"></div>
    </div>
    <div class="map-legend"><span><i class="st-dot sq st-visited"></i>Visitato</span><span><i class="st-dot sq st-planned"></i>In programma</span><span><i class="st-dot sq st-wish"></i>Da visitare</span><span><i class="st-dot sq"></i>Mai</span></div>
    <a class="map-fab" href="#luogo/nuovo" aria-label="Nuovo luogo">+</a>
  </div>`;
  const wrap = el.firstElementChild;

  function drawChips() {
    const on = [];
    if (filter.state) on.push(['state', STATE_FILTERS.find(([v]) => v === filter.state)[1]]);
    if (filter.cat) on.push(['cat', catLabel(filter.cat)]);
    if (filter.year) on.push(['year', filter.year]);
    wrap.querySelector('.map-filters').innerHTML =
      `<button type="button" class="chip" data-act="filters" aria-haspopup="dialog">Filtri${on.length ? ` <small>(${on.length})</small>` : ''}</button>`
      + on.map(([f, l]) => `<button type="button" class="chip on" data-clear="${f}" aria-label="Togli il filtro ${esc(l)}">${esc(l)} <span aria-hidden="true">×</span></button>`).join('');
  }

  function applyFilters() {
    map.update({ points: points() });
    drawChips();
  }

  function setView(v) {
    if (v === view) return;
    cams[view] = map.camera();
    view = v;
    wrap.querySelector('[data-level]').hidden = v === 'world';
    wrap.querySelector(`input[name="view"][value="${v}"]`).checked = true;
    map.update({ view, level, focus: cams[v] || undefined });
  }

  /** Sheets that show document data register `draw`, so update() can refresh them in place. */
  function show(html, draw) {
    const s = openSheet(html, { onClose: () => { if (sheet?.s === s) sheet = null; } });
    sheet = draw ? { s, draw: () => { s.el.innerHTML = draw(); } } : null;
    return s;
  }

  // ---- Area sheet ----

  function areaHtml(key, ll) {
    const { doc, today } = cur;
    const kind = key[0], name = key.slice(2);
    const st = data.areas.get(key);
    const marked = doc.marks?.[key]?.s === 'visited';
    const field = kind === 'c' ? 'country' : kind === 'r' ? 'region' : 'province';
    const ps = live(doc.places).filter((p) => p[field] === name)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));
    const ids = new Set(ps.map((p) => p.id));
    const ts = live(doc.trips).filter((t) => (t.stops || []).some((s) => ids.has(s.place)))
      .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
    const sub = kind === 'r' ? 'Regione' : kind === 'p' ? `Provincia${regionOf.get(name) ? ` · ${regionOf.get(name)}` : ''}` : '';
    return `<h2 id="${TITLE}">${esc(names.get(key) ?? name)}</h2>
      <p class="map-sheet-meta">${sub ? `<small>${esc(sub)}</small>` : ''}<span class="pill ${st || ''}">${st ? LABEL[st] : 'Mai visitato'}</span>${marked ? '<small>segnato a mano</small>' : ''}</p>
      <div class="btn-row">
        <button type="button" class="btn${marked ? '' : ' primary'}" data-act="mark">${marked ? 'Togli segno' : 'Segna come visitato'}</button>
        <a class="btn" href="${esc(newHere(ll.lat, ll.lon))}">Aggiungi luogo qui</a>
        ${key === 'c:IT' && view === 'world' ? '<button type="button" class="btn" data-act="italia">Vedi l’Italia</button>' : ''}
      </div>
      <h3 class="map-sheet-h">Luoghi</h3>
      ${ps.length ? `<div class="card list"><ul class="rows">${ps.map((p) => placeRow(doc, p, today)).join('')}</ul></div>` : '<p class="muted">Nessun luogo in quest’area.</p>'}
      <h3 class="map-sheet-h">Viaggi</h3>
      ${ts.length ? `<div class="card list"><ul class="rows">${ts.map((t) => `<li><a class="row" href="${link('viaggio', t.id)}"><span><b>${esc(t.title || 'Viaggio')}</b>`
        + `<small>${esc(day(t.from))} – ${esc(day(t.to))}</small></span></a></li>`).join('')}</ul></div>` : '<p class="muted">Nessun viaggio con tappe qui.</p>'}`;
  }

  function onArea(key, ll) {
    const s = show(areaHtml(key, ll), () => areaHtml(key, ll));
    s.el.onclick = async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn?.dataset.act === 'italia') {
        s.close();
        setView('italia');
      } else if (btn?.dataset.act === 'mark') {
        const marked = cur.doc.marks?.[key]?.s === 'visited';
        btn.disabled = true;
        try {
          await store.setMark(key, marked ? null : 'visited');   // the change event refreshes map and sheet
          toast(marked ? 'Segno tolto' : 'Segnato come visitato');
        } catch (err) {
          console.error(err);
          toast('Impossibile salvare il segno');
        }
        if (sheet?.s === s) {
          sheet.draw();
          s.el.querySelector('[data-act="mark"]')?.focus();
        }
      }
    };
  }

  // ---- Point preview, cluster list, long press ----

  function onPoint(id) {
    const { doc, today } = cur;
    const p = live(doc.places).find((x) => x.id === id);
    if (!p) return;
    const st = placeState(doc, p, today);
    show(`<h2 id="${TITLE}" class="map-prev-title">${esc(p.name || 'Senza nome')}</h2>
      <p class="map-sheet-meta"><small>${esc(catLabel(p.cat))}</small><span class="pill ${st}">${LABEL[st]}</span></p>
      <a class="btn primary block" href="${link('luogo', id)}">Apri</a>`);
  }

  function onCluster(ids) {
    const { doc, today } = cur;
    const set = new Set(ids);
    const ps = live(doc.places).filter((p) => set.has(p.id));
    show(`<h2 id="${TITLE}">${ps.length} luoghi</h2>
      <div class="card list"><ul class="rows">${ps.map((p) => placeRow(doc, p, today)).join('')}</ul></div>`);
  }

  // ---- Filters ----

  function chip(f, v, label) {
    const on = filter[f] === v;
    return `<button type="button" class="chip${on ? ' on' : ''}" data-f="${f}" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`;
  }

  function filtersHtml() {
    const years = allYears();
    return `<h2 id="${TITLE}">Filtri</h2>
      <p class="muted map-note">Valgono per i punti sulla mappa; i colori delle aree restano quelli di tutti i luoghi.</p>
      <h3 class="map-sheet-h">Stato</h3>
      <div class="chips">${STATE_FILTERS.map(([v, l]) => chip('state', v, l)).join('')}</div>
      <h3 class="map-sheet-h">Categoria</h3>
      <div class="chips">${chip('cat', '', 'Tutte')}${CATEGORIES.map((c) => chip('cat', c.key, c.label)).join('')}</div>
      <h3 class="map-sheet-h">Anno di visita</h3>
      <div class="chips">${years.length || filter.year ? chip('year', '', 'Tutti') + years.map((y) => chip('year', y, y)).join('') : '<p class="muted">Nessuna visita con data.</p>'}</div>
      <div class="btn-row map-sheet-end"><button type="button" class="btn" data-act="reset">Azzera</button><button type="button" class="btn primary" data-act="done">Fatto</button></div>`;
  }

  function openFilters() {
    const s = show(filtersHtml(), filtersHtml);
    s.el.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'done') return s.close();
      if (b.dataset.act === 'reset') filter.state = filter.cat = filter.year = '';
      else if (b.dataset.f) filter[b.dataset.f] = b.dataset.v;
      else return;
      for (const c of s.el.querySelectorAll('[data-f]')) {   // in place: the tapped chip keeps focus
        const on = filter[c.dataset.f] === c.dataset.v;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', on);
      }
      applyFilters();
    };
  }

  // ---- Wiring ----

  compute();
  const map = createMap(wrap, {
    view, level, geo, areas: data.areas, points: points(), focus: cams[view] || undefined,
    onArea, onPoint, onCluster,
    onLongPress: (lat, lon) => { location.hash = newHere(lat, lon); },
  });
  drawChips();

  el.onchange = (e) => {
    const t = e.target;
    if (t.name === 'view') setView(t.value);
    else if (t.name === 'level') {
      level = t.value;
      map.update({ level });
    }
  };
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || !wrap.contains(b)) return;
    if (b.dataset.act === 'filters') openFilters();
    else if (b.dataset.clear) {
      filter[b.dataset.clear] = '';
      applyFilters();
      wrap.querySelector('[data-act="filters"]')?.focus();
    }
  };

  return {
    update(c) {
      cur = c;
      compute();
      map.update({ areas: data.areas, points: points() });
      drawChips();
      sheet?.draw();
    },
    destroy() {
      cams[view] = map.camera();
      sheet?.s.close(true);
      map.destroy();
    },
  };
}
