// Place detail (spec §4.2): header with inline rating / favourite, mini map, coordinates and areas, Apri in Mappe,
// visits (own dates + trip stops), note, to-do checklist, links, tags, companions, wish fields, edit / delete.
// Every save passes country / region / province unchanged, so the geo rule never recomputes them.
import * as store from '../store.js';
import { createMap } from '../map.js';
import { placeState, newId } from '../logic.js';
import { esc, safeUrl, catLabel, openSheet, toast, fmtFull, fmtMoney, MONTHS } from '../ui.js';

const LABEL = { visited: 'Visitato', planned: 'In programma', wish: 'Da visitare' };
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const live = (list) => (list || []).filter((x) => !x.deleted);
const day = (k) => (typeof k === 'string' && k.length === 10 ? fmtFull(k) : '');

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
  let visitDate = ctx.today;

  /** Saves a patch of the place; geography is passed through unchanged. */
  async function patch(fields) {
    const p = find(cur.doc);
    if (!p) return;
    try {
      await store.savePlace({ id: p.id, country: p.country ?? null, region: p.region ?? null, province: p.province ?? null, ...fields });
    } catch (e) {
      console.error(e);
      toast('Impossibile salvare');
    }
  }

  function visitsOf(p) {
    const own = (p.visits || []).map((d) => ({ date: d, own: true }));
    const stops = [];
    for (const t of live(cur.doc.trips)) {
      for (const s of t.stops || []) if (s.place === p.id) stops.push({ date: s.from ?? t.from, trip: t });
    }
    return [...own, ...stops].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  function areaLine(p) {
    const parts = [p.country ? names.get(p.country) ?? p.country : '', p.region, p.province].filter(Boolean);
    return parts.length ? parts.map(esc).join(' · ') : '—';
  }

  function section(title, inner) {
    return `<section class="card"><h2>${title}</h2>${inner}</section>`;
  }

  function bodyHtml(p) {
    const state = placeState(cur.doc, p, cur.today);
    const hasPos = num(p.lat) && num(p.lon);
    const visits = visitsOf(p);
    const links = (p.links || []).map((l) => {
      const u = safeUrl(l.url);
      const label = esc(l.label || l.url || 'Link');
      return u ? `<li><a href="${esc(u)}" target="_blank" rel="noopener">${label}</a></li>` : `<li>${label}</li>`;
    });
    const chips = (list) => `<div class="chips">${list.map((t) => `<span class="chip static">${esc(t)}</span>`).join('')}</div>`;
    const months = (p.months || []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12).sort((a, b) => a - b);

    return `<div class="top">
        <a class="back" href="#luoghi" aria-label="Luoghi">‹ Luoghi</a><span class="grow"></span>
        <button type="button" class="icon-btn${p.fav ? ' on' : ''}" data-act="fav" aria-pressed="${!!p.fav}" aria-label="Preferito">♥</button>
      </div>
      <h1>${esc(p.name || 'Senza nome')}</h1>
      <p class="map-sheet-meta"><small>${esc(catLabel(p.cat))}</small> <span class="pill ${state}">${LABEL[state]}</span></p>
      <div class="stars" role="group" aria-label="Voto">${[1, 2, 3, 4, 5].map((n) =>
        `<button type="button" data-rate="${n}" class="${n <= (p.rating || 0) ? 'on' : ''}" aria-label="${n} su 5" aria-pressed="${n === p.rating}">★</button>`).join('')}</div>
      ${hasPos ? '<div data-map></div>' : ''}
      <div class="card">
        ${hasPos ? `<p><b>Coordinate</b><br>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</p>` : '<p class="muted">Posizione non impostata.</p>'}
        <p><b>Paese · regione · provincia</b><br>${areaLine(p)}</p>
        ${hasPos ? `<a class="btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener">Apri in Mappe</a>` : ''}
      </div>
      ${section('Visite', `${visits.length ? `<ul class="rows">${visits.map((v) => (v.own
        ? `<li><span class="row"><span><b>${esc(day(v.date))}</b></span></span><button type="button" class="icon-btn" data-del-visit="${esc(v.date)}" aria-label="Rimuovi visita del ${esc(day(v.date))}">×</button></li>`
        : `<li><a class="row" href="#viaggio/${esc(encodeURIComponent(v.trip.id))}"><span><b>${esc(day(v.date))}</b><small>${esc(v.trip.title || 'Viaggio')}</small></span></a></li>`)).join('')}</ul>`
        : '<p class="muted">Nessuna visita.</p>'}
        <div class="two"><input type="date" data-visit-date value="${esc(visitDate)}" aria-label="Data della visita"><button type="button" class="btn" data-act="add-visit">Aggiungi visita</button></div>`)}
      ${p.note ? section('Note', `<p style="white-space:pre-wrap">${esc(p.note)}</p>`) : ''}
      ${section('Cose da fare', `${(p.todo || []).length ? `<ul class="todo">${p.todo.map((t) =>
        `<li${t.done ? ' class="done"' : ''}><label class="check"><input type="checkbox" data-todo="${esc(t.id)}"${t.done ? ' checked' : ''}><span>${esc(t.text)}</span></label></li>`).join('')}</ul>` : ''}
        <div class="two"><input type="text" data-todo-text maxlength="120" placeholder="Nuova cosa da fare" aria-label="Nuova cosa da fare"><button type="button" class="btn" data-act="add-todo">Aggiungi</button></div>`)}
      ${links.length ? section('Link', `<ul class="rows">${links.join('')}</ul>`) : ''}
      ${(p.tags || []).length ? section('Tag', chips(p.tags.map((t) => `#${t}`))) : ''}
      ${(p.with || []).length ? section('Compagni', chips(p.with)) : ''}
      ${state === 'wish' && months.length ? section('Periodo ideale', chips(months.map((m) => MONTHS[m - 1]))) : ''}
      ${state === 'wish' && num(p.budget) ? section('Budget stimato', `<p>${esc(fmtMoney(p.budget))}</p>`) : ''}
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
        view, level: 'provinces', geo, interactive: false,
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

  el.onchange = (e) => {
    const t = e.target;
    if (t.matches('[data-visit-date]')) visitDate = t.value;
    else if (t.dataset.todo) {
      const p = find(cur.doc);
      patch({ todo: (p.todo || []).map((x) => (x.id === t.dataset.todo ? { ...x, done: t.checked } : x)) });
    }
  };
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    const p = find(cur.doc);
    if (!p) return;
    if (b.dataset.rate) {
      const r = +b.dataset.rate;
      await patch({ rating: p.rating === r ? null : r });
    } else if (b.dataset.act === 'fav') {
      await patch({ fav: !p.fav });
    } else if (b.dataset.act === 'add-visit') {
      const input = el.querySelector('[data-visit-date]');
      const d = input.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return toast('Scegli una data');
      if ((p.visits || []).includes(d)) return toast('Visita già presente');
      visitDate = d;
      await patch({ visits: [...(p.visits || []), d].sort() });
    } else if (b.dataset.delVisit) {
      await patch({ visits: (p.visits || []).filter((d) => d !== b.dataset.delVisit) });
    } else if (b.dataset.act === 'add-todo') {
      const input = el.querySelector('[data-todo-text]');
      const text = input.value.trim();
      if (!text) return input.focus();
      await patch({ todo: [...(p.todo || []), { id: newId('a'), text, done: false }] });
      el.querySelector('[data-todo-text]')?.focus();
    } else if (b.dataset.act === 'delete') {
      confirmDelete();
    }
  };

  return {
    update(c) {
      cur = c;
      const typed = el.querySelector('[data-todo-text]')?.value;   // a background change must not eat a half-typed item
      draw();
      const box = el.querySelector('[data-todo-text]');
      if (typed && box) box.value = typed;
    },
    destroy() {
      map?.destroy();
      map = null;
    },
  };
}
