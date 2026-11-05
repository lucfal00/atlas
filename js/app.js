// Entry point: hash router, theme, banner, sync wiring, service worker.
// A view is a module exporting render(el, ctx); ctx = { doc, params, query, today, refresh, stale }.
// render may return { update?(ctx), destroy?() } (or a Promise of it):
//   store change / sync status -> update(freshCtx) if present, else a full re-render;
//   route change or re-render -> destroy() of the view being replaced.
// `el` is the single <main>, emptied and reused by every render, so a view must attach its handlers with
// el.onclick = ... / onchange / oninput / onsubmit (reset before each render), never el.addEventListener
// (listeners would pile up across routes). An async view checks ctx.stale() after each await and stops
// touching `el` once it returns true (the route changed or the view was re-rendered in the meantime).
import * as store from './store.js';
import { todayKey } from './logic.js';
import * as map from './views/map.js';
import * as places from './views/places.js';
import * as place from './views/place.js';
import * as placeEdit from './views/place-edit.js';
import * as trips from './views/trips.js';
import * as trip from './views/trip.js';
import * as tripEdit from './views/trip-edit.js';
import * as settings from './views/settings.js';

const main = document.getElementById('view');
const banner = document.getElementById('banner');
const TAB_OF = {                                    // route name -> tab (data-view)
  mappa: 'mappa', luoghi: 'luoghi', luogo: 'luoghi', viaggi: 'viaggi', viaggio: 'viaggi', impostazioni: 'impostazioni',
};
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
    case 'impostazioni': return [name, settings];
    default: return ['mappa', map];
  }
}

function route() {
  const hash = location.hash.slice(1);
  const q = hash.indexOf('?');
  const query = new URLSearchParams(q < 0 ? '' : hash.slice(q + 1));
  const [raw = '', ...rest] = (q < 0 ? hash : hash.slice(0, q)).split('/');
  if (rest.length && rest[rest.length - 1] === '') rest.pop();   // trailing slash: #luogo/abc/ -> ['abc']
  const segs = rest.map(decode);
  const [name, view] = pick(raw, segs);
  const params = name === raw ? segs : [];                          // a fallback view gets no params
  return {
    name, view, params, query,
    tab: TAB_OF[name],
    key: `${name}/${params.join('/')}`,
  };
}

/** `stale()` turns true once this render is superseded (route change, re-render or destroy). */
const makeCtx = (r, mine = ticket) => ({
  doc: store.getDoc(), params: r.params, query: r.query, today: todayKey(), refresh: render, stale: () => mine !== ticket,
});

/** --banner-h = height of the visible banner (0 when hidden): full-bleed screens subtract it. */
const syncBannerHeight = () => document.documentElement.style.setProperty('--banner-h', `${banner.offsetHeight}px`);

function updateBanner() {
  const notice = store.getNotice();
  banner.hidden = !notice;
  banner.querySelector('span').textContent = notice;
  syncBannerHeight();
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

  destroyActive();
  main.onclick = main.onchange = main.oninput = main.onsubmit = null;   // views re-attach their own
  main.replaceChildren();
  shownDay = todayKey();
  const mine = ticket;
  try {
    const out = r.view.render(main, makeCtx(r, mine));
    if (out && typeof out.then === 'function') {
      out.then((o) => {
        if (mine === ticket) {
          active = o ?? null;
          return;
        }
        try {
          o?.destroy?.();                           // navigated away while it was loading
        } catch (e) {
          console.error(e);
        }
      }, (e) => {
        if (mine === ticket) fail(e);               // fail() logs
        else console.error(e);                      // superseded: nothing to show, but never swallowed
      });
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
    const mine = ticket;
    try {
      const out = active.update(makeCtx(cur, mine));
      if (out && typeof out.then === 'function') {
        out.then(undefined, (e) => {                // async update failed: full re-render, unless already superseded
          console.error(e);
          if (mine === ticket) render();
        });
      }
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
if (typeof ResizeObserver === 'function') new ResizeObserver(syncBannerHeight).observe(banner);   // text wrap, rotation
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
  // A new version must reach the open app: check on start and on return, reload once when it takes over.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;          // first install: nothing stale to replace
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  }).catch((e) => console.warn('Service worker non registrato', e));
}
