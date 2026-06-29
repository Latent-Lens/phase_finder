window.PhaseFinderHoverText = Object.freeze({
  reloadLogo: "Reload PhaseFinder",
  restart: "Reload the page and start over",
  sidebarCollapse: "Collapse sidebar",
  sidebarExpand: "Expand sidebar",
  uploadFiles: "Drop FCS files here or click to choose files from disk",
  selectChannel: "Select channel",
  plotChannelEventsRequirements: "Load FCS files, select a channel, and check at least one file row first.",
  plotChannelEvents: "Plot channel events",
  modeling: "Start Modeling (DJF)",
  cellCycleModeling: "Run Dean-Jett-Fox cell cycle modeling on the plotted channel",
  cellCycleModelingDisabled: "Plot a channel first to enable cell cycle modeling",
  calculateStats: "Calculate statistics for any channel across all loaded files",
  tableCollapse: "Collapse table",
  tableExpand: "Expand table",
  sortAscending: "Sort ascending",
  sortDescending: "Sort descending",
  selectAllDisplayedFiles: "Select all displayed files",
  filterBy(label) {
    return "Filter by " + label;
  },
  debrisHelp: `Removes low/high DNA-content debris before plotting and fitting.

Method: build a 256-bin positive DNA-area histogram over the 0.2-99.8 percentile range, detect G1/G2 peaks, estimate each peak sigma from FWHM, then keep events within max(q0.1%, G1 - 4 sigma1, 0.45*G1) and min(q99.9%, G2 + 4 sigma2, 2.65*G1).`,
  doubletHelp: `Removes aggregate/doublet-like events before plotting and fitting when matching DNA-H and/or DNA-W channels are available.

Method: on eligible events, compute log(A/H) for height and/or log(W) for width, estimate a robust median and MAD sigma, and keep singlet-like events within median +/- 4*MAD sigma.`,
  peakThresholdHelp: `Shows a draggable grey line marking the minimum event count for a histogram peak to be counted when seeding the Dean-Jett-Fox fit.

Drag it up to ignore small/noisy peaks or down to include more; release to re-detect peaks and refit.`,
});

window.PhaseFinderTooltips = {
  text(key, ...args) {
    const value = window.PhaseFinderHoverText[key];
    if (typeof value === "function") {
      return value(...args);
    }
    return value || "";
  },
  set_quick_tooltip(element, key, ...args) {
    if (element) {
      element.dataset.tooltip = this.text(key, ...args);
    }
  },
  set_native_title(element, key, ...args) {
    if (element) {
      element.title = this.text(key, ...args);
    }
  },
  apply_static(root = document) {
    root.querySelectorAll("[data-tooltip-key]").forEach((element) => {
      this.set_quick_tooltip(element, element.dataset.tooltipKey);
    });
    root.querySelectorAll("[data-title-key]").forEach((element) => {
      this.set_native_title(element, element.dataset.titleKey);
    });
  },
};
