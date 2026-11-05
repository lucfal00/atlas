// Trip form (spec §4.3): title, dates, companions, note, links, budget per category, stop dates. Plain inputs are read
// from the DOM on save; the link list lives in state `f` and is redrawn alone. update() is a no-op (never lose typed input).
import * as store from '../store.js';
import { esc, safeUrl, parseNum, COST_CATS } from '../ui.js';

const live = (list) => (list || []).filter((x) => !x.deleted);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const list = (s) => [...new Set(String(s).split(',').map((x) => x.trim()).filter(Boolean))];

export function render(el, ctx) {
  const tid = ctx.params[0] === 'nuovo' ? null : ctx.params[0];
  const old = tid ? live(ctx.doc.trips).find((t) => t.id === tid) : null;
  if (tid && !old) {
    el.innerHTML = '<div class="card empty"><h2>Viaggio non trovato</h2><p class="muted">Il viaggio non esiste più o è stato eliminato.</p><a class="btn primary" href="#viaggi">Vai ai viaggi</a></div>';
    return;
  }
  const places = new Map(live(ctx.doc.places).map((p) => [p.id, p]));
  const f = {
    links: (old?.links || []).map((l) => ({ ...l })),
    stops: (old?.stops || []).map((s) => ({ ...s })),
  };
  const home = old ? `#viaggio/${encodeURIComponent(tid)}` : '#viaggi';
  let saving = false;

  const linksHtml = () => f.links.map((l, i) => `<div class="link-row"><div class="two">
      <input type="text" data-link-label="${i}" value="${esc(l.label)}" placeholder="Nome" aria-label="Nome del link" maxlength="60">
      <input type="url" data-link-url="${i}" value="${esc(l.url)}" placeholder="https://…" aria-label="Indirizzo del link" autocapitalize="off" spellcheck="false"></div>
      <button type="button" class="icon-btn" data-rm-link="${i}" aria-label="Rimuovi link">×</button>
      <p class="error" data-link-err="${i}" hidden></p></div>`).join('')
    + '<button type="button" class="btn" data-act="add-link">Aggiungi link</button>';

  const stopsHtml = () => {
    const rows = f.stops.map((s, i) => ({ s, i, p: places.get(s.place) })).filter((x) => x.p);
    if (!rows.length) return '<p class="muted">Nessuna tappa: aggiungile dalla scheda del viaggio.</p>';
    return rows.map(({ s, i, p }) => `<div class="link-row"><b style="flex-basis:100%">${esc(p.name || 'Senza nome')}</b><div class="two">
      <input type="date" data-stop-from="${i}" value="${esc(s.from || '')}" aria-label="Dal, ${esc(p.name || '')}">
      <input type="date" data-stop-to="${i}" value="${esc(s.to || '')}" aria-label="Al, ${esc(p.name || '')}"></div>
      <p class="error" data-stop-err="${i}" hidden></p></div>`).join('');
  };

  el.innerHTML = `<div class="top"><a class="back" href="${esc(home)}">‹ Annulla</a><h1 class="grow">${old ? 'Modifica viaggio' : 'Nuovo viaggio'}</h1></div>
    <form class="form" novalidate>
      <label class="field">Titolo<input type="text" name="title" maxlength="60" value="${esc(old?.title || '')}" autocomplete="off"></label>
      <p class="error" data-err="title" hidden></p>
      <div class="two"><label class="field">Dal<input type="date" name="from" value="${esc(old?.from || ctx.today)}"></label>
        <label class="field">Al<input type="date" name="to" value="${esc(old?.to || ctx.today)}"></label></div>
      <p class="error" data-err="dates" hidden></p>
      <label class="field">Compagni<input type="text" name="with" value="${esc((old?.with || []).join(', '))}" placeholder="Anna, Marco"><span class="field-hint">Separati da virgole</span></label>
      <label class="field">Note<textarea name="note">${esc(old?.note || '')}</textarea></label>
      <fieldset><legend>Link</legend><div data-links></div></fieldset>
      <fieldset><legend>Budget (€)</legend><div class="geo-fields">${COST_CATS.map((c) => `<label class="field">${esc(c.label)}<input type="text" inputmode="decimal" name="b_${c.key}" value="${old && old.budget?.[c.key] > 0 ? esc(String(old.budget[c.key]).replace('.', ',')) : ''}" placeholder="0"></label>`).join('')}</div>
        <p class="error" data-err="budget" hidden></p></fieldset>
      <fieldset><legend>Date delle tappe</legend><div data-stops></div></fieldset>
      <p class="error" data-err="form" hidden></p>
      <div class="btn-row"><button type="submit" class="btn primary" data-act="save">Salva</button><a class="btn" href="${esc(home)}">Annulla</a></div>
    </form>`;

  const $ = (s) => el.querySelector(s);
  const form = $('form');
  const links = $('[data-links]');
  links.innerHTML = linksHtml();
  $('[data-stops]').innerHTML = stopsHtml();
  const fail = (k, m) => {
    const p = $(`[data-err="${k}"]`);
    p.textContent = m;
    p.hidden = !m;
  };

  function readLinks() {
    el.querySelectorAll('[data-link-label]').forEach((i) => { f.links[+i.dataset.linkLabel].label = i.value; });
    el.querySelectorAll('[data-link-url]').forEach((i) => { f.links[+i.dataset.linkUrl].url = i.value; });
  }

  async function save() {
    if (saving) return;
    readLinks();
    for (const k of ['title', 'dates', 'budget', 'form']) fail(k, '');
    el.querySelectorAll('[data-link-err], [data-stop-err]').forEach((p) => { p.hidden = true; });
    let ok = true;
    const title = form.elements.title.value.trim();
    if (!title || title.length > 60) {
      fail('title', 'Il titolo è obbligatorio (massimo 60 caratteri)');
      ok = false;
    }
    const from = form.elements.from.value, to = form.elements.to.value;
    let datesOk = true;
    if (!DAY.test(from) || !DAY.test(to)) {
      fail('dates', 'Inserisci le date di inizio e fine');
      datesOk = ok = false;
    } else if (to < from) {
      fail('dates', 'La fine è prima dell’inizio');
      datesOk = ok = false;
    }
    const budget = {};
    for (const c of COST_CATS) {
      const raw = form.elements[`b_${c.key}`].value.trim();
      const v = raw === '' ? 0 : parseNum(raw);
      if (!Number.isFinite(v) || v < 0) {
        fail('budget', 'Budget non valido: usa numeri uguali o maggiori di zero');
        ok = false;
        break;
      }
      budget[c.key] = Math.round(v * 100) / 100;
    }
    const newLinks = [];
    f.links.forEach((l, i) => {
      const url = String(l.url ?? '').trim(), label = String(l.label ?? '').trim();
      if (!url && !label) return;
      const u = safeUrl(url);
      if (!u) {
        const p = $(`[data-link-err="${i}"]`);
        p.textContent = 'Link non valido: usa un indirizzo http o https';
        p.hidden = false;
        ok = false;
      } else newLinks.push({ label: label || u, url: u });
    });
    const stops = f.stops.map((s, i) => {
      const a = $(`[data-stop-from="${i}"]`), b = $(`[data-stop-to="${i}"]`);
      if (!a) return { ...s };                       // stop of a deleted place: kept untouched
      const sf = a.value, st = b.value;
      const next = { place: s.place };
      if (sf) next.from = sf;
      if (st) next.to = st;
      let msg = '';
      if ((sf && !DAY.test(sf)) || (st && !DAY.test(st))) msg = 'Data non valida';
      else if (sf && st && st < sf) msg = 'La fine è prima dell’inizio';
      else if (datesOk && ((sf && (sf < from || sf > to)) || (st && (st < from || st > to)))) msg = 'Le date della tappa devono stare dentro il viaggio';
      if (msg) {
        const p = $(`[data-stop-err="${i}"]`);
        p.textContent = msg;
        p.hidden = false;
        ok = false;
      }
      return next;
    });
    if (!ok) {
      (el.querySelector('.error:not([hidden])') || form).scrollIntoView?.({ block: 'center' });
      return;
    }
    saving = true;
    const btn = $('[data-act="save"]');
    btn.disabled = true;
    try {
      const id = await store.saveTrip({
        ...(tid ? { id: tid } : {}),
        title, from, to, with: list(form.elements.with.value), note: form.elements.note.value.trim(),
        links: newLinks, budget, stops,
      });
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
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    if (b.dataset.act === 'add-link') {
      readLinks();
      f.links.push({ label: '', url: '' });
      links.innerHTML = linksHtml();
      links.querySelector(`[data-link-label="${f.links.length - 1}"]`)?.focus();
    } else if (b.dataset.rmLink !== undefined) {
      readLinks();
      f.links.splice(+b.dataset.rmLink, 1);
      links.innerHTML = linksHtml();
    }
  };
  return { update() {} };
}
