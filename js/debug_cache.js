(function () {
  const DB_NAME = "phasefinder-debug";
  const STORE_NAME = "files";
  const DB_VERSION = 1;

  function isDebugMode() {
    return new URLSearchParams(location.search).has("debug");
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(STORE_NAME, { keyPath: "name" });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function saveFilesToCache(files) {
    if (!isDebugMode()) return;
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const file of files) {
        const buf = await file.arrayBuffer();
        store.put({ name: file.name, type: file.type, lastModified: file.lastModified, buf });
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (err) {
      console.warn("[debug] Failed to save files to cache:", err);
    }
  }

  async function loadFilesFromCache() {
    if (!isDebugMode()) return [];
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_NAME, "readonly");
      const records = await new Promise((resolve, reject) => {
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
      return records.map(({ name, type, lastModified, buf }) =>
        new File([buf], name, { type, lastModified })
      );
    } catch (err) {
      console.warn("[debug] Failed to load files from cache:", err);
      return [];
    }
  }

  async function clearDebugCache() {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (err) {
      console.warn("[debug] Failed to clear cache:", err);
    }
  }

  window.PhaseFinderDebug = { isDebugMode, saveFilesToCache, loadFilesFromCache, clearDebugCache };
})();
