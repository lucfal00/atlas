// Development script: builds seed/weekend.json, an Atlas backup (spec §9.3, §13) from the "Atlante dei weekend" data.
// Run once: `node scripts/make-seed.mjs`. In Atlas: Impostazioni → Importa backup.
// Prices are per person, EUR. Country of each place is computed with geo.locate on the real geographic data (spec §8.3).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { emptyDoc } from '../js/logic.js';
import { locate } from '../js/geo.js';
import { validateDoc } from '../js/merge.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const world = read('../geo/world.json');
const italia = read('../geo/italia.json');

const CITIES = [
  {"code":"DUB","name":"Dublino","lat":53.35,"lon":-6.26,"stato":"Fissato","periodo":"11–13 dic","compagnia":"Ryanair","andata":"Ven 19:40 → 22:00","ritorno":"Dom 16:05 → 20:15","volo":116,"trasporti":16,"hotel":[150,190],"cibo":[60,85],"landmark":"Ha'penny Bridge sul Liffey · The Spire","fare":["Pinta a Temple Bar la sera dell’arrivo","Trinity College e Book of Kells","Grafton Street con le luminarie, St Stephen’s Green","Mercatino TwinkleTown a Smithfield","Guinness Storehouse o passeggiata sul Liffey"],"sapere":["Airlink 747 aeroporto ↔ centro: 8 € online a tratta, circa 30 min","Pinta 6–8 €, di più a Temple Bar","Il mercatino al Castello nel 2026 non si tiene","Partenza stretta: a Capodichino entro le 18:15, solo bagaglio a mano"]},
  {"code":"ATH","name":"Atene","lat":37.98,"lon":23.73,"stato":"Fissato","periodo":"1–4 gen","compagnia":"easyJet","andata":"Ven 1 gen 10:10 → 12:50","ritorno":"Lun 4 gen 15:45 → 16:35","volo":147,"trasporti":20,"hotel":[95,155],"cibo":[90,135],"landmark":"Partenone sull’Acropoli","fare":["Plaka, Anafiotika e Monastiraki","Tramonto sulla collina di Filopappou","Acropoli al mattino presto, poi Museo dell’Acropoli","Museo Archeologico Nazionale (gratis domenica 3 gennaio)","Licabetto o Psyrri la sera"],"sapere":["1° gennaio Acropoli e musei chiusi","Biglietto turistico 3 giorni: 20 € con andata e ritorno aeroporto","Acropoli 30 €, d’inverno 8–17","Borseggiatori sulla metro dell’aeroporto"]},
  {"code":"ORY","name":"Parigi","lat":48.86,"lon":2.35,"stato":"Opzione","periodo":"22–24 gen","compagnia":"easyJet / Transavia","andata":"Ven 20:30 → 22:50","ritorno":"Dom 17:25 → 19:40","volo":122,"trasporti":28,"hotel":[100,157],"cibo":[65,105],"landmark":"Tour Eiffel sulla Senna","fare":["Le Marais a piedi, place des Vosges","Montmartre al tramonto","Lungosenna e Île de la Cité","Pranzo a menu fisso in un bistrot (15–26 €)"],"sapere":["Metro 14 da Orly: biglietto aeroporti 14 € a tratta","Taxi Orly ↔ centro a tariffa fissa, circa 36–45 €","Fine febbraio gli hotel salgono: prenotare presto"]},
  {"code":"BER","name":"Berlino","lat":52.52,"lon":13.4,"stato":"Opzione","periodo":"19–21 feb","compagnia":"easyJet","andata":"Ven 16:45 → 19:05","ritorno":"Dom 14:05 → 16:15","volo":105,"trasporti":10,"hotel":[59,97],"cibo":[55,80],"landmark":"Porta di Brandeburgo · Fernsehturm","fare":["Porta di Brandeburgo e Unter den Linden","Cupola del Reichstag (gratis, prenotare)","East Side Gallery","Isola dei Musei"],"sapere":["Dall’aeroporto serve il biglietto ABC: 5 € a tratta","In città basta AB: 4 € la corsa","Rientro la domenica alle 14:05"]},
  {"code":"WAW","name":"Varsavia","lat":52.23,"lon":21.01,"stato":"Opzione","periodo":"19–21 feb","compagnia":"Wizz Air","andata":"Ven 17:25 → 19:45","ritorno":"Dom 20:20 → 22:45","volo":84,"trasporti":2,"hotel":[59,85],"cibo":[50,70],"landmark":"Palazzo della Cultura e della Scienza","fare":["Città Vecchia e Castello Reale","Parco Łazienki","Pranzo in un bar mleczny (3–5 €)","Vista dal Palazzo della Cultura"],"sapere":["Treno SKM dall’aeroporto: 4,40 zł, circa 20 min","Si paga in złoty, carta quasi ovunque","A febbraio spesso sotto zero"]},
  {"code":"KRK","name":"Cracovia","lat":50.06,"lon":19.94,"stato":"Opzione","periodo":"19–21 feb","compagnia":"Ryanair","andata":"Ven 15:25 → 17:25","ritorno":"Dom 14:30 → 16:35","volo":81,"trasporti":10,"hotel":[65,101],"cibo":[50,70],"landmark":"Basilica di Santa Maria · Sukiennice","fare":["Rynek Główny e il Sukiennice","Collina e castello del Wawel","Kazimierz, il quartiere ebraico, la sera"],"sapere":["Treno aeroporto ↔ centro: 20 zł, circa 18 min","Partenza venerdì alle 15:25: serve uscire prima dal lavoro","Auschwitz-Birkenau: mezza giornata, 40–90 €"]},
  {"code":"TIA","name":"Tirana","lat":41.33,"lon":19.82,"stato":"Opzione","periodo":"26–28 mar","compagnia":"Ryanair","andata":"Ven 19:00 → 20:15","ritorno":"Dom 21:25 → 22:40","volo":80,"trasporti":8,"hotel":[30,58],"cibo":[40,60],"landmark":"Piramide di Tirana · facciate colorate","fare":["Piazza Skanderbeg e la Moschea Et’hem Bey","Bunk’Art, il bunker trasformato in museo","Il quartiere Blloku la sera","Funivia del Dajti"],"sapere":["Bus aeroporto ogni ora: circa 4 €","Si paga in lek; pasto locale 6–8 €","Domenica 28 marzo cambia l’ora"]},
  {"code":"TLS","name":"Tolosa","lat":43.6,"lon":1.44,"stato":"Opzione","periodo":"1–4 gen","compagnia":"Ryanair","andata":"Ven 1 gen 08:25 → 10:30","ritorno":"Lun 4 gen 20:55 → 22:50","volo":113,"trasporti":4,"hotel":[118,147],"cibo":[135,165],"landmark":"Ariane 5 alla Cité de l’espace · la Ville Rose","fare":["Place du Capitole e la basilica di Saint-Sernin","Canal du Midi","Cité de l’espace e museo Aeroscopia","Cassoulet a pranzo"],"sapere":["Tram T2 aeroporto ↔ centro: circa 1,80 €","A Capodichino prima delle 7:30 del 1° gennaio","Menu del pranzo 12–18 €, cena in bistrot circa 35 €"]},
];

// Dates of the two fixed trips (stato "Fissato").
const TRIPS = {
  DUB: { from: '2026-12-11', to: '2026-12-13' },
  ATH: { from: '2027-01-01', to: '2027-01-04' },
};
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const STAMP = Date.UTC(2026, 9, 28);                 // fixed, so regenerating gives the same file
const avg = (r) => (r[0] + r[1]) / 2;
const r2 = (x) => Math.round(x * 100) / 100;

const doc = emptyDoc();
for (const c of CITIES) {
  const code = c.code.toLowerCase();
  const geo = locate(c.lat, c.lon, world, italia);
  const month = MONTHS.indexOf(c.periodo.trim().split(/\s+/).pop()) + 1;
  const id = `l_${code}000`.slice(0, 8);
  doc.places.push({
    id, name: c.name, cat: 'citta', status: 'wish', lat: c.lat, lon: c.lon,
    country: geo.country, region: geo.region, province: geo.province,
    rating: null, fav: false, tags: [],
    note: `${c.landmark}\n\nDa sapere:\n${c.sapere.map((s) => `- ${s}`).join('\n')}`,
    with: [],
    todo: c.fare.map((text, i) => ({ id: `a_${code}${String(i + 1).padStart(3, '0')}`, text, done: false })),
    links: [], months: month ? [month] : [],
    budget: r2(c.volo + c.trasporti + avg(c.hotel) + avg(c.cibo)),
    visits: [], deleted: false, updatedAt: STAMP,
  });
  const t = TRIPS[c.code];
  if (t) {
    doc.trips.push({
      id: `v_${code}000`, title: c.name, from: t.from, to: t.to, with: [],
      note: `${c.compagnia}: andata ${c.andata}, ritorno ${c.ritorno}.`, links: [],
      stops: [{ place: id, from: t.from, to: t.to }],
      budget: { trasporti: c.volo + c.trasporti, alloggio: avg(c.hotel), cibo: avg(c.cibo), attivita: 0, altro: 0 },
      costs: [], deleted: false, updatedAt: STAMP,
    });
  }
}

if (!validateDoc(doc)) throw new Error('Generated document is not valid');
mkdirSync(new URL('../seed/', import.meta.url), { recursive: true });
writeFileSync(new URL('../seed/weekend.json', import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);
console.log(`seed/weekend.json: ${doc.places.length} places, ${doc.trips.length} trips`);
