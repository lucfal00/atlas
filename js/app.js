// Entry point: hash router, theme, banner, sync wiring, service worker.
// A view is a module exporting render(el, ctx); ctx = { doc, params, query, today, refresh }.
// render may return { update?(ctx), destroy?() } (or a Promise of it):
//   store change / sync status -> update(freshCtx) if present, else a full re-render;
//   route change or re-render -> destroy() of the view being replaced.
import * as store from './store.js';
import { todayKey } from './logic.js';
import { initTooltips, hideTip } from './charts.js';
import * as map from './views/map.js';
import * as places from './views/places.js';
import * as place from './views/place.js';
import * as placeEdit from './views/place-edit.js';
import * as trips from './views/trips.js';
import * as trip from './views/trip.js';
import * as tripEdit from './views/trip-edit.js';
import * as diary from './views/diary.js';
import * as photoViewer from './views/photo-viewer.js';
import * as stats from './views/stats.js';
import * as year from './views/year.js';
import * as settings from './views/settings.js';

const main = document.getElementById('view');
const banner = document.getElementById('banner');
const TAB_OF = {                                    // route name -> tab (data-view)
  mappa: 'mappa', luoghi: 'luoghi', luogo: 'luoghi', viaggi: 'viaggi', viaggio: 'viaggi', diario: 'viaggi',
  stats: 'stats', anno: 'stats', impostazioni: 'impostazioni',
};
const PHOTO_TAB = { place: 'luoghi', trip: 'viaggi', day: 'viaggi' };   // foto: tab of the set it was opened from
const DAY = /^\d{4}-\d{2}-\d{2}$/;
let cur = null;                                     // route being shown
let active = null;                                  // object returned by its view
let ticket = 0;                                     // invalidates a pending async render
let shownKey = '';
let shownDay = '';

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;                                       // malformed escape: keep it as typed
  }
};

/** [route name, view] for a hash path; incomplete or unknown routes fall back to their list / the map. */
function pick(name, p) {
  const edit = p[0] === 'nuovo' || p[1] === 'modifica';
  switch (name) {
    case 'luoghi': return [name, places];
    case 'luogo': return p[0] ? [name, edit ? placeEdit : place] : ['luoghi', places];
    case 'viaggi': return [name, trips];
    case 'viaggio': return p[0] ? [name, edit ? tripEdit : trip] : ['viaggi', trips];
    case 'diario': return p[0] && DAY.test(p[1] || '') ? [name, diary] : ['viaggi', trips];
    case 'foto': return p[0] ? [name, photoViewer] : ['mappa', map];
    case 'stats': return [name, stats];
    case 'anno': return /^\d{4}$/.test(p[0] || '') ? [name, year] : ['stats', stats];
    case 'impostazioni': return [name, settings];
    default: return ['mappa', map];
  }
}

function route() {
  const hash = location.hash.slice(1);
  const q = hash.indexOf('?');
  const query = new URLSearchParams(q < 0 ? '' : hash.slice(q + 1));
  const [raw = '', ...rest] = (q < 0 ? hash : hash.slice(0, q)).split('/');
  const params = rest.map(decode);
  const [name, view] = pick(raw, params);
  const origin = name === 'foto' ? ['place', 'trip', 'day'].find((k) => query.has(k)) : null;
  return {
    name, view, params, query,
    tab: name === 'foto' ? PHOTO_TAB[origin] || '' : TAB_OF[name],
    key: `${name}/${params.join('/')}`,
  };
}

const makeCtx = (r) => ({ doc: store.getDoc(), params: r.params, query: r.query, today: todayKey(), refresh: render });

function updateBanner() {
  const notice = store.getNotice();
  banner.hidden = !notice;
  banner.querySelector('span').textContent = notice;
}

/** Theme and banner follow the document on every change, whichever way the view redraws. */
function applyChrome() {
  const root = document.documentElement;
  const theme = store.getDoc().settings.theme;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  updateBanner();
}

function fail(e) {
  console.error(e);
  const box = Object.assign(document.createElement('div'), { className: 'card empty' });
  box.append(Object.assign(document.createElement('p'), { textContent: 'Impossibile mostrare questa schermata.' }));
  main.replaceChildren(box);
}

function destroyActive() {
  const prev = active;
  active = null;
  ticket++;
  try {
    prev?.destroy?.();
  } catch (e) {
    console.error(e);
  }
}

function render() {
  const r = route();
  cur = r;
  applyChrome();
  document.querySelectorAll('.tabbar a').forEach((a) => {
    const on = a.dataset.view === r.tab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  hideTip();
  destroyActive();
  main.onclick = main.onchange = main.oninput = main.onsubmit = null;   // views re-attach their own
  main.replaceChildren();
  shownDay = todayKey();
  const mine = ticket;
  try {
    const out = r.view.render(main, makeCtx(r));
    if (out && typeof out.then === 'function') {
      out.then((o) => {
        if (mine === ticket) active = o ?? null;
        else o?.destroy?.();                        // navigated away while it was loading
      }, (e) => { if (mine === ticket) fail(e); });
    } else {
      active = out ?? null;
    }
  } catch (e) {
    fail(e);
  }

  if (r.key !== shownKey) {
    window.scrollTo(0, 0);
    shownKey = r.key;
  }
}

/** A change the view may absorb itself (map layers, forms that ignore background changes); else redraw. */
function refreshActive() {
  if (active?.update) {
    try {
      active.update(makeCtx(cur));
      return;
    } catch (e) {
      console.error(e);
    }
  }
  render();
}

try {
  await store.load();                               // async: the document must be in memory before the first render
} catch (e) {
  console.error(e);
}
initTooltips();
store.onChange(() => {
  applyChrome();
  refreshActive();
});
// Sync status only touches the screen that shows it, so background syncs never reset an open form.
store.onSync(() => {
  updateBanner();
  if (cur?.name === 'impostazioni') refreshActive();
});
banner.querySelector('button').onclick = store.clearNotice;
addEventListener('hashchange', render);
addEventListener('online', () => store.runSync());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    store.flushSync();                              // upload before iOS suspends the app
    return;
  }
  if (todayKey() !== shownDay) render();            // after midnight (not on every switch: keeps open forms)
  store.runSync();
});
render();
store.runSync();

Promise.resolve(navigator.storage?.persist?.()).catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker non registrato', e));
}
