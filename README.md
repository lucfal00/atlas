# Atlas

Atlante personale dei luoghi visitati e da visitare: mappa e viaggi. App web installabile (PWA) che funziona offline, senza librerie esterne e senza build. Interfaccia in italiano, importi in euro.

Indirizzo: <https://lucfal00.github.io/atlas/>

## Funzioni

- **Mappa**: atlante disegnato dai confini Natural Earth, vista Mondo (globo ombreggiato con reticolato, che ruota piano da solo finché non lo tocchi) o Italia (regioni), con pulsante per tornare alla vista iniziale. Aree colorate per stato (visitato, da visitare, mai), punti bianchi/neri per i luoghi (pieno = visitato, anello = da visitare, marrone = con Adri), raggruppamento a zoom basso. Tre numeri in alto: paesi, regioni (su 20) e luoghi visitati. Tocco su un'area per vedere i luoghi e segnarla a mano come visitata; pressione lunga su un punto vuoto per creare un luogo.
- **Luoghi**: elenco con ricerca per nome. Ogni luogo ha categoria, stato (visitato o da visitare), data facoltativa, nota e posizione (ricerca per nome, tocco sulla mappa o posizione attuale); paese e regione sono calcolati sul dispositivo.
- **Viaggi**: date, tappe ordinate, percorso sulla mappa, spesa totale e nota. I luoghi di un viaggio passato o in corso contano come visitati.
- **Impostazioni**: tema (automatico, chiaro, scuro), città di casa (inizio del percorso), sincronizzazione, backup, crediti.
- Funziona offline dopo la prima apertura; l'unica cosa che richiede internet è la ricerca di un luogo per nome.

## Installazione

**iPhone (Safari)**: apri l'indirizzo, tocca Condividi, poi "Aggiungi alla schermata Home".

**PC (Chrome o Edge)**: apri l'indirizzo e usa l'icona "Installa app" nella barra degli indirizzi (oppure menu, "Installa Atlas").

I dati restano nel browser (IndexedDB) del dispositivo. Con la sincronizzazione attiva si ritrovano su tutti i dispositivi.

## Sincronizzazione (facoltativa)

I dati vengono cifrati sul dispositivo (AES-GCM, chiave derivata dalla password con PBKDF2) e salvati in un Gist **segreto** sul tuo account GitHub. Senza password il contenuto non è leggibile.

1. Crea un token: <https://github.com/settings/tokens/new?scopes=gist&description=Atlas%20sync>
   - lascia spuntato solo **gist**;
   - scegli la scadenza (quando scade, l'app avvisa e ne crei uno nuovo);
   - **Generate token** e copia il codice `ghp_…`.
2. In Atlas apri Impostazioni, sezione Sincronizzazione: incolla il token e scegli una password di cifratura (almeno 8 caratteri). Al primo collegamento Atlas crea il Gist segreto (file `atlas-sync.json`); non tocca gli altri tuoi Gist, nemmeno quelli di Habits e Fitness.
3. Su ogni altro dispositivo ripeti il collegamento con **lo stesso token e la stessa password**: i dati si uniscono (vince la modifica più recente di ogni elemento).

Il token resta solo su quel dispositivo e non viene mai incluso nei backup. Se perdi la password i dati cifrati non sono recuperabili: tieni un backup.

## Backup

Impostazioni, sezione Backup:

- **Esporta backup**: salva un file JSON con luoghi, viaggi e segni (non il token). Su iPhone si apre il foglio di condivisione ("Salva in File").
- **Importa backup**: unisce il file ai dati presenti, senza cancellare nulla. Se nel file ci sono singoli elementi non validi vengono ignorati e l'app dice quanti.

## Limiti

- GitHub consente 5.000 richieste all'ora per token: Atlas ne usa poche (una sincronizzazione ogni qualche secondo dopo una modifica) e si ferma da solo se il limite viene raggiunto.
- Si sincronizzano solo i dati: **niente foto**.
- Valuta unica: euro. Nessuna mappa stradale.
- La ricerca per nome usa internet; offline restano tocco sulla mappa e posizione attuale.
- Due modifiche allo stesso luogo o viaggio da due dispositivi: vince l'ultima salvata (l'intero elemento).

## Crediti

- Confini del mondo e dell'Italia: [Natural Earth](https://www.naturalearthdata.com/) (pubblico dominio), semplificati da `npm run geo`.
- Ricerca luoghi: [OpenStreetMap](https://www.openstreetmap.org/copyright) tramite Nominatim, solo al tocco su Cerca (al massimo una richiesta al secondo). Dati © collaboratori di OpenStreetMap, licenza ODbL.

## Sviluppo

Nessuna dipendenza da installare; serve solo Node.

```
npm test          # test (node --test)
npm run serve     # server locale su http://localhost:8082
npm run geo       # rigenera i dati geografici in geo/ (solo sviluppo, richiede rete)
npm run icons     # rigenera le icone in icons/
```

Dopo ogni modifica ai file dell'app aggiorna il nome della cache in `sw.js` (`atlas-v4`, `atlas-v5`, ...) così i dispositivi scaricano la nuova versione.
