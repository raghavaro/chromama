// IndexedDB wrapper. Chosen over chrome.storage.local because ~1000 tabs of
// rich archive state will strain that quota; with "unlimitedStorage" this is
// effectively disk-bound. See decisions/001.

const DB_NAME = 'chromama';
const DB_VERSION = 2;

export const STORE_ARCHIVE = 'archive';
export const STORE_SNAPSHOTS = 'snapshots';
export const STORE_TAXONOMY = 'taxonomy';
export const STORE_CLASSIFICATIONS = 'classifications';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_ARCHIVE)) {
        const archive = db.createObjectStore(STORE_ARCHIVE, { keyPath: 'id' });
        archive.createIndex('archivedAt', 'archivedAt');
        archive.createIndex('url', 'url');
      }

      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        const snapshots = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' });
        snapshots.createIndex('createdAt', 'createdAt');
      }

      // v2: the persisted taxonomy (see decisions/002 — the load-bearing piece)
      // and a URL-keyed classification cache so re-runs are near-free.
      if (!db.objectStoreNames.contains(STORE_TAXONOMY)) {
        db.createObjectStore(STORE_TAXONOMY, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CLASSIFICATIONS)) {
        const cls = db.createObjectStore(STORE_CLASSIFICATIONS, { keyPath: 'url' });
        cls.createIndex('category', 'category');
        cls.createIndex('classifiedAt', 'classifiedAt');
      }

      void event;
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const objectStore = transaction.objectStore(store);
        let result;

        try {
          result = fn(objectStore);
        } catch (err) {
          reject(err);
          return;
        }

        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

function reqValue(request) {
  // Resolved by the transaction's oncomplete, so we just stash the result.
  const box = { value: undefined };
  request.onsuccess = () => {
    box.value = request.result;
  };
  return box;
}

export async function put(store, record) {
  await tx(store, 'readwrite', (s) => s.put(record));
  return record;
}

export async function putMany(store, records) {
  await tx(store, 'readwrite', (s) => {
    for (const record of records) s.put(record);
  });
  return records;
}

export async function get(store, id) {
  const box = await tx(store, 'readonly', (s) => reqValue(s.get(id)));
  return box.value;
}

export async function getAll(store) {
  const box = await tx(store, 'readonly', (s) => reqValue(s.getAll()));
  return box.value ?? [];
}

export async function remove(store, id) {
  await tx(store, 'readwrite', (s) => s.delete(id));
}

export async function removeMany(store, ids) {
  await tx(store, 'readwrite', (s) => {
    for (const id of ids) s.delete(id);
  });
}

export async function count(store) {
  const box = await tx(store, 'readonly', (s) => reqValue(s.count()));
  return box.value ?? 0;
}

export async function clear(store) {
  await tx(store, 'readwrite', (s) => s.clear());
}
