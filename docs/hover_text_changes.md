# hover_text.js Change Verification Checklist

Changes applied to [hover_text.js](../js/ui/hover_text.js).

The first table records the earlier wording pass for provenance. Its retired
modeling entries and superseded QC descriptions are corrected in the
mathematical/runtime audit below.

| Variable | Old Value | New Value |
|---|---|---|
| `reloadLogo` | `"Reload PhaseFinder"` | *(No change)* |
| `help` | `"Open the PhaseFinder help and feature guide in a new tab"` | `"Open the PhaseFinder help and user guide in a new tab."` |
| `saveSession` | `"Save the current session (files, annotations, settings) to a TOML file"` | `"Save the current session (files, annotations, settings) to a file for future reload."` |
| `loadSession` | `"Load a previously saved session from a TOML file"` | `"Load a previously saved session from a file."` |
| `resetSession` | `"Deletes the current session. All loaded files will be unloaded, and any results, plots and metadata will be removed, enabling a clean start."` | `"Deletes the current session. All loaded files will be unloaded, and any results, plots, and metadata will be removed, enabling a clean start."` |
| `sidebarCollapse` | `"Collapse sidebar"` | `"Collapse the sidebar"` |
| `sidebarExpand` | `"Expand sidebar"` | `"Expand the sidebar"` |
| `uploadFiles` | `"Drop FCS files here or click to choose files from disk"` | `"Drop FCS files here, or click to choose files from disk."` |
| `selectChannel` | `"Select channel"` | `"Select a channel"` |
| `plotChannelEventsRequirements` | `"Load FCS files and select a channel first. Curves are shown only for checked rows."` | *(No change)* |
| `plotChannelEvents` | `"Plot channel events"` | `"Plot events for the selected channel"` |
| `modeling` | `"Cell Cycle Modeling"` | *(No change)* |
| `cellCycleModeling` | `"Open Cell Cycle Modeling — moves the QC and DJF pipeline controls into the sidebar"` | `"Open Cell Cycle Modeling: moves the QC and cell cycle modeling controls into the sidebar"` |
| `cellCycleModelingDisabled` | `"Plot a channel first to open Cell Cycle Modeling"` | `"Plot event data for a channel first to enable Cell Cycle Modeling"` |
| `backToFiles` | `"Back to files and channel selection"` | `"Back to the file list and channel selection"` |
| `calculateStats` | `"Calculate statistics for any channel across all loaded files"` | `"Calculate statistics for any selected channel across all loaded files."` |
| `addMetadataColumn` | `"Add a blank editable metadata column to the table"` | `"Add a new, editable column to the metadata table."` |
| `removeMetadataColumn` | `"Remove columns: click column headers to select, then confirm"` | `"Remove columns: select column(s) to remove, then confirm"` |
| `importMetadataTable` | `"Import metadata from a CSV or TSV file and match it to loaded FCS files"` | `"Import metadata from a CSV or TSV file and map it to loaded FCS files"` |
| `configureMetadata` | `"Configure metadata columns by splitting FCS filenames"` | `"Auto-populate columns in the metadata table by splitting FCS filenames into parts."` |
| `exportTable` | `"Export the visible metadata table as a TSV file"` | `"Export the current metadata table as a TSV file."` |
| `tableCollapse` | `"Collapse table"` | `"Collapse the metadata table."` |
| `tableExpand` | `"Expand table"` | `"Expand the metadata table."` |
| `plotCollapse` | `"Collapse plot"` | `"Collapse the plot"` |
| `plotExpand` | `"Expand plot"` | `"Expand the plot"` |
| `sortAscending` | `"Sort ascending"` | `"Sort column ascending"` |
| `sortDescending` | `"Sort descending"` | `"Sort column descending"` |
| `selectAllDisplayedFiles` | `"Select all displayed files"` | `"Select all files"` |
| `filterBy(label)` | `"Filter by " + label` | *(No change)* |
| `debrisHelp` (line 1) | `"Removes low/high DNA-content debris before plotting and fitting."` | *(No change)* |
| `debrisHelp` (Method) | `"Method: build a 256-bin positive DNA-area histogram over the 0.2-99.8 percentile range, detect G1/G2 peaks, estimate each peak sigma from FWHM, then keep events within max(q0.1%, G1 - 4 sigma1, 0.45*G1) and min(q99.9%, G2 + 4 sigma2, 2.65*G1)."` | `"Method: Build a 256-bin positive-value DNA-area histogram over the 0.2–99.8 percentile range, detect G1/G2 peaks, estimate each peak σ from FWHM, then keep events within max(q0.1%, G1 − 4σ₁, 0.45·G1) and min(q99.9%, G2 + 4σ₂, 2.65·G1)."` |
| `doubletHelp` (line 1) | `"Removes aggregate/doublet-like events before plotting and fitting when matching DNA-H and/or DNA-W channels are available."` | *(No change)* |
| `doubletHelp` (Method) | `"Method: on eligible events, compute log(A/H) for height and/or log(W) for width, estimate a robust median and MAD sigma, and keep singlet-like events within median +/- 4*MAD sigma."` | `"Method: For eligible events, compute log(Area/Height) and/or log(Area/Width) to estimate a robust median and MAD σ, and keep singlet-like events within median ± 4·MAD * σ."` |
| `peakThresholdHelp` (line 1) | `"Shows a draggable grey line marking the minimum event count for a histogram peak to be counted when seeding the Dean-Jett-Fox fit."` | `"Enables a draggable grey line indicating the minimum event count required for a histogram peak to be considered in cell cycle modeling."` |
| `peakThresholdHelp` (line 3) | `"Drag it up to ignore small/noisy peaks or down to include more; release to re-detect peaks and refit."` | `"Drag the line up to ignore small/noisy peaks or down to include more. Release it to re-detect peaks and refit."` |
| `qcStructural` | `"1. Structural QC: Removes events with invalid readings (non-finite or negative) and off-scale values pinned at a channel's upper range limit, before any gating."` | `"1. Structural QC: Removes events with invalid readings (infinite or negative) and off-scale values clipped at a channel's upper range limit, before any gating."` |
| `qcTime` | `"2. Time QC: Bins events by acquisition time and drops those in unstable intervals, comparing each window's event rate against the run's robust baseline to catch clogs and fluidics disruptions."` | `"2. Time QC: Bins events by acquisition time and drops those in unstable intervals, comparing each time window's event rate against the run's robust baseline to catch clogs and fluidic disruptions."` |
| `qcCellGate` | `"3. Cell gate: Fits the main cell population in Forward-Scatter-Area vs Side-Scatter-Area (2-D Gaussian) and removes debris and off-cloud events outside it."` | `"3. Cell gate: Fits the main cell population in Forward-Scatter-Area vs Side-Scatter-Area (2D Gaussian) and removes debris and off-cloud events outside the gate."` |
| `qcSingletGate` | `"4. Singlet gate: Compares DNA area against DNA height (or width) along a fitted ridge and keeps single cells, removing doublets and aggregates."` | *(No change)* |
| `qcRunAll` | `"Apply all four Pre-modeling QC filters (Structural, Time, Cell gate, Singlet gate). Click again to clear them."` | `"Apply all four pre-modeling QC filters (Structural, Time, Cell gate, Singlet gate). Click again to clear them."` |

## Mathematical and runtime correction audit

| Variable | Disposition | Verified current behavior |
|---|---|---|
| `debrisHelp` | Removed | The key had no runtime consumer and described a retired percentile-tail filter. Current Stage 7 models optional debris rather than deleting events with that rule. For historical reference, the retired upper bound was `min(q99.9%, max(G2 + 4σ₂, 2.65·G1))`; the earlier tooltip incorrectly omitted the inner `max`. |
| `doubletHelp` | Removed | The key had no runtime consumer and described a retired log-ratio gate. The historical width statistic was `log(W)`, not `log(A/W)`, and its robust cutoff was `|r − median(r)| ≤ 4·1.4826·MAD(r)`. Current Stage 3 instead uses the robust ridge documented by `qcSingletGate`. |
| `peakThresholdHelp` | Removed | The key had no runtime consumer. PhaseFinder currently has no draggable peak-threshold line that re-detects peaks and refits the model. |
| `qcStructural` | Corrected | Before other gates, rejects non-finite or negative readings in loaded DNA-A/H/W, FSC-A, SSC-A, and Time channels. DNA/scatter values at or above a configured PnR limit are also rejected; zero is valid, and Time has no upper-PnR check. |
| `qcTime` | Corrected | Unwraps timer rollovers, splits unrelated backward jumps into acquisition segments, and forms roughly 500-event bins. For event rate and DNA-A/FSC-A/SSC-A medians and IQRs, it computes `z = (value − across-bin median) / (1.4826·MAD)` and by default rejects a bin if any available `|z| > 4`. When MAD is effectively zero, matching values score `0` and differences are treated as infinite outliers. |
| `qcCellGate` | Corrected | Fits a two-component full-covariance GMM, chooses a substantial component primarily by mean FSC-A, and uses the selected component's Mahalanobis ellipse. The default `d² = (x − μ)ᵀΣ⁻¹(x − μ) ≤ 5.991` is the nominal 95% contour for a bivariate Gaussian. The ellipse is manually adjustable; exclusions are described as off-cloud candidates, not proven debris. |
| `qcSingletGate` | Corrected | Fits an iteratively robust PCA ridge to raw DNA-A versus DNA-H, falling back to DNA-W, and by default keeps `|d − median(d)| ≤ 5·MAD(d)`. Off-ridge events are described as doublet/aggregate candidates rather than confirmed biological identities. |
| `qcRunAll` | Verified | Toggles all four pre-modeling QC stages on, or clears all four when they are already selected. |
