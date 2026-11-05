// Place detail (spec §4.2): name, category, state, date, note, mini map, Apri in Mappe, trips that include it,
// edit / delete. Country and region are never recomputed here.
import * as store from '../store.js';
import { createMap } from '../map.js';
import { placeState } from '../logic.js';
import { esc, catLabel, openSheet, toast, fmtFull, fmtRange } from '../ui.js';

const LABEL = { visited: 'Visitato', wish: 'Da visitare' };
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const live = (list) => (list || []).filter((x) => !x.deleted);

const isApple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1);

/** Maps link: Apple Maps on iOS, Google Maps elsewhere. */
export function mapsUrl(p, apple = isApple()) {
  const ll = `${p.lat},${p.lon}`;
  return apple
    ? `https://maps.apple.com/?ll=${ll}&q=${encodeURIComponent(p.name || 'Luogo')}`
    : `https://www.google.com/maps/search/?api=1&query=${ll}`;
}

export async function render(el, ctx) {
  const id = ctx.params[0];
  const find = (doc) => live(doc.places).find((x) => x.id === id);
  if (!find(ctx.doc)) {
    el.innerHTML = '<div class="card empty"><h2>Luogo non trovato</h2><p class="muted">Il luogo non esiste più o è stato eliminato.</p><a class="btn primary" href="#luoghi">Vai ai luoghi</a></div>';
    return;
  }
  let geo = null, names = new Map();
  try {
    geo = await store.getGeo();
    names = new Map(geo.world.features.map((f) => [f.k, f.n]));
  } catch (e) {
    console.error(e);                                // the page works without the mini map; codes replace names
  }
  if (ctx.stale()) return;

  let cur = ctx, map = null, gone = false;

  function bodyHtml(p) {
    const state = placeState(cur.doc, p, cur.today);
    const hasPos = num(p.lat) && num(p.lon);
    const area = [p.country ? names.get(p.country) ?? p.country : '', p.region].filter(Boolean).map(esc).join(' · ');
    const trips = live(cur.doc.trips).filter((t) => (t.stops || []).some((s) => s.place === p.id))
      .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
    return `<div class="top"><a class="back" href="#luoghi" aria-label="Luoghi">‹ Luoghi</a></div>
      <h1>${esc(p.name || 'Senza nome')}</h1>
      <p class="map-sheet-meta"><small>${esc(catLabel(p.cat))}</small> <span class="pill ${state}">${LABEL[state]}</span>`
      + `${state === 'visited' && p.date ? `<small>${esc(fmtFull(p.date))}</small>` : ''}</p>
      ${hasPos ? '<div data-map></div>' : ''}
      <div class="card">
        ${area ? `<p>${area}</p>` : ''}
        ${hasPos ? `<a class="btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener">Apri in Mappe</a>` : '<p class="muted">Posizione non impostata.</p>'}
      </div>
      ${p.note ? `<section class="card"><h2>Nota</h2><p style="white-space:pre-wrap">${esc(p.note)}</p></section>` : ''}
      ${trips.length ? `<section><div class="section-head"><h2>Viaggi</h2></div><div class="card list"><ul class="rows">${trips.map((t) =>
        `<li><a class="row" href="#viaggio/${esc(encodeURIComponent(t.id))}"><span><b>${esc(t.title || 'Viaggio')}</b><small>${esc(fmtRange(t.from, t.to))}</small></span></a></li>`).join('')}</ul></div></section>` : ''}
      <div class="danger-zone">
        <a class="btn" href="#luogo/${esc(encodeURIComponent(p.id))}/modifica">Modifica</a>
        <button type="button" class="btn danger" data-act="delete">Elimina</button>
      </div>`;
  }

  function draw() {
    const p = find(cur.doc);
    if (!p) {
      if (!gone) location.hash = '#luoghi';          // deleted elsewhere (sync)
      return;
    }
    map?.destroy();
    map = null;
    el.innerHTML = bodyHtml(p);
    const host = el.querySelector('[data-map]');
    if (host && geo) {
      const view = p.country === 'IT' ? 'italia' : 'world';
      host.className = 'map-wrap mini';
      map = createMap(host, {
        view, geo, interactive: false,
        points: [{ id: p.id, lat: p.lat, lon: p.lon, state: placeState(cur.doc, p, cur.today) }],
        focus: { lat: p.lat, lon: p.lon, zoom: view === 'italia' ? 6 : 8 },
      });
    } else host?.remove();
  }

  function confirmDelete() {
    const p = find(cur.doc);
    if (!p) return;
    const s = openSheet(`<h2>Eliminare «${esc(p.name)}»?</h2>
      <p class="muted">Il luogo sparirà dall’elenco e dalla mappa; le tappe dei viaggi che lo usano resteranno senza luogo.</p>
      <div class="btn-row"><button type="button" class="btn" data-act="no">Annulla</button><button type="button" class="btn danger" data-act="yes">Elimina</button></div>`);
    s.el.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'no') return s.close();
      if (b.dataset.act !== 'yes') return;
      b.disabled = true;
      try {
        gone = true;
        await store.deletePlace(p.id);
        s.close(true);
        toast('Luogo eliminato');
        location.hash = '#luoghi';
      } catch (err) {
        gone = false;
        console.error(err);
        b.disabled = false;
        toast('Impossibile eliminare');
      }
    };
  }

  draw();

  el.onclick = (e) => {
    if (e.target.closest('[data-act="delete"]')) confirmDelete();
  };

  return {
    update(c) {
      cur = c;
      draw();
    },
    destroy() {
      map?.destroy();
      map = null;
    },
  };
}
