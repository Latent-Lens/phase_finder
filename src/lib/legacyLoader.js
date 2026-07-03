const LEGACY_SCRIPTS = [
  "/js/fcs-parser.js",
  "/js/hover_text.js",
  "/js/ui_controls.js",
  "/js/main.js",
  "/js/djf_gpt.js",
  "/js/plotting.js",
  "/js/analysis.js",
  "/js/summary_stats.js",
  "/js/panel_resize.js",
  "/js/opfs_store.js",
  "/js/session.js",
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}

export async function loadLegacyScripts() {
  if (window.__phaseFinderLegacyLoaded) return;
  window.__phaseFinderLegacyLoaded = true;

  for (const src of LEGACY_SCRIPTS) {
    await loadScript(src);
  }
}
