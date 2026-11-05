// Settings (spec §4.5, §9): theme, home, sync (link / sync now / unlink / status), storage, backup, credits, version.
// The sync form is only redrawn when the link appears or disappears, so a half-typed token survives status updates.
import * as store from '../store.js';
import { searchPlaces, reversePlace } from '../search.js';
import { esc, toast, fmtNum } from '../ui.js';

const VERSION = '1.0';
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const TOKEN_MSG = 'Token scaduto o non valido: creane uno nuovo';
const THEMES = [['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']];
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const radio = (name, value, label, on) =>
  `<label class="pick"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;
const tokenLink = '<a href="' + TOKEN_URL + '" target="_blank" rel="noopener noreferrer">Crea un token</a>';

function homeText(home) {
  if (!home || !num(home.lat) || !num(home.lon)) return 'Non impostata';
  return `${home.name || 'Casa'} (${fmtNum(home.lat)}° N, ${fmtNum(home.lon)}° E)`;
}

function statusHtml(s) {
  const time = (at) => (at ? new Date(at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');
  if (!s.connected) return '';
  if (s.state === 'syncing') return '<p class="muted" role="status">Sincronizzazione in corso…</p>';
  if (s.state === 'error') {
    const token = /token/i.test(s.message) && !/accesso/i.test(s.message);
    return `<p class="msg err" role="status">${esc(token ? TOKEN_MSG : s.message || 'Errore imprevisto.')}</p>`
      + (token ? `<p>${tokenLink}</p>` : '');
  }
  if (s.state === 'offline') return `<p class="muted" role="status">${esc(s.message || 'Offline')}</p>`;
  if (s.state === 'paused') return `<p class="muted" role="status">${esc(s.message)}</p>`;
  return `<p class="msg" role="status">Collegato${s.at ? ` · ultima sincronizzazione alle ${esc(time(s.at))}` : ''}</p>`;
}

function syncHtml(s) {
  if (s.connected) {
    return `<div data-status>${statusHtml(s)}</div>
      <div class="btn-row"><button type="button" class="btn primary" data-act="sync">Sincronizza ora</button>
      <button type="button" class="btn danger" data-act="unlink">Scollega</button></div>`;
  }
  return `<p>Crea un repository privato vuoto su GitHub (di solito <b>atlas-data</b>) e un token con accesso solo a quel repository
      e permesso <b>Contents: Read and write</b>. I dati vengono cifrati con la password prima di essere inviati.</p>
    <p><a href="${TOKEN_URL}" target="_blank" rel="noopener noreferrer">Crea un token su GitHub</a></p>
    <form class="form" data-form="sync" autocomplete="off">
      <label class="field">Token<input type="password" name="token" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label class="field">Repository<input type="text" name="repo" value="atlas-data" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label class="field">Password di cifratura<input type="password" name="password" autocomplete="off"></label>
      <small class="muted">Almeno 8 caratteri. Non viene salvata: se la perdi i dati remoti non sono recuperabili.</small>
      <p class="error" data-err hidden></p>
      <button type="submit" class="btn primary block" data-act="link">Collega</button>
    </form>
    <div data-status>${statusHtml(s)}</div>`;
}

export async function render(el, ctx) {
  let cur = ctx, sheetBusy = false, found = [], homeMsg = '', linked = store.getSync().connected;
  const $ = (sel) => el.querySelector(sel);

  const lastBackup = (doc) => {
    const t = doc.settings?.lastBackup;
    return t ? new Date(t).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) : 'mai';
  };

  function foundHtml() {
    return (homeMsg ? `<p class="${homeMsg.err ? 'error' : 'muted'}" role="status">${esc(homeMsg.text)}</p>` : '')
      + (found.length ? `<div class="card list"><ul class="rows">${found.map((r, i) => `<li><button type="button" class="row" data-home="${i}">`
        + `<span><b>${esc(r.name)}</b><small>${esc(r.label)}</small></span></button></li>`).join('')}</ul></div>` : '');
  }

  function themeHtml(doc) {
    const t = THEMES.some(([v]) => v === doc.settings.theme) ? doc.settings.theme : 'auto';
    return `<div class="seg" role="radiogroup" aria-label="Tema">${THEMES.map(([v, l]) => radio('theme', v, l, v === t)).join('')}</div>`;
  }

  el.innerHTML = `<div class="top"><h1 class="grow">Impostazioni</h1></div><div class="settings">
    <section class="card"><div class="card-head"><h2>Tema</h2></div><div data-theme>${themeHtml(cur.doc)}</div></section>
    <section class="card"><div class="card-head"><h2>Casa</h2></div>
      <p data-home-now>${esc(homeText(cur.doc.settings.home))}</p>
      <form class="form" data-form="search">
        <div class="two"><input type="search" name="q" placeholder="Cerca un luogo" aria-label="Cerca la tua casa" autocomplete="off">
        <button type="submit" class="btn">Cerca</button></div>
        <button type="button" class="btn" data-act="here">Usa la posizione attuale</button>
      </form>
      <div data-found></div></section>
    <section class="card"><div class="card-head"><h2>Sincronizzazione</h2></div><div data-sync>${syncHtml(store.getSync())}</div></section>
    <section class="card"><div class="card-head"><h2>Spazio</h2></div>
      <p data-space class="muted">Calcolo…</p></section>
    <section class="card"><div class="card-head"><h2>Backup</h2></div>
      <p>Solo i dati (luoghi, viaggi, diario, segni). Ultimo backup: <span data-last>${esc(lastBackup(cur.doc))}</span>.</p>
      <div class="btn-row"><button type="button" class="btn" data-act="export">Esporta backup</button>
      <button type="button" class="btn" data-act="import">Importa backup</button></div>
      <input type="file" accept="application/json,.json" data-file hidden>
      <p class="msg" data-backup-msg role="status" hidden></p></section>
    <section class="card"><div class="card-head"><h2>Crediti</h2></div>
      <p>Confini: Natural Earth (pubblico dominio).<br>Ricerca luoghi: OpenStreetMap / Nominatim.</p>
      <p class="muted">Atlas versione ${VERSION}</p></section></div>`;

  async function fillSpace() {
    const { localBytes } = await store.storageInfo();
    if (ctx.stale()) return;
    $('[data-space]').textContent = localBytes == null ? 'Spazio non disponibile su questo browser.'
      : `${(localBytes / 1048576).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB di dati sul dispositivo (inclusi gli altri archivi dello stesso sito)`;
  }
  fillSpace().catch((e) => console.error(e));

  function drawFound() {
    $('[data-found]').innerHTML = foundHtml();
  }

  function setHome(home) {
    found = [];
    homeMsg = '';
    drawFound();
    store.setSetting('home', home).then(() => toast('Casa aggiornata')).catch((e) => console.error(e));
  }

  async function search(q) {
    q = q.trim();
    if (!q || sheetBusy) return;
    sheetBusy = true;
    found = [];
    homeMsg = { text: 'Ricerca in corso…' };
    drawFound();
    try {
      found = await searchPlaces(q);
      homeMsg = found.length ? '' : { text: 'Nessun risultato.' };
    } catch (e) {
      homeMsg = { err: true, text: e.message === 'offline' ? 'Serve internet per cercare: usa la posizione attuale' : 'Ricerca non riuscita. Riprova più tardi.' };
    }
    sheetBusy = false;
    if (ctx.stale()) return;
    drawFound();
  }

  function here() {
    if (!navigator.geolocation) {
      homeMsg = { err: true, text: 'Posizione non disponibile: cerca un luogo' };
      return drawFound();
    }
    homeMsg = { text: 'Ricerca della posizione…' };
    drawFound();
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      let name = null;
      try {
        name = await reversePlace(lat, lon);
      } catch { /* offline: keep a generic name */ }
      if (ctx.stale()) return;
      setHome({ name: name || 'Posizione attuale', lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 });
    }, () => {
      if (ctx.stale()) return;
      homeMsg = { err: true, text: 'Posizione non disponibile: cerca un luogo' };
      drawFound();
    }, { timeout: 10000 });
  }

  async function link(form) {
    const err = form.querySelector('[data-err]');
    const fail = (m) => { err.textContent = m; err.hidden = !m; };
    const token = form.elements.token.value.trim();
    const repo = form.elements.repo.value.trim();
    const password = form.elements.password.value;
    if (!token) return fail('Inserisci il token');
    if (!/^([\w.-]+\/)?[\w.-]+$/.test(repo || 'atlas-data')) return fail('Nome del repository non valido');
    if (password.length < 8) return fail('La password deve avere almeno 8 caratteri');
    fail('');
    const btn = form.querySelector('[data-act="link"]');
    btn.disabled = true;
    btn.textContent = 'Collego…';
    try {
      const r = await store.connectSync(token, repo, password);
      form.reset();
      toast(`Collegato: ${r.count} ${r.count === 1 ? 'elemento aggiornato' : 'elementi aggiornati'}`);
    } catch (e) {
      if (ctx.stale()) return;
      btn.disabled = false;
      btn.textContent = 'Collega';
      form.elements.password.value = '';
      fail(e.code === 'token' ? TOKEN_MSG : e.message || 'Collegamento non riuscito');
    }
  }

  function backupMsg(text, isErr) {
    const p = $('[data-backup-msg]');
    p.textContent = text;
    p.hidden = !text;
    p.classList.toggle('err', !!isErr);
  }

  el.onsubmit = (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.dataset.form === 'search') search(form.elements.q.value);
    else if (form.dataset.form === 'sync') link(form);
  };

  el.onclick = async (e) => {
    const h = e.target.closest('[data-home]');
    if (h) {
      const r = found[Number(h.dataset.home)];
      if (r) setHome({ name: r.name, lat: Math.round(r.lat * 1e4) / 1e4, lon: Math.round(r.lon * 1e4) / 1e4 });
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'here') here();
    else if (act === 'sync') {
      const btn = e.target.closest('[data-act]');
      btn.disabled = true;
      await store.runSync();
      if (!ctx.stale()) btn.disabled = false;
    } else if (act === 'unlink') {
      if (confirm('Scollegare questo dispositivo? I dati restano sul dispositivo e nel repository.')) await store.disconnectSync();
    } else if (act === 'export') {
      try {
        if (await store.exportBackup()) toast('Backup esportato');
      } catch (err) {
        console.error(err);
        backupMsg('Esportazione non riuscita', true);
      }
    } else if (act === 'import') $('[data-file]').click();
  };

  el.onchange = async (e) => {
    if (e.target.name === 'theme') {
      store.setSetting('theme', e.target.value).catch((err) => console.error(err));
    } else if (e.target.matches('[data-file]')) {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const { count, dropped } = await store.importBackup(file);
        backupMsg('');
        toast(`Importati ${count} ${count === 1 ? 'elemento' : 'elementi'}${dropped ? `, ${dropped} non validi ignorati` : ''}`);
      } catch (err) {
        if (!ctx.stale()) backupMsg(err.message || 'Backup non valido', true);
      }
    }
  };

  /** Data or sync status changed: refresh what is derived, keep forms and focus. */
  function update(c) {
    cur = c;
    const s = store.getSync();
    if (s.connected !== linked) {
      linked = s.connected;
      $('[data-sync]').innerHTML = syncHtml(s);
    } else {
      const st = $('[data-status]');
      if (st) st.innerHTML = statusHtml(s);
    }
    $('[data-home-now]').textContent = homeText(c.doc.settings.home);
    $('[data-last]').textContent = lastBackup(c.doc);
    const t = THEMES.some(([v]) => v === c.doc.settings.theme) ? c.doc.settings.theme : 'auto';
    const r = $(`input[name="theme"][value="${t}"]`);
    if (r && !r.checked) r.checked = true;
    fillSpace().catch((e) => console.error(e));
  }
  return { update };
}
