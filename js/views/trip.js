// Trip page (spec §4.3): header, ordered stops (reorder, add, remove), route map, total spend, note, edit / delete.
// Every stop change saves at once via saveTrip.
import * as store from '../store.js';
import { createMap } from '../map.js';
import { tripState, placeState, fold } from '../logic.js';
import { esc, catLabel, openSheet, toast, fmtRange, fmtMoney } from '../ui.js';

const LABEL = { current: 'In corso', planned: 'In programma', past: 'Passato' };
const PILL = { current: 'visited', planned: 'wish', past: '' };
const live = (list) => (list || []).filter((x) => !x.deleted);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const enc = encodeURIComponent;

export async function render(el, ctx) {
  const id = ctx.params[0];
  const find = (doc) => live(doc.trips).find((t) => t.id === id);
  if (!find(ctx.doc)) {
    el.innerHTML = '<div class="card empty"><h2>Viaggio non trovato</h2><p class="muted">Il viaggio non esiste più o è stato eliminato.</p><a class="btn primary" href="#viaggi">Vai ai viaggi</a></div>';
    return;
  }
  let geo = null;
  try {
    geo = await store.getGeo();
  } catch (e) {
    console.error(e);                                // everything but the route map works without the geographic data
  }
  if (ctx.stale()) return;

  let cur = ctx, map = null, gone = false;

  async function patch(fields) {
    const t = find(cur.doc);
    if (!t) return;
    try {
      await store.saveTrip({ id: t.id, ...fields });
    } catch (e) {
      console.error(e);
      toast('Impossibile salvare');
    }
  }

  const placeMap = () => new Map(live(cur.doc.places).map((p) => [p.id, p]));

  function stopsHtml(t) {
    const pm = placeMap();
    const vis = (t.stops || []).map((s, i) => ({ i, p: pm.get(s.place) })).filter((x) => x.p);
    const rows = vis.map(({ i, p }, k) => (
      `<li><a class="row" href="#luogo/${esc(enc(p.id))}"><span><b>${esc(p.name || 'Senza nome')}</b>`
        + `<small>${esc(catLabel(p.cat))}</small></span></a>`
        + `<button type="button" class="icon-btn" data-up="${i}" aria-label="Sposta su"${k === 0 ? ' disabled' : ''}>↑</button>`
        + `<button type="button" class="icon-btn" data-down="${i}" aria-label="Sposta giù"${k === vis.length - 1 ? ' disabled' : ''}>↓</button>`
        + `<button type="button" class="icon-btn" data-rm-stop="${i}" aria-label="Rimuovi tappa ${esc(p.name || '')}">×</button></li>`));
    return `<section><div class="section-head"><h2>Tappe</h2></div>
      <div class="card list">${rows.length ? `<ul class="rows">${rows.join('')}</ul>` : '<p class="muted" style="padding:12px 16px">Nessuna tappa.</p>'}</div>
      <button type="button" class="btn" data-act="add-stop">Aggiungi tappa</button></section>`;
  }

  function routeHtml(t) {
    const home = cur.doc.settings?.home;
    const pm = placeMap();
    const pts = (t.stops || []).map((s) => pm.get(s.place)).filter((p) => p && num(p.lat) && num(p.lon));
    if (!geo || !pts.length || !home || !num(home.lat) || !num(home.lon)) return '';
    return `<section><div class="section-head"><h2>Percorso</h2></div><div data-map></div></section>`;
  }

  function bodyHtml(t) {
    const st = tripState(t, cur.today);
    return `<div class="top"><a class="back" href="#viaggi" aria-label="Viaggi">‹ Viaggi</a></div>
      <h1>${esc(t.title || 'Viaggio')}</h1>
      <p class="map-sheet-meta"><span>${esc(fmtRange(t.from, t.to))}</span> <span class="pill ${PILL[st]}">${LABEL[st]}</span></p>
      ${stopsHtml(t)}${routeHtml(t)}
      ${t.spend > 0 ? `<section class="card"><h2>Spesa totale</h2><p>${esc(fmtMoney(t.spend))}</p></section>` : ''}
      ${t.note ? `<section class="card"><h2>Nota</h2><p style="white-space:pre-wrap">${esc(t.note)}</p></section>` : ''}
      <div class="danger-zone"><a class="btn" href="#viaggio/${esc(enc(t.id))}/modifica">Modifica</a><button type="button" class="btn danger" data-act="delete">Elimina</button></div>`;
  }

  function draw() {
    const t = find(cur.doc);
    if (!t) {
      if (!gone) location.hash = '#viaggi';          // deleted elsewhere (sync)
      return;
    }
    map?.destroy();
    map = null;
    el.innerHTML = bodyHtml(t);
    const host = el.querySelector('[data-map]');
    if (host) {
      const home = cur.doc.settings.home, pm = placeMap();
      const stops = (t.stops || []).map((s) => pm.get(s.place)).filter((p) => p && num(p.lat) && num(p.lon));
      const italy = stops.every((p) => p.country === 'IT') && home.lat > 35 && home.lat < 48 && home.lon > 6 && home.lon < 19;
      host.className = 'map-wrap mini';
      map = createMap(host, {
        view: italy ? 'italia' : 'world', geo, interactive: false,
        points: stops.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, state: placeState(cur.doc, p, cur.today), partner: p.partner === true })),
        lines: [[home.lat, home.lon], ...stops.map((p) => [p.lat, p.lon]), [home.lat, home.lon]],
        fit: 'lines',
      });
    }
  }

  // ---- Sheets ----

  function addStopSheet() {
    const t = find(cur.doc);
    if (!t) return;
    const s = openSheet(`<h2>Aggiungi tappa</h2>
      <input type="search" data-q placeholder="Cerca per nome" aria-label="Cerca per nome" autocomplete="off">
      <div data-list></div>
      <div class="btn-row"><a class="btn primary" href="#luogo/nuovo?trip=${esc(enc(t.id))}">Nuovo luogo</a></div>`);
    const list = s.el.querySelector('[data-list]'), q = s.el.querySelector('[data-q]');
    const paint = () => {
      const used = new Set((find(cur.doc)?.stops || []).map((x) => x.place));
      const needle = fold(q.value.trim());
      const items = live(cur.doc.places).filter((p) => !used.has(p.id) && (!needle || fold(p.name).includes(needle)))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));
      list.innerHTML = items.length
        ? `<div class="card list"><ul class="rows">${items.map((p) => `<li><button type="button" class="row" data-pick="${esc(p.id)}"><span><b>${esc(p.name || 'Senza nome')}</b><small>${esc(catLabel(p.cat))}</small></span></button></li>`).join('')}</ul></div>`
        : '<p class="muted">Nessun luogo trovato.</p>';
    };
    paint();
    q.oninput = paint;
    s.el.onclick = async (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      const cu = find(cur.doc);
      s.close();
      if (cu) await patch({ stops: [...(cu.stops || []), { place: b.dataset.pick }] });
    };
  }

  function confirmDelete() {
    const t = find(cur.doc);
    if (!t) return;
    const s = openSheet(`<h2>Eliminare «${esc(t.title)}»?</h2>
      <p class="muted">Il viaggio sparirà dall’elenco e dalla mappa; i luoghi restano.</p>
      <div class="btn-row"><button type="button" class="btn" data-act="no">Annulla</button><button type="button" class="btn danger" data-act="yes">Elimina</button></div>`);
    s.el.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'no') return s.close();
      if (b.dataset.act !== 'yes') return;
      b.disabled = true;
      try {
        gone = true;
        await store.deleteTrip(t.id);
        s.close(true);
        toast('Viaggio eliminato');
        location.hash = '#viaggi';
      } catch (err) {
        gone = false;
        console.error(err);
        b.disabled = false;
        toast('Impossibile eliminare');
      }
    };
  }

  draw();

  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    const t = find(cur.doc);
    if (!t) return;
    const d = b.dataset;
    if (d.act === 'add-stop') addStopSheet();
    else if (d.act === 'delete') confirmDelete();
    else if (d.rmStop !== undefined) await patch({ stops: t.stops.filter((_, i) => i !== +d.rmStop) });
    else if (d.up !== undefined || d.down !== undefined) {
      const i = +(d.up ?? d.down), dir = d.up !== undefined ? -1 : 1;
      const pm = placeMap();
      let j = i + dir;
      while (j >= 0 && j < t.stops.length && !pm.has(t.stops[j].place)) j += dir;   // skip stops of deleted places
      if (j < 0 || j >= t.stops.length) return;
      const stops = [...t.stops];
      [stops[i], stops[j]] = [stops[j], stops[i]];
      await patch({ stops });
    }
  };

  return {
    update(c) {
      cur = c;
      const y = window.scrollY;
      draw();
      window.scrollTo?.(0, y);
    },
    destroy() {
      map?.destroy();
      map = null;
    },
  };
}
