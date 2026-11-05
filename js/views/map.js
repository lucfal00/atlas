// Map screen (spec §4.1): Mondo | Italia (regions), three counters, legend, area sheet with the manual mark,
// point preview, long press / + for a new place. Store changes go through update(): the map keeps its zoom.
import * as store from '../store.js';
import { createMap } from '../map.js';
import { areaStates, placeState, visitedCounts } from '../logic.js';
import { esc, catLabel, openSheet, toast } from '../ui.js';

const LABEL = { visited: 'Visitato', wish: 'Da visitare' };
const TITLE = 'map-sheet-title';

// Kept while the app is open, so coming back to the tab shows the same map (module scope, no storage).
let view = 'world';
const cams = {};                                    // last camera per view

const live = (list) => (list || []).filter((x) => !x.deleted);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const newHere = (lat, lon) => `#luogo/nuovo?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
const link = (id) => esc(`#luogo/${encodeURIComponent(id)}`);
const radio = (name, value, label, on) =>
  `<label class="pick"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}><span>${label}</span></label>`;

function placeRow(doc, p, today) {
  const s = placeState(doc, p, today);
  return `<li><a class="row" href="${link(p.id)}"><i class="st-dot st-${s}"></i>`
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

  const names = new Map(geo.world.features.map((f) => [`c:${f.k}`, f.n]));

  let cur = ctx, data = null, sheet = null;      // sheet = { s, draw } of an open sheet that follows the data

  function compute() {
    const { doc, today } = cur;
    data = {
      areas: areaStates(doc, today),
      places: live(doc.places).filter((p) => num(p.lat) && num(p.lon)).map((p) => ({ p, state: placeState(doc, p, today) })),
    };
  }

  const points = () => data.places.map(({ p, state }) => ({ id: p.id, lat: p.lat, lon: p.lon, state }));

  el.innerHTML = `<div class="map-wrap full">
    <div class="map-bar">
      <div class="seg" role="radiogroup" aria-label="Vista">${radio('view', 'world', 'Mondo', view === 'world')}${radio('view', 'italia', 'Italia', view === 'italia')}</div>
      <div class="map-nums"></div>
    </div>
    <div class="map-legend"><span><i class="st-dot sq st-visited"></i>Visitato</span><span><i class="st-dot sq st-wish"></i>Da visitare</span><span><i class="st-dot sq"></i>Mai</span></div>
    <button type="button" class="map-reset" aria-label="Vista iniziale" title="Vista iniziale" hidden><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="2.2"/></svg></button>
    <a class="map-fab" href="#luogo/nuovo" aria-label="Nuovo luogo">+</a>
  </div>`;
  const wrap = el.firstElementChild;

  const reset = wrap.querySelector('.map-reset');
  reset.onclick = () => map.reset();

  function drawNums() {
    const n = visitedCounts(cur.doc, cur.today);
    wrap.querySelector('.map-nums').innerHTML = `<span><b>${n.countries}</b> paesi</span><span><b>${n.regions}</b>/20 regioni</span>`
      + `<span><b>${n.places}</b> luoghi visitati</span>`;
  }

  function setView(v) {
    if (v === view) return;
    cams[view] = map.camera();
    view = v;
    map.update({ view, focus: cams[v] || undefined });
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
    const ps = live(doc.places).filter((p) => p[kind === 'c' ? 'country' : 'region'] === name)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));
    return `<h2 id="${TITLE}">${esc(names.get(key) ?? name)}</h2>
      <p class="map-sheet-meta">${kind === 'r' ? '<small>Regione</small>' : ''}<span class="pill ${st || ''}">${st ? LABEL[st] : 'Mai visitato'}</span>${marked ? '<small>segnato a mano</small>' : ''}</p>
      <div class="btn-row">
        <button type="button" class="btn${marked ? '' : ' primary'}" data-act="mark">${marked ? 'Togli segno' : 'Segna come visitato'}</button>
        <a class="btn" href="${esc(newHere(ll.lat, ll.lon))}">Aggiungi luogo qui</a>
      </div>
      <h3 class="map-sheet-h">Luoghi</h3>
      ${ps.length ? `<div class="card list"><ul class="rows">${ps.map((p) => placeRow(doc, p, today)).join('')}</ul></div>` : '<p class="muted">Nessun luogo in quest’area.</p>'}`;
  }

  function onArea(key, ll) {
    const s = show(areaHtml(key, ll), () => areaHtml(key, ll));
    s.el.onclick = async (e) => {
      const btn = e.target.closest('button[data-act="mark"]');
      if (!btn) return;
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
      <a class="btn primary block" href="${link(id)}">Apri</a>`);
  }

  function onCluster(ids) {
    const { doc, today } = cur;
    const set = new Set(ids);
    const ps = live(doc.places).filter((p) => set.has(p.id));
    show(`<h2 id="${TITLE}">${ps.length} luoghi</h2>
      <div class="card list"><ul class="rows">${ps.map((p) => placeRow(doc, p, today)).join('')}</ul></div>`);
  }

  // ---- Wiring ----

  compute();
  const map = createMap(wrap, {
    view, geo, areas: data.areas, points: points(), focus: cams[view] || undefined,
    onArea, onPoint, onCluster,
    onAway: (away) => { reset.hidden = !away; },
    onLongPress: (lat, lon) => { location.hash = newHere(lat, lon); },
  });
  drawNums();

  el.onchange = (e) => {
    if (e.target.name === 'view') setView(e.target.value);
  };

  return {
    update(c) {
      cur = c;
      compute();
      map.update({ areas: data.areas, points: points() });
      drawNums();
      sheet?.draw();
    },
    destroy() {
      cams[view] = map.camera();
      sheet?.s.close(true);
      map.destroy();
    },
  };
}
