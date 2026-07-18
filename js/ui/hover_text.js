// Central tooltip text registry and tooltip runtime. This module defines the
// strings used by quick tooltips, native titles, help icons, and control
// descriptions throughout the app. It exports HoverText for static text and
// Tooltips for applying and rendering tooltips, plus init_tooltips() which the
// entry bootstrap calls once to install the shared tooltip element and its
// mouse/focus listeners. Other modules only reference tooltip keys instead of
// duplicating text.

const HoverText = Object.freeze({
  reloadLogo: "Reload PhaseFinder",
  help: "Open the PhaseFinder help and user guide in a new tab.",
  saveSession: "Save the current session (files, annotations, settings) to a file for future reload.",
  loadSession: "Load a previously saved session from a file.",
  resetSession: "Deletes the current session. All loaded files will be unloaded, and any results, plots, and metadata will be removed, enabling a clean start.",
  sidebarCollapse: "Collapse the sidebar",
  sidebarExpand: "Expand the sidebar",
  uploadFiles: "Drop FCS files here, or click to choose files from disk.",
  selectChannel: "Select a channel",
  plotChannelEventsRequirements: "Load FCS files and select a channel first. Curves are shown only for checked rows.",
  plotChannelEvents: "Plot events for the selected channel",
  modeling: "Cell Cycle Modeling",
  cellCycleModeling: "Open Cell Cycle Modeling: moves the QC and cell cycle modeling controls into the sidebar",
  cellCycleModelingDisabled: "Plot event data for a channel first to enable Cell Cycle Modeling",
  backToFiles: "Back to the file list and channel selection",
  calculateStats: "Calculate statistics for any selected channel across all loaded files.",
  addMetadataColumn: "Add a new, editable column to the metadata table.",
  removeMetadataColumn: "Remove columns: select column(s) to remove, then confirm",
  importMetadataTable: "Import metadata from a CSV or TSV file and map it to loaded FCS files",
  configureMetadata: "Auto-populate columns in the metadata table by splitting FCS filenames into parts.",
  exportTable: "Export the current metadata table as a TSV file.",
  tableCollapse: "Collapse the metadata table.",
  tableExpand: "Expand the metadata table.",
  plotCollapse: "Collapse the plot",
  plotExpand: "Expand the plot",
  sortAscending: "Sort column ascending",
  sortDescending: "Sort column descending",
  selectAllDisplayedFiles: "Select all files",
  filterBy(label) {
    return "Filter by " + label;
  },
  qcStructural: `1. Structural QC: Before other gates, rejects events with non-finite (NaN or infinite) or negative readings in loaded DNA-A, DNA-H, DNA-W, FSC-A, SSC-A, or Time channels. It also rejects DNA/scatter values at or above a configured PnR limit; zero remains valid, and no upper-PnR limit is applied to Time.`,
  qcTime: `2. Time QC: Unwraps timer rollovers, splits unrelated backward jumps into acquisition segments, and forms roughly 500-event bins within each segment. For event rate and DNA-A, FSC-A, and SSC-A medians and IQRs, it calculates z = (value − across-bin median) / (1.4826 · MAD) and, by default, rejects a bin when any available |z| > 4. When MAD is effectively zero, matches score 0 and differences are treated as infinite outliers.`,
  qcCellGate: `3. Cell gate: Fits a two-component, full-covariance Gaussian mixture to FSC-A and SSC-A, then selects a substantial component with the highest mean FSC-A (using SSC-A to break ties). By default it keeps events with squared Mahalanobis distance d² = (x − μ)ᵀΣ⁻¹(x − μ) ≤ 5.991, the nominal 95% ellipse for a 2D Gaussian. The ellipse can be adjusted manually; excluded events are off-cloud candidates, not proven debris.`,
  qcSingletGate: `4. Singlet gate: Fits an iteratively robust PCA ridge to raw DNA-A versus DNA-H, falling back to DNA-W. For signed orthogonal distances d, it keeps |d − median(d)| ≤ 5 · MAD(d) by default. Off-ridge events are doublet/aggregate candidates; the gate does not prove their biological identity.`,
  qcRunAll: `Apply all four pre-modeling QC filters (Structural, Time, Cell gate, Singlet gate). Click again to clear them.`,
});

export { HoverText };

export const Tooltips = {
  text(key, ...args) {
    const value = HoverText[key];
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
// tooltip box before committing to a position. Installed once by the entry
// bootstrap via init_tooltips().
// ---------------------------------------------------------------------------
export function init_tooltips() {
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
}
