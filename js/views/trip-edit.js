// Trip form (spec §4.3): title, dates, note, total spend. Stops are managed on the trip page.
// update() is a no-op (never lose typed input).
import * as store from '../store.js';
import { esc, parseNum } from '../ui.js';

const live = (list) => (list || []).filter((x) => !x.deleted);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function render(el, ctx) {
  const tid = ctx.params[0] === 'nuovo' ? null : ctx.params[0];
  const old = tid ? live(ctx.doc.trips).find((t) => t.id === tid) : null;
  if (tid && !old) {
    el.innerHTML = '<div class="card empty"><h2>Viaggio non trovato</h2><p class="muted">Il viaggio non esiste più o è stato eliminato.</p><a class="btn primary" href="#viaggi">Vai ai viaggi</a></div>';
    return;
  }
  const home = old ? `#viaggio/${encodeURIComponent(tid)}` : '#viaggi';
  let saving = false;

  el.innerHTML = `<div class="top"><a class="back" href="${esc(home)}">‹ Annulla</a><h1 class="grow">${old ? 'Modifica viaggio' : 'Nuovo viaggio'}</h1></div>
    <form class="form" novalidate>
      <label class="field">Titolo<input type="text" name="title" maxlength="60" value="${esc(old?.title || '')}" autocomplete="off"></label>
      <p class="error" data-err="title" hidden></p>
      <div class="two"><label class="field">Dal<input type="date" name="from" value="${esc(old?.from || ctx.today)}"></label>
        <label class="field">Al<input type="date" name="to" value="${esc(old?.to || ctx.today)}"></label></div>
      <p class="error" data-err="dates" hidden></p>
      <label class="field">Spesa totale (€)<input type="text" inputmode="decimal" name="spend" value="${old?.spend > 0 ? esc(String(old.spend).replace('.', ',')) : ''}" placeholder="Facoltativa"></label>
      <p class="error" data-err="spend" hidden></p>
      <label class="field">Nota<textarea name="note">${esc(old?.note || '')}</textarea></label>
      <p class="error" data-err="form" hidden></p>
      <div class="btn-row"><button type="submit" class="btn primary" data-act="save">Salva</button><a class="btn" href="${esc(home)}">Annulla</a></div>
    </form>`;

  const $ = (s) => el.querySelector(s);
  const form = $('form');
  const fail = (k, m) => {
    const p = $(`[data-err="${k}"]`);
    p.textContent = m;
    p.hidden = !m;
  };

  async function save() {
    if (saving) return;
    for (const k of ['title', 'dates', 'spend', 'form']) fail(k, '');
    let ok = true;
    const title = form.elements.title.value.trim();
    if (!title || title.length > 60) {
      fail('title', 'Il titolo è obbligatorio (massimo 60 caratteri)');
      ok = false;
    }
    const from = form.elements.from.value, to = form.elements.to.value;
    if (!DAY.test(from) || !DAY.test(to)) {
      fail('dates', 'Inserisci le date di inizio e fine');
      ok = false;
    } else if (to < from) {
      fail('dates', 'La fine è prima dell’inizio');
      ok = false;
    }
    const raw = form.elements.spend.value.trim();
    const spend = raw === '' ? null : Math.round(parseNum(raw) * 100) / 100;
    if (spend !== null && (!Number.isFinite(spend) || spend < 0)) {
      fail('spend', 'Spesa non valida: usa un numero uguale o maggiore di zero');
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
      const id = await store.saveTrip({ ...(tid ? { id: tid } : {}), title, from, to, note: form.elements.note.value.trim(), spend });
      location.hash = `#viaggio/${encodeURIComponent(id)}`;
    } catch (e) {
      console.error(e);
      fail('form', 'Impossibile salvare');
      saving = false;
      btn.disabled = false;
    }
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    save();
  };
  return { update() {} };
}
