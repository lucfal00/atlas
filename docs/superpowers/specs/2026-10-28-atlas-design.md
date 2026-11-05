# Atlas — Design

Data: 2026-10-28
Stato: approvato in brainstorming, in revisione utente

Niente foto (decisione 2026-11-05: limiti di spazio su GitHub). Nessun salvataggio, caricamento, visore né copertina.

## 1. Obiettivo

App personale per raccogliere i luoghi visitati e da visitare, organizzarli in viaggi con date, costi e diario,
e vederli su un atlante disegnato con statistiche. Stessa base tecnica e stessa famiglia visiva di Habits e Fitness.

## 2. Vincoli

- iPhone (Safari, "Aggiungi a Home") + PC (Chrome/Edge, "Installa app"). Offline dopo la prima apertura (tranne la ricerca per nome).
- Nessuna libreria esterna, nessun build step: HTML/CSS/JS (ES modules). Moduli comuni copiati da Habits e adattati.
- GitHub Pages: repository pubblico `lucfal00/atlas` → `https://lucfal00.github.io/atlas/`.
- Dati sincronizzati cifrati in un Gist GitHub **segreto** dell'utente (file `atlas-sync.json`), come in Habits.
- Lingua UI: italiano. Importi in euro. Settimana lunedì–domenica.

## 3. Fuori ambito (v1)

Mappa con strade, video, viaggi condivisi con altre persone, valute diverse dall'euro, ricerca per nome offline,
import da Google Maps/Cronologia, notifiche.

## 4. Schermate

Tab bar in basso: **Mappa · Luoghi · Viaggi · Statistiche · Impostazioni**.
Hash router: `#mappa`, `#luoghi`, `#viaggi`, `#stats`, `#impostazioni`, `#luogo/<id>`, `#viaggio/<id>`,
`#diario/<viaggio>/<giorno>`, `#anno/<AAAA>`.

### 4.1 Mappa

- Selettore **Mondo | Italia**; in Italia selettore **Regioni | Province**.
- Aree colorate per stato (§6.3): visitato, in programma, da visitare, mai.
- Luoghi come punti: pieno = visitato, blu = in programma, anello = da visitare. Raggruppamento (§6.6): pallino con numero; tocco → zoom ×2 centrato.
- Gesti: trascinamento, pizzico con due dita, rotella e trascinamento su PC, doppio tocco = zoom ×2. Zoom 1×–40× (Mondo), 1×–20× (Italia).
- Tocco su un'area → foglio: nome, stato, segno manuale (**Segna come visitato** / **Togli segno**), luoghi e viaggi nell'area, **Aggiungi luogo qui**.
- Tocco su un punto → anteprima del luogo (nome, stato) → apre `#luogo/<id>`.
- Pressione lunga su un punto vuoto della mappa → **Nuovo luogo qui** con quelle coordinate.
- Filtri: stato, categoria, anno di visita. Pulsante **+** (nuovo luogo).

### 4.2 Luoghi (`#luoghi`, `#luogo/<id>`)

- Elenco con ricerca per nome, filtri (stato, categoria, paese, tag, preferiti), ordinamento (modificati di recente, nome, voto, distanza da casa).
- **Scheda luogo**:
  - nome, categoria, stato (§6.1), voto 1–5, preferito ♥;
  - mini mappa con il punto, coordinate, paese / regione / provincia, **Apri in Mappe** (link Apple Maps su iPhone, Google Maps altrove);
  - visite: date in `visits` + tappe di viaggi (con link al viaggio);
  - note, lista "cose da fare" con spunte, link, tag, compagni;
  - da visitare: periodo ideale (mesi), budget stimato;
  - **Modifica**, **Elimina** (conferma).
- **Nuovo/Modifica luogo**:
  - nome (obbligatorio, max 60 caratteri), categoria: `citta`, `borgo`, `natura`, `mare`, `montagna`, `cultura`, `ristorante`, `locale`, `alloggio`, `esperienza`, `altro`;
  - stato `visited` | `wish`; posizione con tre modi: **Cerca** per nome (online, §8.4), tocco sulla mini mappa, **Posizione attuale**;
  - paese / regione / provincia calcolati alla scelta della posizione (§8.3), modificabili;
  - campi del modello §5.

### 4.3 Viaggi (`#viaggi`, `#viaggio/<id>`, `#diario/<viaggio>/<giorno>`)

- Elenco in tre sezioni: **In corso**, **In programma** (per data crescente), **Passati** (per anno, data decrescente); card con titolo, date, notti, numero tappe, spesa.
- **Scheda viaggio**:
  - titolo, date, notti, compagni, stato (§6.2);
  - tappe in ordine (luogo + date facoltative), riordinabili; **Aggiungi tappa** (luogo esistente o nuovo);
  - mappa del percorso: casa → tappe → casa, linee a geodetica approssimata (segmenti dritti in proiezione);
  - **Costi**: per categoria `trasporti`, `alloggio`, `cibo`, `attivita`, `altro` budget vs spesa con barra; elenco spese (importo, categoria, data, nota); totale, costo per notte;
  - **Diario**: una riga per ogni giorno da `from` a `to` → `#diario/<viaggio>/<giorno>` con testo, luoghi del giorno;
  - note, link (prenotazioni);
  - **Modifica**, **Elimina** (conferma).
- Accorciando le date, le pagine di diario fuori dal periodo restano salvate e compaiono in "Pagine fuori dalle date".

### 4.4 Statistiche (`#stats`, `#anno/<AAAA>`)

- Paesi visitati (numero, elenco per continente), regioni italiane visitate su 20, province visitate su totale, luoghi visitati.
- Giorni in viaggio e numero di viaggi per anno (barre); mese con più giorni in viaggio.
- Km per anno; luogo più lontano da casa; estremi nord/sud/est/ovest.
- Spese: totale per anno, ripartizione per categoria, costo medio per notte, viaggio più caro ed economico.
- Elenco degli anni → **Il tuo anno in viaggio** (`#anno/<AAAA>`, §6.5): mappa con i paesi visitati nell'anno e numeri principali.

### 4.5 Impostazioni

- Tema: automatico / chiaro / scuro. Casa: luogo base (default Napoli 40,85 N 14,27 E), modificabile con ricerca o posizione attuale.
- Sincronizzazione (§9): token, password; **Collega** / **Sincronizza ora** / **Scollega**; stato.
- Spazio: dati sul dispositivo (`navigator.storage.estimate()`).
- Esporta / Importa backup (solo dati, §9.3). Data ultimo backup, versione app.
- Crediti: Natural Earth (confini), OpenStreetMap / Nominatim (ricerca luoghi).

## 5. Modello dati

IndexedDB, database `atlas`, versione 1, object store:

| Store | Chiave | Contenuto |
|---|---|---|
| `doc` | `"v1"` | documento JSON (sotto) |
| `meta` | stringa | configurazione sync (`sync`), documento corrotto (`v1.corrupt`) |

Il documento viene caricato all'avvio, tenuto in memoria e salvato a ogni modifica.

```json
{
  "version": 1,
  "places": [{ "id": "l_ab12cd", "name": "Positano", "cat": "borgo", "status": "wish",
    "lat": 40.628, "lon": 14.485, "country": "IT", "region": "Campania", "province": "Salerno",
    "rating": null, "fav": false, "tags": ["mare"], "note": "", "with": [],
    "todo": [{ "id": "a_k2m4n6", "text": "Sentiero degli Dei", "done": false }],
    "links": [{ "label": "Sito", "url": "https://example.org" }], "months": [5, 6, 9], "budget": 300,
    "visits": ["2019-08-15"], "deleted": false, "updatedAt": 1798364400000 }],
  "trips": [{ "id": "v_ab12cd", "title": "Costiera", "from": "2026-06-10", "to": "2026-06-14",
    "with": [], "note": "", "links": [],
    "stops": [{ "place": "l_ab12cd", "from": "2026-06-10", "to": "2026-06-12" }],
    "budget": { "trasporti": 100, "alloggio": 400, "cibo": 200, "attivita": 50, "altro": 0 },
    "costs": [{ "id": "c_p9o8i7", "cat": "alloggio", "amount": 380, "date": "2026-06-10", "note": "B&B" }],
    "deleted": false, "updatedAt": 1798364400000 }],
  "diary": { "v_ab12cd:2026-06-10": { "text": "…", "places": ["l_ab12cd"], "t": 1798364400000 } },
  "marks": { "c:PT": { "s": "visited", "t": 1798364400000 } },
  "settings": { "theme": "auto", "home": { "name": "Napoli", "lat": 40.85, "lon": 14.27 }, "lastBackup": 0 }
}
```

- **id**: prefisso + 6 caratteri base36 casuali (`l_` luogo, `v_` viaggio, `c_` costo, `a_` cosa da fare).
- **Date** locali `YYYY-MM-DD`, mai UTC; `t`/`updatedAt`: millisecondi epoch.
- **places**: `status` `visited` | `wish`; `rating` 1–5 o `null`; `months` 1–12; `budget` euro o `null`; `visits` date di visite fuori dai viaggi;
  `country` codice paese (§8.1), `region`/`province` nomi o `null` (fuori Italia `null`).
- **trips**: `from ≤ to` obbligatorie; `stops[].from/to` facoltative, dentro il periodo del viaggio; `budget` per categoria (euro, 0 = non previsto); `costs[].amount` euro > 0.
- **diary**: chiave `<id viaggio>:<giorno>`; `places` = luoghi del giorno.
- **marks**: chiavi `c:<codice paese>`, `r:<nome regione>`, `p:<nome provincia>`; `s` `visited` oppure `null` (segno tolto; la chiave resta per il merge).
- Soft delete (`deleted: true`) per luoghi e viaggi; gli oggetti restano per il merge.
- All'avvio: `navigator.storage.persist()`.

## 6. Regole (`logic.js`, funzioni pure)

Esclusi sempre gli oggetti con `deleted: true`. `oggi` = data locale corrente.

### 6.1 Stato di un luogo
- **visitato**: `status = visited`, oppure `visits` non vuoto, oppure è tappa di un viaggio con `from ≤ oggi`.
- **in programma**: non visitato ed è tappa di un viaggio con `from > oggi`.
- **da visitare**: tutti gli altri.

### 6.2 Stato di un viaggio
In corso `from ≤ oggi ≤ to`; in programma `from > oggi`; passato `to < oggi`. Notti = giorni tra `from` e `to`.

### 6.3 Stato di un'area (paese, regione, provincia)
Massimo, nell'ordine visitato > in programma > da visitare > mai, tra:
gli stati dei luoghi con quel `country` / `region` / `province` e il segno manuale (`marks[...].s = visited` → visitato).
Una regione o provincia visitata rende visitata anche l'Italia (`c:IT`).

### 6.4 Statistiche
- **Paesi visitati**: aree paese con stato visitato; raggruppati per continente (§8.1). Regioni: su 20; province: sul totale nei dati geografici.
- **Giorni in viaggio** nell'anno A: numero di giorni distinti di A coperti da almeno un viaggio non futuro (giorni ≤ oggi).
- **Viaggi per anno**: viaggi con `from` nell'anno.
- **Km di un viaggio**: somma delle distanze haversine (R = 6371 km) casa → tappa 1 → … → tappa n → casa; senza tappe = 0.
  Km di un anno = somma dei viaggi passati o in corso con `from` nell'anno.
- **Spesa** di un viaggio = Σ `costs.amount`; scostamento per categoria = spesa − budget; costo per notte = spesa / notti (notti = 0 → spesa).
- **Più lontano**: luogo visitato con distanza haversine massima da casa. **Estremi**: luoghi visitati con latitudine massima/minima e longitudine massima/minima.
- **Mese preferito**: mese con più giorni in viaggio sommando tutti gli anni.

### 6.5 Anno in viaggio (anno A)
Viaggi con `from` in A (non futuri); giorni in viaggio in A; km in A; spesa dei viaggi di A; paesi visti per la prima volta in A
(prima data di visita del paese = minima tra `visits` e date di tappa dei suoi luoghi; i paesi solo segnati non hanno data e sono esclusi);
luogo con voto più alto visitato in A; mappa con i paesi visitati in A.

### 6.6 Raggruppamento punti
Dopo ogni cambio di zoom: proiezione dei punti in coordinate schermo, griglia di 44 px; celle con più di un punto → pallino con il numero
posizionato alla media dei punti; cella con un punto → punto singolo.

## 7. Foto

Non previste (vedi intro). Il numero resta per non cambiare i riferimenti alle sezioni successive.

## 8. Mappa e dati geografici

### 8.1 Dati
- Fonte: Natural Earth (pubblico dominio), versione fissata tag `v5.1.2`:
  `ne_50m_admin_0_countries` (paesi: nome italiano `NAME_IT`, codice `ISO_A2_EH`, fallback `ADM0_A3`; continente `CONTINENT`) e
  `ne_10m_admin_1_states_provinces` filtrato `ADM0_A3 = ITA` (province con nome e regione; se il campo regione manca o è incompleto, lo script usa una tabella provincia → regione).
- `scripts/build-geo.mjs` (eseguito una volta in sviluppo, risultati nel repository): scarica i GeoJSON, semplifica con Visvalingam–Whyatt,
  quantizza (mondo 0,001°, Italia 0,0001°), codifica gli anelli a differenze, scrive `geo/world.json` e `geo/italia.json` (obiettivo ≤ 300 KB ciascuno).
- Formato: `{ "q": 1000, "features": [{ "k": "IT", "n": "Italia", "c": "Europe", "r": "Campania", "rings": [[x0, y0, dx1, dy1, …]] }] }`
  (`r` solo per le province).

### 8.2 Disegno
- Proiezioni: Mondo **Equal Earth**; Italia equirettangolare `x = (lon − 12,5) · cos 42°`, `y = −lat`.
- Un `path` SVG per area, generato una volta per vista; zoom e spostamento cambiano solo il `viewBox`; i punti si ricalcolano a ogni cambio di zoom (§6.6).
- Regioni: province colorate con lo stato della regione e bordo dello stesso colore (nessuna fusione di poligoni); vista Province: bordo `--line`.
- Gesti con Pointer Events (un dito = sposta, due dita = zoom attorno al punto medio), rotella = zoom attorno al cursore.

### 8.3 Paese, regione, provincia da coordinate
Punto nel poligono (regola pari-dispari su tutti gli anelli dell'area) sui dati di §8.1: prima i paesi, poi, se Italia, le province (→ regione).
Punto fuori da ogni area (mare, costa semplificata) → area più vicina entro 20 km (distanza dal vertice più vicino), altrimenti `null`.

### 8.4 Ricerca luoghi (`search.js`)
- Nominatim (OpenStreetMap): `search?format=jsonv2&q=<testo>&accept-language=it&limit=8` e `reverse?format=jsonv2&lat=&lon=&accept-language=it&zoom=14`.
- Solo al tocco su **Cerca** (niente ricerca durante la digitazione), al massimo una richiesta al secondo. Al servizio arriva solo il testo cercato o le coordinate.

## 9. Sincronizzazione, backup e merge

### 9.1 Configurazione
- L'utente crea un token classico con il solo scope **gist** (`https://github.com/settings/tokens/new?scopes=gist&description=Atlas%20sync`). Nessun repository da creare.
- **Collega**: token, password ≥ 8 caratteri.
- Configurazione in `meta.sync`: `{ token, gistId, salt, iterations, key }` (chiave AES derivata in base64; la password non viene salvata).

### 9.2 Documento
- File `atlas-sync.json` di un Gist segreto (`public: false`, descrizione "Atlas – dati sincronizzati (cifrati)") = busta come Habits: `{ "app": "atlas", "v": 1, "kdf": { "name": "PBKDF2-SHA256", "iterations": 310000, "salt": "…" }, "iv": "…", "z": "gzip", "data": "…" }`;
  `data` = AES-GCM 256 del JSON compresso con `CompressionStream('gzip')`.
- Ricerca: `GET /gists?per_page=100` (pagine successive se serve) e si prende il primo Gist che contiene il file `atlas-sync.json`; i Gist di Habits (`habits-sync.json`), Fitness (`fitness-sync.json`) e ogni altro Gist non vengono mai letti né modificati.
- Lettura: `GET /gists/{id}` → contenuto del file; se è troncato (file > 1 MB) si legge `raw_url` senza inviare il token.
- **Collega**: Gist assente → nuovo salt, `POST /gists` con il documento locale; presente → decifra (errore = "Password errata"), merge, scrittura se serve.
- **Sync** (come Habits: avvio, ritorno online, ritorno in primo piano, 3 s dopo ogni modifica, passaggio in background con sync in attesa, **Sincronizza ora**):
  leggi → decifra → merge → `PATCH /gists/{id}` solo se i dati locali hanno qualcosa di più recente del remoto.
  I Gist non hanno `sha`: prima di scrivere si confronta la revisione del Gist (`GET /gists/{id}/commits?per_page=1`) con quella appena letta;
  se un altro dispositivo ha scritto nel frattempo → rilettura, merge, nuovo tentativo (massimo 3). Modifiche durante la sync preservate (merge finale con lo stato corrente).

### 9.3 Backup
File `atlas-backup-AAAA-MM-GG.json` (solo documento); iPhone `navigator.share({files})`, PC download.
Import con validazione, poi merge.

### 9.4 Merge (vince il più recente)
`places`, `trips` per `id` con `updatedAt`; `diary`, `marks` per chiave con `t`; `settings` locali, `lastBackup` = max.
Esito: "N elementi aggiornati".

## 10. Architettura file

```
index.html              shell + tab bar
style.css               stile, token colore, tema chiaro/scuro
manifest.webmanifest    nome "Atlas", icone, display standalone, scope "./"
sw.js                   offline, cache "atlas-v1" (precache app + geo/*.json)
icons/                  atlas-v1.svg, -192.png, -512.png, -maskable-512.png, -apple-180.png
geo/                    world.json, italia.json (generati)
seed/weekend.json       mete dall'Atlante dei weekend (backup da importare una volta, §13)
js/app.js               avvio, router hash, tema, registrazione SW
js/db.js                unico modulo che accede a IndexedDB
js/store.js             documento in memoria, CRUD, evento change, salvataggio, backup, scheduling sync
js/logic.js             stati, giorni, km, statistiche, anno in viaggio (puro)
js/geo.js               proiezioni, decodifica, punto nel poligono, haversine, raggruppamento (puro)
js/merge.js             validateDoc, mergeDocs (puro)
js/map.js               mappa SVG, gesti, livelli, tocchi
js/crypto.js            da Habits + gzip
js/sync.js              GitHub Contents API: documento, conflitti, limiti
js/search.js            Nominatim diretta e inversa
js/charts.js            da Habits
js/ui.js                escape, formattazione, palette, fogli modali
js/views/               map, places, place, place-edit, trips, trip, trip-edit, diary,
                        stats, year, settings
scripts/                build-geo.mjs, serve.mjs, make-icons.mjs
tests/                  logic, geo, merge, sync (.test.js, node --test)
```

- `logic.js`, `geo.js`, `merge.js` non accedono a DOM, rete né storage.
- `db.js` è l'unico modulo che usa IndexedDB; `store.js` l'unico che modifica il documento e notifica le viste con `change`.
- Viste: `render(container, state)`; la mappa aggiorna solo i livelli cambiati.
- **Aspetto** (terracotta, scelta dall'utente il 2026-10-28): token e componenti di Habits; `--accent: #c2410c` (grafici, aree visitate), `--accent-strong: #9a3412` per pulsanti pieni con testo bianco (7,3:1);
  tema scuro `#f0a07a` con `--on-accent: #0f1117`. Mappa: visitato `--accent`, in programma blu `#2563eb` (scuro `#60a5fa`), da visitare `--accent` al 25 %, mai `--empty`.
  Icona: riquadro `rx 23` con sfumatura terracotta `#f0a07a → #b8461f`; dentro, in crema `#fffaf4`, il planisfero Equal Earth
  (senza Antartide) con alcuni paesi pieni (visitati) e gli altri al 38 % come le barre di Habits, e uno spillo a goccia crema con alone `#d4683d` su Napoli.
- Offline: pagine dalla rete (timeout 3 s, poi cache); altri file dalla cache con aggiornamento in background; precache con `cache: 'reload'`.

## 11. Convivenza con Habits e Fitness

Stessa origine `lucfal00.github.io`: database IndexedDB `atlas`, cache con prefisso `atlas-`, nessuna chiave `localStorage`.
Il service worker di Atlas cancella solo le cache `atlas-*` diverse da quella corrente.
**Prerequisito alla pubblicazione** (comune con Fitness): il service worker di Habits deve cancellare solo le cache che iniziano con `habits-`.

## 12. Errori

| Caso | Comportamento |
|---|---|
| IndexedDB non disponibile | banner persistente, nessun salvataggio |
| Documento corrotto | copia in `meta["v1.corrupt"]`, avvio vuoto, avviso |
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

## 13. Import dell'Atlante dei weekend

`seed/weekend.json` è un backup Atlas (§9.3) generato una volta dai dati dell'artifact "Atlante dei weekend"; l'utente lo importa con **Importa backup**.
- 8 luoghi `status: wish`, categoria `citta`: Dublino, Atene, Parigi, Berlino, Varsavia, Cracovia, Tirana, Tolosa, con coordinate,
  `todo` = "cosa fare", `note` = monumento simbolo + "da sapere", `months` = mese del periodo indicato,
  `budget` = volo + trasporti + media hotel + media cibo (a persona).
- 2 viaggi in programma (meta "Fissato"): **Dublino** 2026-12-11 → 2026-12-13 e **Atene** 2027-01-01 → 2027-01-04, con la tappa corrispondente e budget
  `trasporti` = volo + trasporti, `alloggio` = media hotel, `cibo` = media cibo.
- Paese di ogni luogo calcolato come §8.3 al momento della generazione.

## 14. Test e verifica

- `node --test tests/`:
  - `logic`: stati luogo (tappa passata/futura, visite, `status`), stati viaggio, aree con segni manuali e regione → Italia, giorni in viaggio con sovrapposizioni e anno a cavallo,
    km haversine su distanze note, spesa/scostamento/costo per notte (notti = 0), più lontano ed estremi, anno in viaggio (paesi nuovi, segnati esclusi);
  - `geo`: Equal Earth su punti noti, decodifica, punto nel poligono con i dati veri (Napoli → IT / Campania / Napoli; Lisbona → PT; punto in mare vicino alla costa entro 20 km), raggruppamento;
  - `merge`: per `id`, per chiave, `marks.s = null`, diario, validazione;
  - `sync`: API GitHub simulata in memoria: collega (nuovo / esistente / password errata), push solo se necessario, 409 con nuovo tentativo, documento > 1 MB via blob,
    422 alla creazione concorrente, errore di rete, limite richieste, contenuto non leggibile in chiaro.
- Browser (viewport mobile, server locale): nuovo luogo con pressione lunga sulla mappa e con ricerca simulata;
  viaggio con tappe, costi, diario; statistiche e anno in viaggio; offline con service worker; sync con `fetch` simulato. La prova reale con token la esegue l'utente.

## 15. Pubblicazione

Prima la correzione di §11 in Habits. Poi repository pubblico `lucfal00/atlas`, GitHub Pages dalla branch `main`, root.
L'utente crea il token con il solo scope `gist` (istruzioni nel README, in italiano sul modello di Habits).
Installazione: iPhone Safari → Condividi → Aggiungi a Home; PC Chrome/Edge → Installa app.
