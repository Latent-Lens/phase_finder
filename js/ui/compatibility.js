export const BROWSER_BASELINE = Object.freeze({
  Chrome: 111,
  Edge: 111,
  Firefox: 121,
  Safari: 16.2,
  "Chrome Android": 111,
  "iOS Safari": 16.2,
});

export function browser_capabilities(scope = globalThis) {
  const css = scope.CSS;
  const required = {
    workers: typeof scope.Worker === "function",
    webAssembly: typeof scope.WebAssembly === "object",
    indexedDB: "indexedDB" in scope,
    cssGrid: Boolean(css?.supports?.("display", "grid")),
    inert: "inert" in scope.HTMLElement.prototype,
  };
  const optional = {
    opfs: typeof scope.navigator?.storage?.getDirectory === "function",
    folderPicker: typeof scope.showDirectoryPicker === "function",
    colorMix: Boolean(css?.supports?.("color", "color-mix(in srgb, black 50%, white)")),
    hasSelector: Boolean(css?.supports?.("selector(:has(*))")),
    nativeStructuredClone: typeof scope.structuredClone === "function",
  };
  return {
    required,
    optional,
    missingRequired: Object.keys(required).filter((key) => !required[key]),
    missingOptional: Object.keys(optional).filter((key) => !optional[key]),
  };
}

export function init_compatibility() {
  const report = browser_capabilities();
  globalThis.PhaseFinderCompatibility = { baseline: BROWSER_BASELINE, ...report };
  if (!report.missingRequired.length) return report;
  const warning = document.createElement("p");
  warning.className = "browser_compatibility_warning";
  warning.setAttribute("role", "alert");
  warning.textContent = `This browser is missing required features (${report.missingRequired.join(", ")}). Use a supported current Chrome, Edge, Firefox, or Safari release.`;
  document.querySelector(".page_header")?.appendChild(warning);
  return report;
}
