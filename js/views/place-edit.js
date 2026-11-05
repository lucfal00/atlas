// New / edit place (spec §4.2, §5). Position three ways: Cerca (Nominatim, only on tap), tap on the mini map,
// Posizione attuale. Country / region are computed from the position and stay editable.
// Query prefill for #luogo/nuovo: lat, lon, country, region, name, trip (after saving, a stop {place}
// is appended to that trip and the app goes to #viaggio/<trip>). The position section is redrawn alone, so typed
// text elsewhere is never lost; store changes do not touch the form.
import * as store from '../store.js';
import { createMap } from '../map.js';
import { searchPlaces } from '../search.js';
import { esc, CATEGORIES } from '../ui.js';

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const live = (list) => (list || []).filter((x) => !x.deleted);
const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function render(el, ctx) {
  const isNew = ctx.params[0] === 'nuovo' || !ctx.params[0];
  const id = isNew ? null : ctx.params[0];
  const old = isNew ? null : live(ctx.doc.places).find((x) => x.id === id);
  if (!isNew && !old) {
    el.innerHTML = '<div class="card empty"><h2>Luogo non trovato</h2><p class="muted">Il luogo non esiste più o è stato eliminato.</p><a class="btn primary" href="#luoghi">Vai ai luoghi</a></div>';
    return;
  }
  let geo;
  try {
    geo = await store.getGeo();
  } catch (e) {
    console.error(e);
    if (ctx.stale()) return;
    el.innerHTML = '<div class="card empty"><h2>Dati della mappa non disponibili</h2><button type="button" class="btn primary" data-act="retry">Riprova</button></div>';
    el.onclick = (e2) => { if (e2.target.closest('[data-act="retry"]')) ctx.refresh(); };
    return;
  }
  if (ctx.stale()) return;

  const q = ctx.query;
  const qNum = (k) => (q.has(k) && q.get(k) !== '' && Number.isFinite(+q.get(k)) ? +q.get(k) : null);
  const tripId = isNew ? q.get('trip') : null;
  const trip = tripId ? live(ctx.doc.trips).find((t) => t.id === tripId) : null;

  const countries = geo.world.features.map((f) => [f.k, f.n]).sort((a, b) => a[1].localeCompare(b[1], 'it'));
  const regions = [...new Set(geo.italia.features.map((f) => f.r))].sort((a, b) => a.localeCompare(b, 'it'));

  // Form state for the position; plain inputs are read from the DOM on save.
  const f = old ? {
    lat: num(old.lat) ? old.lat : null, lon: num(old.lon) ? old.lon : null, country: old.country ?? null, region: old.region ?? null,
  } : {
    lat: qNum('lat'), lon: qNum('lon'), country: q.get('country') || null, region: q.get('region') || null,
  };
  if (f.lat === null || f.lon === null) f.lat = f.lon = null;
  const cat = CATEGORIES.some((c) => c.key === old?.cat) ? old.cat : 'altro';
  const status = old?.status === 'visited' ? 'visited' : 'wish';
  const prefName = isNew ? q.get('name') || '' : '';

  let busy = false, seq = 0, view = f.country === 'IT' ? 'italia' : 'world';
  let found = [], searchMsg = '', locMsg = '', saving = false, searching = false;
  let map = null;

  const hasPos = () => f.lat !== null;
  const home = old ? `#luogo/${encodeURIComponent(id)}` : '#luoghi';

  function geoHtml() {
    const reg = f.country === 'IT' ? `<label class="field">Regione<select data-region>${opt('', '—', !f.region)}${regions.map((r) => opt(r, r, r === f.region)).join('')}</select></label>` : '';
    return `<label class="field">Paese<select data-country>${opt('', '—', !f.country)}${countries.map(([k, n]) => opt(k, n, k === f.country)).join('')}</select></label>${reg}`;
  }

  function posHtml() {
    return `${hasPos() ? `<p>Coordinate: <b>${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}</b> <button type="button" class="btn" data-act="clear-pos">Rimuovi posizione</button></p>`
      : '<p class="muted">Nessuna posizione: cerca un luogo, tocca la mappa o usa la posizione attuale.</p>'}
      ${locMsg ? `<p class="${busy ? 'muted' : 'error'}" role="status">${esc(locMsg)}</p>` : ''}
      <div class="geo-fields">${geoHtml()}</div>`;
  }

  function resultsHtml() {
    return `${searchMsg ? `<p class="${searching ? 'muted' : 'error'}" role="status">${esc(searchMsg)}</p>` : ''}
      ${found.length ? `<ul class="rows">${found.map((r, i) => `<li><button type="button" class="row" data-pick="${i}"><span><b>${esc(r.name)}</b><small>${esc(r.label)}</small></span></button></li>`).join('')}</ul>` : ''}`;
  }

  el.innerHTML = `<div class="top"><a class="back" href="${esc(home)}" data-act="cancel">‹ Annulla</a><h1 class="grow">${isNew ? 'Nuovo luogo' : 'Modifica luogo'}</h1></div>
    <form class="form" novalidate>
      <label class="field">Nome<input type="text" name="name" maxlength="60" value="${esc(old ? old.name : prefName)}" autocomplete="off"></label>
      <p class="error" data-err="name" hidden></p>
      <label class="field">Categoria<select name="cat">${CATEGORIES.map((c) => opt(c.key, c.label, c.key === cat)).join('')}</select></label>
      <fieldset><legend>Stato</legend><div class="seg" role="radiogroup" aria-label="Stato">
        <label class="pick"><input type="radio" name="status" value="visited"${status === 'visited' ? ' checked' : ''}><span>Visitato</span></label>
        <label class="pick"><input type="radio" name="status" value="wish"${status === 'wish' ? ' checked' : ''}><span>Da visitare</span></label></div></fieldset>
      <label class="field" data-date${status === 'visited' ? '' : ' hidden'}>Data<input type="date" name="date" value="${esc(old?.date || '')}"></label>
      <p class="error" data-err="date" hidden></p>
      <fieldset><legend>Posizione</legend>
        <div class="two"><input type="search" data-search placeholder="Cerca un luogo" aria-label="Cerca un luogo" autocomplete="off"><button type="button" class="btn" data-act="search">Cerca</button></div>
        <div data-results></div>
        <button type="button" class="btn" data-act="here">Usa la posizione attuale</button>
        <div class="seg" role="radiogroup" aria-label="Mappa"><label class="pick"><input type="radio" name="pview" value="world"${view === 'world' ? ' checked' : ''}><span>Mondo</span></label>
          <label class="pick"><input type="radio" name="pview" value="italia"${view === 'italia' ? ' checked' : ''}><span>Italia</span></label></div>
        <div class="map-wrap mini" data-picker></div>
        <div data-pos></div>
      </fieldset>
      <label class="field">Nota<textarea name="note">${esc(old?.note || '')}</textarea></label>
      <p class="error" data-err="form" hidden></p>
      <div class="btn-row"><button type="submit" class="btn primary" data-act="save">Salva</button><a class="btn" href="${esc(home)}" data-act="cancel">Annulla</a></div>
    </form>`;

  const $ = (s) => el.querySelector(s);
  const form = $('form');
  const drawPos = () => { $('[data-pos]').innerHTML = posHtml(); };
  const drawResults = () => { $('[data-results]').innerHTML = resultsHtml(); };

  // ---- Position ----

  const points = () => (hasPos() ? [{ id: 'sel', lat: f.lat, lon: f.lon, state: form.elements.status.value }] : []);
  const zoomOf = (v) => (v === 'italia' ? 6 : 8);

  /** New position: store it, compute the areas, redraw only the position parts. `focus` re-frames the map. */
  async function setPos(lat, lon, focus = false, name = '') {
    f.lat = +lat.toFixed(6);
    f.lon = +lon.toFixed(6);
    if (name && !form.elements.name.value.trim()) form.elements.name.value = name.slice(0, 60);
    const mine = ++seq;
    busy = true;
    locMsg = 'Calcolo di paese e regione…';
    drawPos();
    const upd = { points: points() };
    if (focus) upd.focus = { lat: f.lat, lon: f.lon, zoom: zoomOf(view) };
    map.update(upd);
    let r = null;
    try {
      r = await store.locateCoords(f.lat, f.lon);
    } catch (e) {
      console.error(e);
    }
    if (mine !== seq || ctx.stale()) return;
    busy = false;
    locMsg = r ? '' : 'Paese e regione non calcolati: sceglili a mano.';
    if (r) Object.assign(f, r);
    drawPos();
    if (r?.country === 'IT' && view === 'world' && focus) {
      view = 'italia';
      form.elements.pview.value = 'italia';
      map.update({ view, focus: { lat: f.lat, lon: f.lon, zoom: 6 } });
    }
  }

  function setView(v) {
    view = v;
    map.update(hasPos() ? { view, focus: { lat: f.lat, lon: f.lon, zoom: zoomOf(v) } } : { view });
  }

  async function doSearch() {
    const text = $('[data-search]').value.trim();
    if (!text || searching) return;
    searching = true;
    found = [];
    searchMsg = 'Ricerca in corso…';
    drawResults();
    try {
      found = await searchPlaces(text);
      searchMsg = found.length ? '' : 'Nessun risultato.';
    } catch (e) {
      searchMsg = e.message === 'offline' ? 'Serve internet per cercare: tocca la mappa o usa la posizione' : 'Ricerca non riuscita. Riprova più tardi.';
    }
    searching = false;
    if (ctx.stale()) return;
    drawResults();
  }

  function here() {
    if (!navigator.geolocation) {
      locMsg = 'Posizione non disponibile: tocca la mappa o cerca';
      return drawPos();
    }
    busy = true;
    locMsg = 'Ricerca della posizione…';
    drawPos();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (ctx.stale()) return;
        setPos(pos.coords.latitude, pos.coords.longitude, true);
      },
      () => {
        if (ctx.stale()) return;
        busy = false;
        locMsg = 'Posizione non disponibile: tocca la mappa o cerca';
        drawPos();
      },
      { timeout: 10000 },
    );
  }

  // ---- Save ----

  function fail(key, msg) {
    const p = $(`[data-err="${key}"]`);
    p.textContent = msg;
    p.hidden = !msg;
  }

  async function save() {
    if (saving) return;
    for (const k of ['name', 'date', 'form']) fail(k, '');
    const name = form.elements.name.value.trim();
    const visited = form.elements.status.value === 'visited';
    const date = visited ? form.elements.date.value : '';
    let ok = true;
    if (!name || name.length > 60) {
      fail('name', 'Il nome è obbligatorio (massimo 60 caratteri)');
      ok = false;
    }
    if (date && !DAY.test(date)) {
      fail('date', 'Data non valida');
      ok = false;
    }
    if (!ok) {
      (el.querySelector('.error:not([hidden])') || form).scrollIntoView?.({ block: 'center' });
      return;
    }
    saving = true;
    const btn = $('[data-act="save"]');
    btn.disabled = true;
    try {
      const pid = await store.savePlace({
        ...(id ? { id } : {}),
        name, cat: form.elements.cat.value, status: visited ? 'visited' : 'wish', date: date || null,
        lat: f.lat, lon: f.lon, country: f.country, region: f.region, note: form.elements.note.value.trim(),
      });
      if (trip) {
        const t = store.getDoc().trips.find((x) => x.id === trip.id && !x.deleted);
        if (t && !(t.stops || []).some((s) => s.place === pid)) await store.saveTrip({ id: t.id, stops: [...(t.stops || []), { place: pid }] });
        location.hash = `#viaggio/${encodeURIComponent(trip.id)}`;
      } else location.hash = `#luogo/${encodeURIComponent(pid)}`;
    } catch (e) {
      console.error(e);
      saving = false;
      btn.disabled = false;
      fail('form', 'Impossibile salvare. Riprova.');
    }
  }

  // ---- Wiring ----

  drawPos();
  drawResults();
  map = createMap($('[data-picker]'), {
    view, geo, points: points(), interactive: true, onTap: (lat, lon) => setPos(lat, lon),
    focus: hasPos() ? { lat: f.lat, lon: f.lon, zoom: zoomOf(view) } : undefined,
  });
  if (isNew && hasPos() && !q.get('country')) setPos(f.lat, f.lon);   // prefilled by lat / lon only: compute the areas

  el.onsubmit = (e) => {
    e.preventDefault();
    if (document.activeElement === $('[data-search]')) doSearch();    // Enter in the search box is a search, not a save
    else save();
  };
  el.onchange = (e) => {
    const t = e.target;
    if (t.name === 'pview') setView(t.value);
    else if (t.name === 'status') {
      $('[data-date]').hidden = t.value !== 'visited';
      map.update({ points: points() });
    } else if (t.matches('[data-country]')) {
      f.country = t.value || null;
      if (f.country !== 'IT') f.region = null;
      drawPos();
    } else if (t.matches('[data-region]')) {
      f.region = t.value || null;
    }
  };
  el.onclick = (e) => {
    const t = e.target.closest('button, a[data-act="cancel"]');
    if (!t || !el.contains(t)) return;
    const d = t.dataset;
    if (d.act === 'cancel') {
      e.preventDefault();
      if (history.length > 1) history.back();
      else location.hash = home;
    } else if (d.act === 'search') doSearch();
    else if (d.act === 'here') here();
    else if (d.act === 'clear-pos') {
      seq++;
      busy = false;
      f.lat = f.lon = null;
      f.country = f.region = null;
      locMsg = '';
      drawPos();
      map.update({ points: [] });
    } else if (d.pick) {
      const r = found[+d.pick];
      if (!r) return;
      found = [];
      searchMsg = '';
      drawResults();
      setPos(r.lat, r.lon, true, r.name);
    }
  };

  return {
    update() {},                                     // store changes never reset the form
    destroy() {
      seq++;
      map?.destroy();
    },
  };
}
