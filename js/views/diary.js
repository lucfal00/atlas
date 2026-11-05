// Diary page of one trip day (spec §4.3): text with autosave, places of the day as toggle chips (stops of the trip
// plus any place picked with "Altro luogo"), previous / next day within the trip. update() refreshes only the chips.
import * as store from '../store.js';
import { addDays, fold } from '../logic.js';
import { esc, openSheet, catLabel, fmtDayYear } from '../ui.js';

const live = (list) => (list || []).filter((x) => !x.deleted);
const DELAY = 600;

export function render(el, ctx) {
  const [tid, day] = ctx.params;
  const find = (doc) => live(doc.trips).find((t) => t.id === tid);
  const t0 = find(ctx.doc);
  if (!t0) {
    el.innerHTML = '<div class="card empty"><h2>Viaggio non trovato</h2><p class="muted">Il viaggio non esiste più o è stato eliminato.</p><a class="btn primary" href="#viaggi">Vai ai viaggi</a></div>';
    return;
  }
  const key = `${tid}:${day}`;
  const enc = encodeURIComponent(tid);
  let cur = ctx, timer = 0, dirty = false;
  let text = String(ctx.doc.diary?.[key]?.text || '');

  const nav = (to, label, glyph) => (to
    ? `<a class="icon-btn" href="#diario/${enc}/${to}" aria-label="${label}">${glyph}</a>`
    : `<button type="button" class="icon-btn" disabled aria-label="${label}">${glyph}</button>`);
  const outside = day < t0.from || day > t0.to;

  el.innerHTML = `<div class="top"><a class="back" href="#viaggio/${enc}">‹ ${esc(t0.title || 'Viaggio')}</a><span class="grow"></span>
      ${nav(day > t0.from ? addDays(day, -1) : null, 'Giorno precedente', '‹')}${nav(day < t0.to ? addDays(day, 1) : null, 'Giorno successivo', '›')}</div>
    <h1>${esc(fmtDayYear(day))}</h1>
    ${outside ? '<p class="notice">Questa pagina è fuori dalle date del viaggio.</p>' : ''}
    <label class="field">Diario<textarea data-text rows="10" aria-label="Testo del diario" placeholder="Com’è andata la giornata?"></textarea></label>
    <section><div class="section-head"><h2>Luoghi del giorno</h2></div>
      <div class="chips" data-chips></div>
      <button type="button" class="btn" data-act="other">Altro luogo</button></section>`;
  const ta = el.querySelector('[data-text]');
  ta.value = text;

  async function flush() {
    clearTimeout(timer);
    timer = 0;
    if (!dirty) return;
    dirty = false;
    try {
      await store.setDiary(tid, day, { text });
    } catch (e) {
      console.error(e);
      dirty = true;
    }
  }

  ta.oninput = () => {
    text = ta.value;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, DELAY);
  };
  ta.onblur = flush;

  const dayPlaces = () => cur.doc.diary?.[key]?.places || [];
  function drawChips() {
    const t = find(cur.doc);
    const pm = new Map(live(cur.doc.places).map((p) => [p.id, p]));
    const ids = [];
    for (const s of t?.stops || []) if (pm.has(s.place) && !ids.includes(s.place)) ids.push(s.place);
    for (const p of dayPlaces()) if (pm.has(p) && !ids.includes(p)) ids.push(p);
    const on = new Set(dayPlaces());
    const host = el.querySelector('[data-chips]');
    host.innerHTML = ids.length
      ? ids.map((p) => `<button type="button" class="chip${on.has(p) ? ' on' : ''}" data-place="${esc(p)}" aria-pressed="${on.has(p)}">${esc(pm.get(p).name || 'Senza nome')}</button>`).join('')
      : '<p class="muted">Nessun luogo: aggiungi una tappa al viaggio o scegline un altro.</p>';
  }
  drawChips();

  const setPlaces = (places) => store.setDiary(tid, day, { places }).catch((e) => console.error(e));
  const toggle = (p) => setPlaces(dayPlaces().includes(p) ? dayPlaces().filter((x) => x !== p) : [...dayPlaces(), p]);

  function otherSheet() {
    const s = openSheet(`<h2>Altro luogo</h2>
      <input type="search" data-q placeholder="Cerca per nome" aria-label="Cerca per nome" autocomplete="off">
      <div data-list></div>`);
    const listEl = s.el.querySelector('[data-list]'), q = s.el.querySelector('[data-q]');
    const paint = () => {
      const needle = fold(q.value.trim());
      const items = live(cur.doc.places).filter((p) => !needle || fold(p.name).includes(needle))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));
      listEl.innerHTML = items.length
        ? `<div class="card list"><ul class="rows">${items.map((p) => `<li><button type="button" class="row" data-pick="${esc(p.id)}"><span><b>${esc(p.name || 'Senza nome')}</b><small>${esc(catLabel(p.cat))}</small></span></button></li>`).join('')}</ul></div>`
        : '<p class="muted">Nessun luogo trovato.</p>';
    };
    paint();
    q.oninput = paint;
    s.el.onclick = (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      s.close();
      if (!dayPlaces().includes(b.dataset.pick)) setPlaces([...dayPlaces(), b.dataset.pick]);
    };
  }

  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    if (b.dataset.place) toggle(b.dataset.place);
    else if (b.dataset.act === 'other') otherSheet();
  };

  return {
    update(c) {
      cur = c;
      drawChips();                                   // the textarea is never touched
    },
    destroy() {
      flush();
    },
  };
}
