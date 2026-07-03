window.PhaseFinderHoverText = Object.freeze({
  reloadLogo: "Reload PhaseFinder",
  help: "Open the PhaseFinder help and feature guide in a new tab",
  saveSession: "Save the current session (files, annotations, settings) to a TOML file",
  loadSession: "Load a previously saved session from a TOML file",
  sidebarCollapse: "Collapse sidebar",
  sidebarExpand: "Expand sidebar",
  uploadFiles: "Drop FCS files here or click to choose files from disk",
  selectChannel: "Select channel",
  plotChannelEventsRequirements: "Load FCS files and select a channel first. Curves are shown only for checked rows.",
  plotChannelEvents: "Plot channel events",
  modeling: "Start Modeling (DJF)",
  cellCycleModeling: "Run Dean-Jett-Fox cell cycle modeling on the plotted channel",
  cellCycleModelingDisabled: "Plot a channel first to enable cell cycle modeling",
  calculateStats: "Calculate statistics for any channel across all loaded files",
  configureMetadata: "Configure metadata columns by splitting FCS filenames",
  exportTable: "Export the visible metadata table as a TSV file",
  tableCollapse: "Collapse table",
  tableExpand: "Expand table",
  plotCollapse: "Collapse plot",
  plotExpand: "Expand plot",
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

// ---------------------------------------------------------------------------
// JS-positioned tooltip — stays fully within the viewport by measuring the
// tooltip box before committing to a position.
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  const GAP        = 8;   // px between anchor edge and tooltip box
  const DELAY      = 80;  // ms before showing (skipped when already visible)
  const VP_PAD     = 6;   // min px from any viewport edge
  const ARROW_HALF = 4.5; // half of the 9 px arrow square

  // Create and attach the shared tooltip element.
  const tip = document.createElement('div');
  tip.id = 'pf_tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);

  let timer        = null;
  let active       = null; // the currently hovered/focused .quick_tooltip element

  function show(anchor) {
    const text = anchor.dataset.tooltip;
    if (!text) return;

    tip.textContent = text;
    tip.removeAttribute('data-placement');
    tip.style.removeProperty('--pf-arrow-offset');

    // Measure while hidden — visibility:hidden keeps layout intact so
    // offsetWidth/offsetHeight return the real rendered dimensions.
    const ar  = anchor.getBoundingClientRect();
    const tw  = tip.offsetWidth;
    const th  = tip.offsetHeight;
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;

    const in_sidebar = !!anchor.closest('.sidebar');

    let tx, ty, placement, arrow_pct;

    if (in_sidebar) {
      // Sidebar tooltips open to the right of the anchor.
      placement = 'right';
      tx = ar.right + GAP;
      ty = ar.top + ar.height / 2 - th / 2;
      // Clamp vertically.
      ty = Math.max(VP_PAD, Math.min(ty, vh - th - VP_PAD));
      // Arrow tracks the anchor's vertical center within the tooltip.
      arrow_pct = ((ar.top + ar.height / 2) - ty) / th * 100;
    } else {
      // Default: open above the anchor; flip below if it would clip the top.
      placement = ar.top - th - GAP < VP_PAD ? 'below' : 'above';
      tx = ar.left + ar.width / 2 - tw / 2;
      ty = placement === 'above'
        ? ar.top  - th - GAP
        : ar.bottom + GAP;
      // Clamp horizontally.
      tx = Math.max(VP_PAD, Math.min(tx, vw - tw - VP_PAD));
      // Arrow tracks the anchor's horizontal center within the tooltip.
      arrow_pct = ((ar.left + ar.width / 2) - tx) / tw * 100;
    }

    // Keep the arrow at least 8 % from each edge of the tooltip face.
    arrow_pct = Math.max(8, Math.min(92, arrow_pct));

    tip.style.left = `${Math.round(tx)}px`;
    tip.style.top  = `${Math.round(ty)}px`;
    tip.style.setProperty('--pf-arrow-offset', `${arrow_pct.toFixed(1)}%`);
    tip.dataset.placement = placement;
    tip.classList.add('pf_tip_visible');
  }

  function hide() {
    clearTimeout(timer);
    timer  = null;
    active = null;
    tip.classList.remove('pf_tip_visible');
  }

  // ── Mouse events (delegated) ──────────────────────────────────────────────

  document.addEventListener('mouseover', (e) => {
    const anchor = e.target.closest('.quick_tooltip');
    if (anchor === active) return;
    const was_visible = tip.classList.contains('pf_tip_visible');
    hide();
    if (!anchor || !anchor.dataset.tooltip) return;
    active = anchor;
    if (was_visible) {
      // Already showing a tooltip — switch instantly, no delay.
      show(anchor);
    } else {
      timer = setTimeout(() => { if (active === anchor) show(anchor); }, DELAY);
    }
  });

  // ── Keyboard / focus events ───────────────────────────────────────────────

  document.addEventListener('focusin', (e) => {
    const anchor = e.target.closest('.quick_tooltip');
    if (!anchor || !anchor.dataset.tooltip || anchor === active) return;
    hide();
    active = anchor;
    show(anchor);
  });

  document.addEventListener('focusout', (e) => {
    if (e.target.closest('.quick_tooltip') === active) hide();
  });

  // ── Hide on scroll / resize so the tooltip doesn't go stale ─────────────

  window.addEventListener('scroll', hide, { passive: true, capture: true });
  window.addEventListener('resize', hide, { passive: true });
})();
