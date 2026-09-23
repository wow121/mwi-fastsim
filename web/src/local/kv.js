// Tiny IndexedDB key-value store for the browser build (team, game data, market, jobs).
let dbp = null
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open("mwi-fastsim", 1)
    r.onupgradeneeded = () => r.result.createObjectStore("kv")
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  return dbp
}
function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction("kv", mode)
    const req = fn(t.objectStore("kv"))
    t.oncomplete = () => resolve(req?.result)
    t.onerror = () => reject(t.error)
  }))
}
export const kvGet = (k, d = null) => tx("readonly", s => s.get(k)).then(v => (v === undefined ? d : v))
export const kvSet = (k, v) => tx("readwrite", s => s.put(v, k))
export const kvDel = k => tx("readwrite", s => s.delete(k))
export const kvKeys = prefix => tx("readonly", s => s.getAllKeys()).then(ks => ks.filter(k => String(k).startsWith(prefix)))
