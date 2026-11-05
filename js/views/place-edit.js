// New / edit place (spec §4.2, §5). Position three ways: Cerca (Nominatim, only on tap), tap on the mini map,
// Posizione attuale. Country / region / province are computed from the position and stay editable.
// Query prefill for #luogo/nuovo: lat, lon, country, region, province, name, trip (after saving, a stop {place}
// is appended to that trip and the app goes to #viaggio/<trip>). Sections that change on their own (position,
// list editors) are redrawn alone, so typed text elsewhere is never lost; store changes do not touch the form.
import * as store from '../store.js';
import { createMap } from '../map.js';
import { newId } from '../logic.js';
import { searchPlaces } from '../search.js';
import { esc, CATEGORIES, safeUrl, parseNum, toast, MONTHS } from '../ui.js';

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const live = (list) => (list || []).filter((x) => !x.deleted);
const list = (s) => [...new Set(String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;

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
  const provinces = geo.italia.features.map((f) => ({ n: f.n, r: f.r })).sort((a, b) => a.n.localeCompare(b.n, 'it'));

  // Form state for the parts that are not plain inputs; plain inputs are read from the DOM on save.
  const f = old ? {
    cat: old.cat, status: old.status === 'visited' ? 'visited' : 'wish', rating: old.rating ?? null, fav: !!old.fav,
    lat: num(old.lat) ? old.lat : null, lon: num(old.lon) ? old.lon : null,
    country: old.country ?? null, region: old.region ?? null, province: old.province ?? null,
    todo: (old.todo || []).map((t) => ({ ...t })), links: (old.links || []).map((l) => ({ ...l })),
    months: [...(old.months || [])], visits: [...(old.visits || [])],
  } : {
    cat: 'altro', status: 'wish', rating: null, fav: false,
    lat: qNum('lat'), lon: qNum('lon'),
    country: q.get('country') || null, region: q.get('region') || null, province: q.get('province') || null,
    todo: [], links: [], months: [], visits: [],
  };
  if (!CATEGORIES.some((c) => c.key === f.cat)) f.cat = 'altro';
  if (f.lat === null || f.lon === null) f.lat = f.lon = null;
  const prefName = isNew ? q.get('name') || '' : '';

  let busy = false, seq = 0, view = f.country === 'IT' ? 'italia' : 'world';
  let found = [], searchMsg = '', locMsg = '', saving = false;
  let map = null;

  const hasPos = () => f.lat !== null;
  const home = old ? `#luogo/${encodeURIComponent(id)}` : '#luoghi';

  const lists = {
    todo: () => `<ul class="todo edit">${f.todo.map((t, i) => `<li><label class="check"><input type="checkbox" data-todo-done="${i}"${t.done ? ' checked' : ''} aria-label="Fatto"></label>`
      + `<input type="text" data-todo-text="${i}" value="${esc(t.text)}" maxlength="120" aria-label="Cosa da fare">`
      + `<button type="button" class="icon-btn" data-rm="todo:${i}" aria-label="Rimuovi">×</button></li>`).join('')}</ul>
      <button type="button" class="btn" data-add="todo">Aggiungi cosa da fare</button>`,
    links: () => f.links.map((l, i) => `<div class="link-row"><div class="two">
        <input type="text" data-link-label="${i}" value="${esc(l.label)}" placeholder="Nome" aria-label="Nome del link" maxlength="60">
        <input type="url" data-link-url="${i}" value="${esc(l.url)}" placeholder="https://…" aria-label="Indirizzo del link" autocapitalize="off" spellcheck="false"></div>
        <button type="button" class="icon-btn" data-rm="links:${i}" aria-label="Rimuovi link">×</button>
        <p class="error" data-link-err="${i}" hidden></p></div>`).join('')
      + '<button type="button" class="btn" data-add="links">Aggiungi link</button>',
    visits: () => f.visits.map((d, i) => `<div class="link-row"><input type="date" data-visit="${i}" value="${esc(d)}" aria-label="Data della visita">`
      + `<button type="button" class="icon-btn" data-rm="visits:${i}" aria-label="Rimuovi visita">×</button></div>`).join('')
      + '<button type="button" class="btn" data-add="visits">Aggiungi visita</button>',
  };

  function geoHtml() {
    const regs = f.country === 'IT' ? `<label class="field">Regione<select data-region>${opt('', '—', !f.region)}${regions.map((r) => opt(r, r, r === f.region)).join('')}</select></label>
      <label class="field">Provincia<select data-province>${opt('', '—', !f.province)}${provinces
    .filter((p) => !f.region || p.r === f.region).map((p) => opt(p.n, p.n, p.n === f.province)).join('')}</select></label>` : '';
    return `<label class="field">Paese<select data-country>${opt('', '—', !f.country)}${countries.map(([k, n]) => opt(k, n, k === f.country)).join('')}</select></label>${regs}`;
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

  let searching = false;

  el.innerHTML = `<div class="top"><a class="back" href="${esc(home)}" data-act="cancel">‹ Annulla</a><h1 class="grow">${isNew ? 'Nuovo luogo' : 'Modifica luogo'}</h1></div>
    <form class="form" novalidate>
      <label class="field">Nome<input type="text" name="name" maxlength="60" value="${esc(old ? old.name : prefName)}" autocomplete="off"></label>
      <p class="error" data-err="name" hidden></p>
      <label class="field">Categoria<select name="cat">${CATEGORIES.map((c) => opt(c.key, c.label, c.key === f.cat)).join('')}</select></label>
      <fieldset><legend>Stato</legend><div class="seg" role="radiogroup" aria-label="Stato">
        <label class="pick"><input type="radio" name="status" value="visited"${f.status === 'visited' ? ' checked' : ''}><span>Visitato</span></label>
        <label class="pick"><input type="radio" name="status" value="wish"${f.status === 'wish' ? ' checked' : ''}><span>Da visitare</span></label></div></fieldset>
      <fieldset><legend>Posizione</legend>
        <div class="two"><input type="search" data-search placeholder="Cerca un luogo" aria-label="Cerca un luogo" autocomplete="off"><button type="button" class="btn" data-act="search">Cerca</button></div>
        <div data-results></div>
        <button type="button" class="btn" data-act="here">Usa la posizione attuale</button>
        <div class="seg" role="radiogroup" aria-label="Mappa"><label class="pick"><input type="radio" name="pview" value="world"${view === 'world' ? ' checked' : ''}><span>Mondo</span></label>
          <label class="pick"><input type="radio" name="pview" value="italia"${view === 'italia' ? ' checked' : ''}><span>Italia</span></label></div>
        <div class="map-wrap mini" data-picker></div>
        <div data-pos></div>
      </fieldset>
      <fieldset><legend>Voto</legend><div class="stars" data-stars role="group" aria-label="Voto"></div></fieldset>
      <label class="check"><input type="checkbox" name="fav"${f.fav ? ' checked' : ''}><span>Preferito ♥</span></label>
      <label class="field">Tag<input type="text" name="tags" value="${esc((old?.tags || []).join(', '))}" placeholder="mare, estate" autocapitalize="off"><span class="field-hint">Separati da virgole</span></label>
      <label class="field">Compagni<input type="text" name="with" value="${esc((old?.with || []).join(', '))}" placeholder="Anna, Marco"><span class="field-hint">Separati da virgole</span></label>
      <label class="field">Note<textarea name="note">${esc(old?.note || '')}</textarea></label>
      <fieldset><legend>Cose da fare</legend><div data-list="todo"></div></fieldset>
      <fieldset><legend>Link</legend><div data-list="links"></div></fieldset>
      <fieldset><legend>Periodo ideale</legend><div class="months-row" data-months></div></fieldset>
      <label class="field">Budget stimato (€)<input type="text" inputmode="decimal" name="budget" value="${old && num(old.budget) ? esc(String(old.budget).replace('.', ',')) : ''}" placeholder="Facoltativo"></label>
      <p class="error" data-err="budget" hidden></p>
      <fieldset><legend>Visite</legend><div data-list="visits"></div></fieldset>
      <p class="error" data-err="form" hidden></p>
      <div class="btn-row"><button type="submit" class="btn primary" data-act="save">Salva</button><a class="btn" href="${esc(home)}" data-act="cancel">Annulla</a></div>
    </form>`;

  const $ = (s) => el.querySelector(s);
  const form = $('form');

  function drawStars() {
    $('[data-stars]').innerHTML = [1, 2, 3, 4, 5].map((n) =>
      `<button type="button" data-rate="${n}" class="${n <= (f.rating || 0) ? 'on' : ''}" aria-label="${n} su 5" aria-pressed="${n === f.rating}">★</button>`).join('');
  }
  function drawMonths() {
    $('[data-months]').innerHTML = MONTHS.map((m, i) =>
      `<label class="pick"><input type="checkbox" data-month="${i + 1}"${f.months.includes(i + 1) ? ' checked' : ''}><span>${m}</span></label>`).join('');
  }
  const drawList = (k) => { $(`[data-list="${k}"]`).innerHTML = lists[k](); };
  const drawPos = () => { $('[data-pos]').innerHTML = posHtml(); };
  const drawResults = () => { $('[data-results]').innerHTML = resultsHtml(); };

  /** Copies typed values of the list editors into `f` (before a redraw of a list). */
  function sync() {
    el.querySelectorAll('[data-todo-text]').forEach((i) => { f.todo[+i.dataset.todoText].text = i.value; });
    el.querySelectorAll('[data-todo-done]').forEach((i) => { f.todo[+i.dataset.todoDone].done = i.checked; });
    el.querySelectorAll('[data-link-label]').forEach((i) => { f.links[+i.dataset.linkLabel].label = i.value; });
    el.querySelectorAll('[data-link-url]').forEach((i) => { f.links[+i.dataset.linkUrl].url = i.value; });
    el.querySelectorAll('[data-visit]').forEach((i) => { f.visits[+i.dataset.visit] = i.value; });
  }

  // ---- Position ----

  const points = () => (hasPos() ? [{ id: 'sel', lat: f.lat, lon: f.lon, state: f.status === 'visited' ? 'visited' : 'wish' }] : []);

  function mapView() {
    return { view, level: 'provinces', geo, points: points(), interactive: true, onTap: (lat, lon) => setPos(lat, lon) };
  }

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
    if (focus) upd.focus = { lat: f.lat, lon: f.lon, zoom: view === 'italia' ? 6 : 8 };
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
    map.update(hasPos() ? { view, focus: { lat: f.lat, lon: f.lon, zoom: v === 'italia' ? 6 : 8 } } : { view });
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
    sync();
    for (const k of ['name', 'budget', 'form']) fail(k, '');
    el.querySelectorAll('[data-link-err]').forEach((p) => { p.hidden = true; });
    const name = form.elements.name.value.trim();
    let ok = true;
    if (!name || name.length > 60) {
      fail('name', 'Il nome è obbligatorio (massimo 60 caratteri)');
      ok = false;
    }
    const raw = form.elements.budget.value.trim();
    const budget = raw === '' ? null : parseNum(raw);
    if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
      fail('budget', 'Budget non valido: usa un numero uguale o maggiore di zero');
      ok = false;
    }
    const links = [];
    f.links.forEach((l, i) => {
      const url = String(l.url ?? '').trim(), label = String(l.label ?? '').trim();
      if (!url && !label) return;
      const u = safeUrl(url);
      if (!u) {
        const p = $(`[data-link-err="${i}"]`);
        p.textContent = 'Link non valido: usa un indirizzo http o https';
        p.hidden = false;
        ok = false;
      } else links.push({ label: label || u, url: u });
    });
    const visits = f.visits.filter(Boolean);
    if (visits.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
      fail('form', 'Controlla le date delle visite');
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
        name, cat: form.elements.cat.value, status: form.elements.status.value,
        lat: f.lat, lon: f.lon, country: f.country, region: f.region, province: f.province,
        rating: f.rating, fav: form.elements.fav.checked,
        tags: list(form.elements.tags.value), with: list(form.elements.with.value), note: form.elements.note.value.trim(),
        todo: f.todo.map((t) => ({ ...t, text: String(t.text).trim() })).filter((t) => t.text),
        links, months: [...f.months].sort((a, b) => a - b), budget, visits: [...new Set(visits)].sort(),
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

  drawStars();
  drawMonths();
  for (const k of Object.keys(lists)) drawList(k);
  drawPos();
  drawResults();
  map = createMap($('[data-picker]'), {
    ...mapView(),
    focus: hasPos() ? { lat: f.lat, lon: f.lon, zoom: view === 'italia' ? 6 : 8 } : undefined,
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
    else if (t.name === 'cat') f.cat = t.value;
    else if (t.dataset.month) {
      const m = +t.dataset.month;
      f.months = t.checked ? [...new Set([...f.months, m])] : f.months.filter((x) => x !== m);
    } else if (t.matches('[data-country]')) {
      f.country = t.value || null;
      if (f.country !== 'IT') f.region = f.province = null;
      drawPos();
    } else if (t.matches('[data-region]')) {
      f.region = t.value || null;
      if (f.province && f.region && provinces.find((p) => p.n === f.province)?.r !== f.region) f.province = null;
      drawPos();
    } else if (t.matches('[data-province]')) {
      f.province = t.value || null;
      if (f.province && !f.region) f.region = provinces.find((p) => p.n === f.province)?.r ?? null;
      drawPos();
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
      f.country = f.region = f.province = null;
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
    } else if (d.rate) {
      const n = +d.rate;
      f.rating = f.rating === n ? null : n;
      drawStars();
      $(`[data-rate="${n}"]`).focus();
    } else if (d.add) {
      sync();
      f[d.add].push(d.add === 'todo' ? { id: newId('a'), text: '', done: false } : d.add === 'links' ? { label: '', url: '' } : ctx.today);
      drawList(d.add);
      const fields = el.querySelectorAll(`[data-list="${d.add}"] input:not([type="checkbox"])`);
      fields[d.add === 'links' ? fields.length - 2 : fields.length - 1]?.focus();
    } else if (d.rm) {
      sync();
      const [k, i] = d.rm.split(':');
      f[k].splice(+i, 1);
      drawList(k);
      $(`[data-add="${k}"]`).focus();
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
