// Pure document validation and last-writer-wins merge (sync and backup import).
// No DOM, no network, no storage.

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const validItems = (a) => Array.isArray(a) && a.every((x) => isObj(x) && typeof x.id === 'string');

/** Timestamp of a record: `field` as a finite number, otherwise 0. */
const stamp = (o, field) => (Number.isFinite(o?.[field]) ? o[field] : 0);

export function validateDoc(d) {
  return isObj(d) && d.version === 1
    && validItems(d.places) && validItems(d.trips)
    && isObj(d.diary) && isObj(d.marks) && isObj(d.settings);
}

/** Union by id; the greater updatedAt wins, a tie keeps local. Local order, then incoming-only items. */
function mergeById(local, incoming) {
  const out = [...local];
  const index = new Map(out.map((x, i) => [x.id, i]));
  const taken = new Set();
  for (const x of incoming) {
    const i = index.get(x.id);
    if (i === undefined) {
      index.set(x.id, out.length);
      taken.add(out.length);
      out.push(x);
    } else if (stamp(x, 'updatedAt') > stamp(out[i], 'updatedAt')) {
      out[i] = x;
      taken.add(i);
    }
  }
  return { list: out, count: taken.size };
}

/** Union by key; the greater t wins, a tie keeps local. */
function mergeByKey(local, incoming) {
  const out = new Map(Object.entries(local));
  let count = 0;
  for (const [k, v] of Object.entries(incoming)) {
    if (!out.has(k) || stamp(v, 't') > stamp(out.get(k), 't')) {
      out.set(k, v);
      count++;
    }
  }
  return { map: Object.fromEntries(out), count };
}

/** Merge incoming into a copy of local (newest wins). `count` = elements taken from incoming. */
export function mergeDocs(local, incoming) {
  if (!validateDoc(local) || !validateDoc(incoming)) throw new Error('Documento non valido');
  const doc = structuredClone(local);
  const inc = structuredClone(incoming);
  let count = 0;
  for (const key of ['places', 'trips']) {
    const r = mergeById(doc[key], inc[key]);
    doc[key] = r.list;
    count += r.count;
  }
  for (const key of ['diary', 'marks']) {
    const r = mergeByKey(doc[key], inc[key]);
    doc[key] = r.map;
    count += r.count;
  }
  doc.settings.lastBackup = Math.max(stamp(doc.settings, 'lastBackup'), stamp(inc.settings, 'lastBackup'));
  return { doc, count };
}
