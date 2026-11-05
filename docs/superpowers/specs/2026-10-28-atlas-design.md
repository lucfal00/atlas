# Atlas — Design

Data: 2026-10-28
Semplificata il 2026-11-05 (decisione utente: l'app era troppo complicata). Niente foto, diario, statistiche, anno in viaggio,
costi per categoria, province, filtri, voti, tag, link, stato "in programma".

## 1. Obiettivo

App personale per segnare i luoghi visitati e da visitare, raccoglierli in viaggi e vederli su un atlante disegnato.
Stessa base tecnica e stessa famiglia visiva di Habits e Fitness.

## 2. Vincoli

- iPhone (Safari, "Aggiungi a Home") + PC (Chrome/Edge, "Installa app"). Offline dopo la prima apertura (tranne la ricerca per nome).
- Nessuna libreria esterna, nessun build step: HTML/CSS/JS (ES modules). Moduli comuni copiati da Habits e adattati.
- GitHub Pages: repository pubblico `lucfal00/atlas` → `https://lucfal00.github.io/atlas/`.
- Dati sincronizzati cifrati in un Gist GitHub **segreto** dell'utente (file `atlas-sync.json`), come in Habits.
- Lingua UI: italiano. Importi in euro.

## 3. Schermate

Tab bar in basso: **Mappa · Luoghi · Viaggi · Impostazioni**.
Hash router: `#mappa`, `#luoghi`, `#viaggi`, `#impostazioni`, `#luogo/<id>`, `#luogo/nuovo`, `#luogo/<id>/modifica`,
`#viaggio/<id>`, `#viaggio/nuovo`, `#viaggio/<id>/modifica`.

### 3.1 Mappa

- Selettore **Mondo | Italia** (Italia = regioni).
- Aree colorate per stato (§5.1): visitato, da visitare, mai. Luoghi come punti: pieno = visitato, anello = da visitare.
  Raggruppamento (§5.3): pallino con numero; tocco → zoom ×2 centrato.
- Tre numeri in alto: paesi visitati, regioni visitate (n/20), luoghi visitati.
- Gesti: trascinamento, pizzico, rotella, doppio tocco = zoom ×2. Zoom 1×–8× (Mondo, globo: il trascinamento lo ruota), 1×–20× (Italia). Pulsante tondo «Vista iniziale» in basso a destra sopra il +, visibile solo a vista spostata o ingrandita.
- Tocco su un'area → foglio: nome, stato, segno manuale (**Segna come visitato** / **Togli segno**), luoghi nell'area, **Aggiungi luogo qui**.
- Tocco su un punto → anteprima (nome, categoria, stato) → apre `#luogo/<id>`.
- Pressione lunga su un punto vuoto → nuovo luogo con quelle coordinate. Pulsante **+**.

### 3.2 Luoghi

- Elenco: ricerca per nome (senza accenti né maiuscole), dal più recente, con etichetta di stato.
- **Scheda**: nome, categoria, stato, data (se visitato), nota, mini mappa, paese / regione, **Apri in Mappe** (Apple Maps su iPhone, Google Maps altrove),
  viaggi che includono il luogo, **Modifica**, **Elimina** (conferma).
- **Nuovo/Modifica**: nome (obbligatorio, max 60), categoria (`citta`, `borgo`, `natura`, `mare`, `montagna`, `cultura`, `ristorante`, `locale`, `alloggio`, `esperienza`, `altro`),
  stato `visited` | `wish`, mesi `from`/`to` (`YYYY-MM`, solo se visitato), `partner` (con la fidanzata, punto blu), `scores` (voti 1–5 per cibo, cultura, paesaggio, atmosfera, prezzi, solo se visitato), nota. Un solo campo **Luogo** (è il nome) con **Cerca** (online, §7.4); posizione anche con tocco sulla mini mappa. Punti sulla mappa: bianco/nero, blu se con la fidanzata.
  Paese e regione sono calcolati alla scelta della posizione (§7.3) e modificabili (la regione solo per l'Italia).

### 3.3 Viaggi

- Elenco in tre sezioni: **In corso**, **In programma** (per data crescente), **Passati** (data decrescente); card con titolo, date, tappe, spesa.
- **Scheda**: titolo, date, stato; tappe in ordine (↑/↓, **Aggiungi tappa**: luogo esistente o nuovo con `#luogo/nuovo?trip=<id>`); mappa del percorso casa → tappe → casa;
  spesa totale; nota; **Modifica**, **Elimina** (conferma).
- **Nuovo/Modifica**: titolo (max 60), dal / al (`dal ≤ al`), spesa totale facoltativa (≥ 0), nota.
- Un luogo in un viaggio passato o in corso conta come visitato.

### 3.4 Impostazioni

Tema (automatico / chiaro / scuro); casa (inizio del percorso dei viaggi; default Napoli 40,85 N 14,27 E, modificabile con ricerca o posizione attuale);
sincronizzazione (§8); Esporta / Importa backup; crediti; versione.

## 4. Modello dati

IndexedDB, database `atlas`, versione 1, object store `doc` (chiave `"v1"`: il documento) e `meta` (configurazione sync `sync`, documento corrotto `v1.corrupt`).
Il documento viene caricato all'avvio, tenuto in memoria e salvato a ogni modifica.

```json
{
  "version": 1,
  "places": [{ "id": "l_ab12cd", "name": "Positano", "cat": "borgo", "status": "visited", "from": "2024-08", "to": "2024-08", "partner": false, "scores": { "cibo": 5 },
    "note": "", "lat": 40.628, "lon": 14.485, "country": "IT", "region": "Campania",
    "deleted": false, "updatedAt": 1798364400000 }],
  "trips": [{ "id": "v_ab12cd", "title": "Costiera", "from": "2026-06-10", "to": "2026-06-14",
    "stops": [{ "place": "l_ab12cd" }], "note": "", "spend": 640,
    "deleted": false, "updatedAt": 1798364400000 }],
  "marks": { "c:PT": { "s": "visited", "t": 1798364400000 } },
  "settings": { "theme": "auto", "home": { "name": "Napoli", "lat": 40.85, "lon": 14.27 }, "lastBackup": 0 }
}
```

- **id**: prefisso + 6 caratteri base36 casuali (`l_` luogo, `v_` viaggio). Date locali `YYYY-MM-DD`, mai UTC; `t`/`updatedAt`: millisecondi epoch.
- **places**: `status` `visited` | `wish`; `from`/`to` mesi `YYYY-MM` (`to` ≥ `from`), `partner` booleano, `scores` oggetto 1–5, tutti facoltativi e solo se visitato; `country` codice paese, `region` nome regione o `null` (fuori Italia `null`).
- **trips**: `from ≤ to`; `spend` euro ≥ 0 o `null`; `stops[]` = `{ place }`.
- **marks**: chiavi `c:<codice paese>`, `r:<nome regione>`; `s` `visited` oppure `null` (segno tolto; la chiave resta per il merge).
- Soft delete (`deleted: true`) per luoghi e viaggi; gli oggetti restano per il merge.
- **Documenti vecchi**: i campi sconosciuti (voto, tag, costi, diario, province…) sono ignorati da `validateDoc` e scartati da `sanitizeDoc`
  (import, sync, avvio), che mappa anche `planned` → `wish`, `date`/l'ultima visita → `from`=`to` (mese), la somma dei costi → `spend`. Mai errori per campi extra.
- All'avvio: `navigator.storage.persist()`.

## 5. Regole (`logic.js`, funzioni pure)

Esclusi sempre gli oggetti con `deleted: true`. `oggi` = data locale corrente.

### 5.1 Stato di un luogo
**visitato**: `status = visited`, oppure tappa di un viaggio con `from ≤ oggi` (passato o in corso). Tutti gli altri: **da visitare**.

### 5.2 Stato di un viaggio e di un'area
Viaggio: in corso `from ≤ oggi ≤ to`; in programma `from > oggi`; passato `to < oggi`.
Area (`c:<paese>`, `r:<regione>`): massimo, nell'ordine visitato > da visitare > mai, tra gli stati dei luoghi con quel `country` / `region` e il segno manuale
(`marks[...].s = visited`). Una regione visitata rende visitata anche l'Italia (`c:IT`). I numeri della mappa contano le aree visitate e i luoghi visitati.

### 5.3 Raggruppamento punti
Dopo ogni cambio di zoom: proiezione dei punti in coordinate schermo, griglia di 44 px; celle con più punti → pallino con il numero alla media dei punti; cella con un punto → punto singolo.

## 6. Foto

Non previste (limiti di spazio su GitHub).

## 7. Mappa e dati geografici

### 7.1 Dati
- Fonte: Natural Earth (pubblico dominio), tag `v5.1.2`: `ne_50m_admin_0_countries` (paesi: nome italiano, codice `ISO_A2_EH`) e
  `ne_10m_admin_1_states_provinces` filtrato `ADM0_A3 = ITA` (province con nome e regione).
- `scripts/build-geo.mjs` (eseguito una volta in sviluppo, risultati nel repository): scarica i GeoJSON, semplifica, quantizza, codifica a differenze,
  scrive `geo/world.json` e `geo/italia.json`. `italia.json` resta per province: la vista Italia le disegna colorate con lo stato della loro regione e senza bordo interno
  (nessuna fusione di poligoni); un file con le sole regioni non farebbe risparmiare spazio.
- Formato: `{ "q": 1000, "features": [{ "k": "IT", "n": "Italia", "r": "Campania", "rings": [[x0, y0, dx1, dy1, …]] }] }` (`r` solo per le province).

### 7.2 Disegno
- Proiezioni: Mondo **globo ortografico** (SVG ridisegnato a ogni rotazione: il trascinamento ruota il globo, pizzico / rotella / doppio tocco ingrandiscono 1×–8×, anelli tagliati all'orizzonte, punti sul lato nascosto non disegnati, vista iniziale su Europa lon 12° lat 40°); Italia equirettangolare `x = (lon − 12,5) · cos 42°`, `y = −lat`.
- Un `path` SVG per area; Italia: generato una volta, zoom e spostamento cambiano solo il `viewBox`; Mondo: ricalcolato a ogni rotazione o zoom; i punti si ricalcolano a ogni cambio di zoom (§5.3).
- Gesti con Pointer Events (un dito = sposta, due dita = zoom attorno al punto medio), rotella = zoom attorno al cursore.

### 7.3 Paese e regione da coordinate
Punto nel poligono (regola pari-dispari) sui dati di §7.1: prima i paesi, poi, se Italia, le province (→ regione).
Punto fuori da ogni area (mare, costa semplificata) → area più vicina entro 20 km, altrimenti `null`.

### 7.4 Ricerca luoghi (`search.js`)
- Nominatim (OpenStreetMap): `search?format=jsonv2&q=<testo>&accept-language=it&limit=8` e `reverse?...&zoom=14`.
- Solo al tocco su **Cerca**, al massimo una richiesta al secondo. Al servizio arriva solo il testo cercato o le coordinate.

## 8. Sincronizzazione, backup e merge

### 8.1 Configurazione
- Token classico con il solo scope **gist** (`https://github.com/settings/tokens/new?scopes=gist&description=Atlas%20sync`). Nessun repository da creare.
- **Collega**: token, password ≥ 8 caratteri. Configurazione in `meta.sync`: `{ token, gistId, salt, iterations, key }` (chiave AES derivata in base64; la password non viene salvata).

### 8.2 Documento
- File `atlas-sync.json` di un Gist segreto (`public: false`) = busta come Habits: `{ "app": "atlas", "v": 1, "kdf": { "name": "PBKDF2-SHA256", "iterations": 310000, "salt": "…" }, "iv": "…", "z": "gzip", "data": "…" }`;
  `data` = AES-GCM 256 del JSON compresso con `CompressionStream('gzip')`.
- Ricerca: `GET /gists?per_page=100` (pagine successive se serve), primo Gist che contiene `atlas-sync.json`; i Gist di Habits, Fitness e ogni altro non vengono mai letti né modificati.
- Lettura: `GET /gists/{id}`; se il file è troncato (> 1 MB) si legge `raw_url` senza inviare il token.
- **Collega**: Gist assente → nuovo salt, `POST /gists` con il documento locale; presente → decifra (errore = "Password errata"), merge, scrittura se serve.
- **Sync** (avvio, ritorno online, ritorno in primo piano, 3 s dopo ogni modifica, passaggio in background, **Sincronizza ora**):
  leggi → decifra → merge → `PATCH /gists/{id}` solo se i dati locali hanno qualcosa di più recente del remoto.
  Prima di scrivere si confronta la revisione del Gist con quella appena letta; se un altro dispositivo ha scritto → rilettura, merge, nuovo tentativo (massimo 3).
  Il documento remoto passa da `sanitizeDoc`: un documento del modello vecchio si legge senza errori.

### 8.3 Backup
File `atlas-backup-AAAA-MM-GG.json` (solo documento); iPhone `navigator.share({files})`, PC download. Import con `sanitizeDoc`, poi merge.

### 8.4 Merge (vince il più recente)
`places`, `trips` per `id` con `updatedAt`; `marks` per chiave con `t`; `settings` locali, `lastBackup` = max. Esito: "N elementi aggiornati".

## 9. Architettura file

```
index.html              shell + tab bar
style.css               stile, token colore, tema chiaro/scuro
manifest.webmanifest    nome "Atlas", icone, display standalone, scope "./"
sw.js                   offline, cache "atlas-v3" (precache app + geo/*.json)
icons/                  atlas-v1.svg, -192.png, -512.png, -maskable-512.png, -apple-180.png
geo/                    world.json, italia.json (generati)
js/app.js               avvio, router hash, tema, registrazione SW
js/db.js                unico modulo che accede a IndexedDB
js/store.js             documento in memoria, CRUD, evento change, salvataggio, backup, scheduling sync
js/logic.js             stati luogo / viaggio / area, numeri della mappa (puro)
js/geo.js               proiezioni, decodifica, punto nel poligono, haversine, raggruppamento (puro)
js/merge.js             validateDoc, sanitizeDoc, mergeDocs (puro)
js/map.js               mappa SVG, gesti, tocchi
js/crypto.js            da Habits + gzip
js/sync.js              GitHub Gist API: documento, conflitti, limiti
js/search.js            Nominatim diretta e inversa
js/ui.js                escape, formattazione, fogli modali
js/views/               map, places, place, place-edit, trips, trip, trip-edit, settings
scripts/                build-geo.mjs, serve.mjs, make-icons.mjs
tests/                  logic, geo, geo-data, merge, sync, ui, sw-files (.test.js, node --test)
```

- `logic.js`, `geo.js`, `merge.js` non accedono a DOM, rete né storage. `db.js` è l'unico modulo che usa IndexedDB; `store.js` l'unico che modifica il documento.
- **Aspetto** (terracotta): `--accent: #c2410c`, `--accent-strong: #9a3412` per pulsanti pieni con testo bianco; tema scuro `#f0a07a` con `--on-accent: #0f1117`.
  Mappa: visitato `--accent`, da visitare `--accent` al 25 %, mai `--empty`.
- Offline: pagine dalla rete (timeout 3 s, poi cache); altri file dalla cache con aggiornamento in background; precache con `cache: 'reload'`.

## 10. Convivenza con Habits e Fitness

Stessa origine `lucfal00.github.io`: database IndexedDB `atlas`, cache con prefisso `atlas-`, nessuna chiave `localStorage`.
Il service worker di Atlas cancella solo le cache `atlas-*` diverse da quella corrente.

## 11. Errori

| Caso | Comportamento |
|---|---|
| IndexedDB non disponibile | banner persistente, nessun salvataggio |
| Documento corrotto | copia in `meta["v1.corrupt"]`, avvio con il resto, avviso |
| Import invalido | messaggio, nessuna modifica |
| Sync 401 | "Token non valido o scaduto" + banner |
| Sync 403 (permessi) | "Accesso ai gist negato: il token deve avere lo scope gist" + banner |
| Sync 403 (limite richieste) | pausa fino allo sblocco, poi ripresa |
| Sync 404 Gist | "Gist di sincronizzazione non trovato: scollega e ricollega" + banner |
| Decifratura fallita | "Password errata" (collega) / "Password cambiata su un altro dispositivo: ricollega" (sync) + banner |
| Modifica concorrente sul Gist | nuovo tentativo automatico (max 3), poi "Riprova più tardi" |
| Rete assente | sync in attesa, nessun banner |
| gzip non supportato | "Browser non supportato per la sincronizzazione" |
| Ricerca senza rete | "Serve internet per cercare: tocca la mappa o usa la posizione" |
| Geolocalizzazione negata | messaggio, inserimento manuale |

## 12. Test e verifica

- `node --test tests/`: `logic` (stati luogo / viaggio / area, segni manuali, numeri della mappa), `geo` e `geo-data`, `merge` (validazione, `sanitizeDoc` di un documento vecchio, merge per `id` e per chiave),
  `sync` (API GitHub simulata), `ui`, `sw-files`.
- Browser (viewport mobile, server locale): mappa Mondo e Italia, nuovo luogo con pressione lunga e ricerca simulata, scheda e modifica luogo,
  viaggio con due tappe passate, impostazioni, nessuna scroll orizzontale a 375 px, nessun errore in console. La prova reale con token la esegue l'utente.

## 13. Pubblicazione

Repository pubblico `lucfal00/atlas`, GitHub Pages dalla branch `main`, root. Token con il solo scope `gist` (istruzioni nel README).
Installazione: iPhone Safari → Condividi → Aggiungi a Home; PC Chrome/Edge → Installa app.
