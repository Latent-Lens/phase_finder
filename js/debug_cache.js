// ============================================================
//  PhaseFinder multi-level debug cache
//
//  Level 1 (/debug)  – console logging + FCS file persistence
//  Level 2 (/meta)   – + metadata table state persistence
//  Level 3 (/plot)   – + plot panel state persistence
//
//  Activate:  navigate to /debug, /meta, or /plot — stub pages set the
//             level in localStorage and redirect back to the app.
//  Deactivate: navigate to /clear (clears all debug data and the level).
//
//  To strip debug support for production: delete this file and its <script>
//  tag in index.html, remove the header_brand/debug_level_badge elements,
//  remove /debug /meta /plot /clear stub directories, and remove the handful
//  of window.PhaseFinderDebug?.xxx() optional-chain calls in the other scripts.
// ============================================================
(function () {
  'use strict';

  // ── Level detection ───────────────────────────────────────
  const LEVEL_KEY      = 'pf_debug_level';
  const META_STATE_KEY = 'pf_meta_state';
  const PLOT_STATE_KEY = 'pf_plot_state';

  function get_debug_level() {
    const n = parseInt(localStorage.getItem(LEVEL_KEY), 10);
    return Number.isFinite(n) && n >= 1 && n <= 3 ? n : 0;
  }

  function is_debug_mode() { return get_debug_level() >= 1; }

  // ── IndexedDB – FCS file persistence (Level 1+) ──────────
  const DB_NAME    = 'phasefinder-debug';
  const FILES_STORE = 'files';
  const DB_VERSION = 1;

  function open_db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE, { keyPath: 'name' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror  = (e) => reject(e.target.error);
    });
  }

  async function save_files_to_cache(files) {
    if (!is_debug_mode()) return;
    try {
      const db    = await open_db();
      const tx    = db.transaction(FILES_STORE, 'readwrite');
      const store = tx.objectStore(FILES_STORE);
      for (const file of files) {
        const buf = await file.arrayBuffer();
        store.put({ name: file.name, type: file.type, lastModified: file.lastModified, buf });
      }
      await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = (e) => fail(e.target.error); });
    } catch (err) { console.warn('[PF debug] Failed to save files:', err); }
  }

  async function load_files_from_cache() {
    if (!is_debug_mode()) return [];
    try {
      const db = await open_db();
      const tx  = db.transaction(FILES_STORE, 'readonly');
      const records = await new Promise((ok, fail) => {
        const req = tx.objectStore(FILES_STORE).getAll();
        req.onsuccess = (e) => ok(e.target.result);
        req.onerror   = (e) => fail(e.target.error);
      });
      return records.map(({ name, type, lastModified: lm, buf }) =>
        new File([buf], name, { type, lastModified: lm })
      );
    } catch (err) { console.warn('[PF debug] Failed to load files:', err); return []; }
  }

  // ── Meta state – localStorage (Level 2+) ─────────────────
  function save_meta_state(state) {
    if (get_debug_level() < 2) return;
    try { localStorage.setItem(META_STATE_KEY, JSON.stringify(state)); }
    catch (err) { console.warn('[PF debug] Failed to save meta state:', err); }
  }

  function load_meta_state() {
    if (get_debug_level() < 2) return null;
    try {
      const raw = localStorage.getItem(META_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { console.warn('[PF debug] Failed to load meta state:', err); return null; }
  }

  // ── Plot state – localStorage (Level 3) ──────────────────
  function save_plot_state(state) {
    if (get_debug_level() < 3) return;
    try { localStorage.setItem(PLOT_STATE_KEY, JSON.stringify(state)); }
    catch (err) { console.warn('[PF debug] Failed to save plot state:', err); }
  }

  function load_plot_state() {
    if (get_debug_level() < 3) return null;
    try {
      const raw = localStorage.getItem(PLOT_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { console.warn('[PF debug] Failed to load plot state:', err); return null; }
  }

  // ── Clear all persisted data (NOT the level) ─────────────
  async function clear_debug_cache() {
    localStorage.removeItem(META_STATE_KEY);
    localStorage.removeItem(PLOT_STATE_KEY);
    try {
      const db = await open_db();
      const tx  = db.transaction(FILES_STORE, 'readwrite');
      tx.objectStore(FILES_STORE).clear();
      await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = (e) => fail(e.target.error); });
    } catch (err) { console.warn('[PF debug] Failed to clear file cache:', err); }
  }

  // ── Console logging (Level 1+) ────────────────────────────
  function setup_logging() {
    const level = get_debug_level();
    if (level < 1) return;

    const pflog = (tag, ...args) =>
      console.log(`%c[PF L${level} ${tag}]`, 'color:#2563eb;font-weight:700', ...args);

    // Generic button clicks
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) pflog('click', btn.id || btn.textContent.trim().slice(0, 40));
    }, true);

    // Select, checkbox, and number input changes
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (el.tagName === 'SELECT') {
        pflog('select', el.id || el.name || '?', '→', el.value);
      } else if (el.type === 'checkbox') {
        pflog('checkbox', el.id || el.name || el.dataset.fileId || '?', '→', el.checked);
      } else if (el.type === 'number') {
        pflog('number', el.id || '?', '→', el.value);
      }
    }, true);

    // Annotation edits
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (el.closest('#file_table') && el.dataset.fileId) {
        pflog('annotation', el.dataset.field, ':', el.dataset.fileId.slice(0, 8) + '…', '→', `"${el.value}"`);
      }
    }, true);

    // App-level custom events dispatched from the main scripts
    document.addEventListener('pf-files-loaded',  (e) => pflog('files_loaded',  e.detail));
    document.addEventListener('pf-plot-started',  (e) => pflog('plot_started',  e.detail));
    document.addEventListener('pf-plot-complete', (e) => pflog('plot_complete', e.detail));
    document.addEventListener('pf-stats-complete',(e) => pflog('stats_complete',e.detail));
    document.addEventListener('fcs-selection-change', () => pflog('selection_change'));
    document.addEventListener('fcs-channel-change',   () =>
      pflog('channel_change', document.querySelector('#channel_select')?.value)
    );

    if (level >= 2) {
      document.addEventListener('pf-meta-restored', (e) => pflog('meta_restored', e.detail));
    }
    if (level >= 3) {
      document.addEventListener('pf-plot-state-restored', (e) => pflog('plot_state_restored', e.detail));

      // Auto-save plot state whenever any plot control changes (Level 3 only).
      const read_plot_state_from_dom = () => {
        if (document.querySelector('#plot_panel')?.hidden) return null;
        const g = (id) => document.querySelector(`#${id}`);
        return {
          channel:           g('channel_select')?.value || '',
          color_by:          g('plot_color_by')?.value  || 'file',
          bins:              parseInt(g('plot_bins')?.value || '512', 10),
          debris_correction: !!(g('plot_debris_correction')?.checked),
          doublet_correction:!!(g('plot_doublet_correction')?.checked),
          threshold_toggle:  !!(g('plot_threshold_toggle')?.checked),
        };
      };

      const save_plot_from_dom = () => {
        const state = read_plot_state_from_dom();
        if (state) save_plot_state(state);
      };

      ['plot_color_by', 'plot_bins', 'plot_debris_correction',
       'plot_doublet_correction', 'plot_threshold_toggle'].forEach((id) => {
        document.querySelector(`#${id}`)?.addEventListener('change', save_plot_from_dom);
      });

      // Also save after each completed plot render.
      document.addEventListener('pf-plot-complete', save_plot_from_dom);
    }

    pflog('init', `PhaseFinder debug Level ${level} active`);
  }

  // ── Debug level badge ─────────────────────────────────────
  function setup_badge() {
    const level = get_debug_level();
    if (level < 1) return;
    const badge = document.querySelector('#debug_level_badge');
    if (!badge) return;
    badge.textContent = `Debug Level ${level}`;
    badge.hidden = false;
  }

  // ── Public API ────────────────────────────────────────────
  window.PhaseFinderDebug = {
    isDebugMode:        is_debug_mode,
    getLevel:           get_debug_level,
    saveFilesToCache:   save_files_to_cache,
    loadFilesFromCache: load_files_from_cache,
    clearDebugCache:    clear_debug_cache,
    saveMetaState:      save_meta_state,
    loadMetaState:      load_meta_state,
    savePlotState:      save_plot_state,
    loadPlotState:      load_plot_state,
  };

  setup_logging();
  setup_badge();
})();
