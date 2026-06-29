(function () {
  const DB_NAME = "phasefinder-debug";
  const STORE_NAME = "files";
  const DB_VERSION = 1;

  function is_debug_mode() {
    return new URLSearchParams(location.search).has("debug");
  }

  function open_db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(STORE_NAME, { keyPath: "name" });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function save_files_to_cache(files) {
    if (!is_debug_mode()) return;
    try {
      const db = await open_db();
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

  async function load_files_from_cache() {
    if (!is_debug_mode()) return [];
    try {
      const db = await open_db();
      const tx = db.transaction(STORE_NAME, "readonly");
      const records = await new Promise((resolve, reject) => {
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
      return records.map(({ name, type, lastModified: last_modified, buf }) =>
        new File([buf], name, { type, lastModified: last_modified })
      );
    } catch (err) {
      console.warn("[debug] Failed to load files from cache:", err);
      return [];
    }
  }

  async function clear_debug_cache() {
    try {
      const db = await open_db();
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

  window.PhaseFinderDebug = {
    isDebugMode: is_debug_mode,
    saveFilesToCache: save_files_to_cache,
    loadFilesFromCache: load_files_from_cache,
    clearDebugCache: clear_debug_cache,
  };
})();
