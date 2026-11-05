// Trip page (spec §4.3): header, ordered stops (reorder, add, remove), route map, costs vs budget with expense list,
// diary days (+ pages outside the dates), note, links, edit / delete. Every change saves at once via saveTrip.
import * as store from '../store.js';
import { createMap } from '../map.js';
import { tripState, nights, tripSpend, tripKm, placeState, newId, fold, addDays, COST_CATS as COST_KEYS } from '../logic.js';
import { esc, safeUrl, catLabel, openSheet, toast, fmtRange, fmtDayRow, fmtMoney, fmtKm, parseNum, COST_CATS } from '../ui.js';

const LABEL = { current: 'In corso', planned: 'In programma', past: 'Passato' };
const PILL = { current: 'visited', planned: 'planned', past: 'wish' };
const live = (list) => (list || []).filter((x) => !x.deleted);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const catName = (k) => COST_CATS.find((c) => c.key === k)?.label ?? 'Altro';
const enc = encodeURIComponent;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every day key from `from` to `to` (capped, in case of a corrupt import). */
function dayRange(from, to) {
  const out = [];
  for (let k = from, n = 0; k <= to && n < 800; k = addDays(k, 1), n++) out.push(k);
  return out;
}

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
    const vis = (t.stops || []).map((s, i) => ({ s, i, p: pm.get(s.place) })).filter((x) => x.p);
    const rows = vis.map(({ s, i, p }, k) => {
      const when = s.from ? fmtRange(s.from, s.to || s.from) : '';
      return `<li><a class="row" href="#luogo/${esc(enc(p.id))}"><span><b>${esc(p.name || 'Senza nome')}</b>`
        + `<small>${esc(catLabel(p.cat))}${when ? ` · ${esc(when)}` : ''}</small></span></a>`
        + `<button type="button" class="icon-btn" data-up="${i}" aria-label="Sposta su"${k === 0 ? ' disabled' : ''}>↑</button>`
        + `<button type="button" class="icon-btn" data-down="${i}" aria-label="Sposta giù"${k === vis.length - 1 ? ' disabled' : ''}>↓</button>`
        + `<button type="button" class="icon-btn" data-rm-stop="${i}" aria-label="Rimuovi tappa ${esc(p.name || '')}">×</button></li>`;
    });
    return `<section><div class="section-head"><h2>Tappe</h2></div>
      <div class="card list">${rows.length ? `<ul class="rows">${rows.join('')}</ul>` : '<p class="muted" style="padding:12px 16px">Nessuna tappa.</p>'}</div>
      <button type="button" class="btn" data-act="add-stop">Aggiungi tappa</button></section>`;
  }

  function routeHtml(t) {
    const home = cur.doc.settings?.home;
    const pm = placeMap();
    const pts = (t.stops || []).map((s) => pm.get(s.place)).filter((p) => p && num(p.lat) && num(p.lon));
    if (!geo || !pts.length || !home || !num(home.lat) || !num(home.lon)) return '';
    return `<section><div class="section-head"><h2>Percorso</h2><small class="muted">≈ ${esc(fmtKm(tripKm(cur.doc, t)))}</small></div><div data-map></div></section>`;
  }

  function costsHtml(t) {
    const sp = tripSpend(t);
    const budget = COST_KEYS.reduce((a, k) => a + (Number(t.budget?.[k]) || 0), 0);
    const rows = COST_KEYS.filter((k) => (Number(t.budget?.[k]) || 0) > 0 || sp.byCat[k] > 0).map((k) => {
      const b = Number(t.budget?.[k]) || 0, d = sp.delta[k];
      const over = b > 0 && d > 0;
      const delta = b > 0 ? `<small class="${over ? 'error' : 'muted'}">${d > 0 ? `+${esc(fmtMoney(d))} oltre` : `−${esc(fmtMoney(-d))}`}</small>` : '';
      return `<li style="display:block"><div class="card-head" style="margin-bottom:6px"><b>${esc(catName(k))}</b>`
        + `<span>${esc(fmtMoney(sp.byCat[k]))}${b > 0 ? ` / ${esc(fmtMoney(b))}` : ''}</span></div>`
        + (b > 0 ? `<div class="bar${over ? ' over' : ''}" role="img" aria-label="${esc(catName(k))}: ${esc(fmtMoney(sp.byCat[k]))} su ${esc(fmtMoney(b))}"><i style="--w:${Math.min(100, (sp.byCat[k] / b) * 100).toFixed(1)}%"></i></div>` : '')
        + `${delta}</li>`;
    });
    const costs = [...(t.costs || [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const list = costs.map((c) => `<li><button type="button" class="row" data-cost="${esc(c.id)}"><span><b>${esc(fmtMoney(Number(c.amount) || 0))}</b>`
      + `<small>${esc(c.date ? fmtDayRow(c.date) : '')} · ${esc(catName(c.cat))}${c.note ? ` · ${esc(c.note)}` : ''}</small></span></button></li>`);
    return `<section><div class="section-head"><h2>Costi</h2></div>
      <div class="card">${rows.length ? `<ul class="rows">${rows.join('')}</ul>` : '<p class="muted">Nessun budget né spesa.</p>'}
        <p><b>Spesa totale</b> ${esc(fmtMoney(sp.total))}<br><b>Budget totale</b> ${budget > 0 ? esc(fmtMoney(budget)) : '—'}<br>`
      + `<b>Costo per notte</b> ${esc(fmtMoney(sp.perNight))}</p></div>
      ${list.length ? `<div class="card list"><ul class="rows">${list.join('')}</ul></div>` : ''}
      <button type="button" class="btn" data-act="add-cost">Aggiungi spesa</button></section>`;
  }

  function diaryHtml(t) {
    const d = cur.doc.diary || {};
    const row = (day) => {
      const e = d[`${t.id}:${day}`];
      const line = String(e?.text || '').split('\n').find((l) => l.trim());
      return `<li><a class="row" href="#diario/${esc(enc(t.id))}/${day}"><span><b>${esc(fmtDayRow(day))}</b>`
        + `<small>${line ? esc(line.trim()) : 'Pagina vuota'}</small></span></a></li>`;
    };
    const out = Object.keys(d).filter((k) => k.startsWith(`${t.id}:`)).map((k) => k.slice(t.id.length + 1))
      .filter((day) => {
        const e = d[`${t.id}:${day}`];
        return DAY.test(day) && (day < t.from || day > t.to) && (String(e?.text || '').trim() || (e?.places || []).length);
      })
      .sort();
    return `<section><div class="section-head"><h2>Diario</h2></div><div class="card list"><ul class="rows">${dayRange(t.from, t.to).map(row).join('')}</ul></div>`
      + (out.length ? `<div class="section-head"><h2>Pagine fuori dalle date</h2></div><div class="card list"><ul class="rows">${out.map(row).join('')}</ul></div>` : '')
      + '</section>';
  }

  function bodyHtml(t) {
    const st = tripState(t, cur.today), n = nights(t);
    const links = (t.links || []).map((l) => {
      const u = safeUrl(l.url);
      const label = esc(l.label || l.url || 'Link');
      return u ? `<li><a href="${esc(u)}" target="_blank" rel="noopener">${label}</a></li>` : `<li>${label}</li>`;
    });
    return `<div class="top"><a class="back" href="#viaggi" aria-label="Viaggi">‹ Viaggi</a></div>
      <h1>${esc(t.title || 'Viaggio')}</h1>
      <p class="map-sheet-meta"><span>${esc(fmtRange(t.from, t.to))} · ${n} ${n === 1 ? 'notte' : 'notti'}</span> <span class="pill ${PILL[st]}">${LABEL[st]}</span></p>
      ${(t.with || []).length ? `<div class="chips">${t.with.map((w) => `<span class="chip static">${esc(w)}</span>`).join('')}</div>` : ''}
      ${stopsHtml(t)}${routeHtml(t)}${costsHtml(t)}${diaryHtml(t)}
      ${t.note ? `<section class="card"><h2>Note</h2><p style="white-space:pre-wrap">${esc(t.note)}</p></section>` : ''}
      ${links.length ? `<section class="card"><h2>Link</h2><ul class="rows">${links.join('')}</ul></section>` : ''}
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
        view: italy ? 'italia' : 'world', level: 'regions', geo, interactive: false,
        points: stops.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, state: placeState(cur.doc, p, cur.today) })),
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

  function costSheet(costId) {
    const t = find(cur.doc);
    if (!t) return;
    const old = costId ? (t.costs || []).find((c) => c.id === costId) : null;
    const dflt = cur.today >= t.from && cur.today <= t.to ? cur.today : t.from;
    const s = openSheet(`<h2>${old ? 'Modifica spesa' : 'Aggiungi spesa'}</h2>
      <form class="form" novalidate>
        <label class="field">Importo (€)<input type="text" inputmode="decimal" name="amount" value="${old ? esc(String(old.amount).replace('.', ',')) : ''}" autocomplete="off"></label>
        <label class="field">Categoria<select name="cat">${COST_CATS.map((c) => `<option value="${c.key}"${c.key === (old?.cat ?? 'altro') ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
        <label class="field">Data<input type="date" name="date" value="${esc(old?.date || dflt)}"></label>
        <label class="field">Nota<input type="text" name="note" maxlength="120" value="${esc(old?.note || '')}"></label>
        <p class="error" data-err hidden></p>
        <div class="btn-row"><button type="submit" class="btn primary">Salva</button>${old ? '<button type="button" class="btn danger" data-act="del">Elimina</button>' : ''}</div>
      </form>`);
    const form = s.el.querySelector('form'), err = s.el.querySelector('[data-err]');
    const fail = (m) => { err.textContent = m; err.hidden = !m; };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const amount = parseNum(form.elements.amount.value.trim());
      const date = form.elements.date.value;
      if (!Number.isFinite(amount) || amount <= 0) return fail('Importo non valido: usa un numero maggiore di zero');
      if (!DAY.test(date)) return fail('Scegli una data');
      const cost = { id: old?.id ?? newId('c'), cat: form.elements.cat.value, amount: Math.round(amount * 100) / 100, date, note: form.elements.note.value.trim() };
      const cu = find(cur.doc);
      s.close();
      if (cu) await patch({ costs: old ? cu.costs.map((c) => (c.id === old.id ? cost : c)) : [...(cu.costs || []), cost] });
    };
    s.el.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
      const cu = find(cur.doc);
      s.close();
      if (cu) await patch({ costs: cu.costs.filter((c) => c.id !== old.id) });
    });
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
    else if (d.act === 'add-cost') costSheet(null);
    else if (d.cost) costSheet(d.cost);
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
