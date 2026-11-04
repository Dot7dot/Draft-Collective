// IndexedDB 封裝：所有畫作都存在手機本地
const DB_NAME = 'draft-collective';
const STORE = 'drawings';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('created', 'created');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function all() {
  const list = await tx('readonly', (s) => s.getAll());
  return (list || []).sort((a, b) => b.created - a.created);
}

export const get = (id) => tx('readonly', (s) => s.get(id));
export const put = (rec) => tx('readwrite', (s) => s.put(rec));
export const remove = (id) => tx('readwrite', (s) => s.delete(id));
