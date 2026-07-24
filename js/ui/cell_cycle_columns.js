// Writes each plotted sample's active cell-cycle fit fractions (G1/S/G2-M) into
// the metadata table as read-only columns -- one 3-column group per model in
// use. Column keys are "cellCycleFit:<modelId>:<phase>"; table_render.js
// recognises that prefix and renders a per-model header block (model name over
// G1/S/G2-M). Only plotted samples with an active fit contribute a value
// (plotted-data-only rule); every other row is blank. Columns are rebuilt from
// scratch on each update, so a cleared/refit result stays in sync.

import { plottable_rows } from "../plotting/data.js";
import { get_state } from "../analysis/pipeline_state.js";
import { get_file_table } from "../state/app_state.js";
import { render_file_table } from "./table_render.js";
import { CELL_CYCLE_COLUMN_PREFIX, CELL_CYCLE_PHASES } from "../data_structs/derived_columns.js";

function active_result(name) {
  const modeling = get_state(name)?.modeling;
  if (!modeling?.activeResultKey) return null;
  return modeling.resultsByKey[modeling.activeResultKey] || null;
}

/**
 * Rebuilds the cellCycleFit:* columns from the plotted samples' active fits and
 * re-renders the metadata table -- but only when the resulting columns/values
 * actually differ, so this is cheap to call on selection changes and after fits.
 */
export function update_cell_cycle_fraction_columns() {
  const frame = get_file_table();
  if (!frame) return;

  // Plotted samples with an active fit: name -> normalized result.
  const byName = new Map();
  const modelsInUse = [];
  for (const row of plottable_rows()) {
    const result = active_result(row.name);
    if (result?.phaseFractions && result.modelId) {
      byName.set(row.name, result);
      if (!modelsInUse.includes(result.modelId)) modelsInUse.push(result.modelId);
    }
  }

  const names = [...frame.col("name")];
  // Desired column name -> per-row string values (blank unless this row's active
  // fit used that model).
  const desired = new Map();
  for (const modelId of modelsInUse) {
    for (const phase of CELL_CYCLE_PHASES) {
      const values = names.map((name) => {
        const result = byName.get(name);
        const fraction = result && result.modelId === modelId ? result.phaseFractions[phase] : null;
        return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(1)}%` : "";
      });
      desired.set(`${CELL_CYCLE_COLUMN_PREFIX}${modelId}:${phase}`, values);
    }
  }

  const current = frame.columns.filter((col) => col.startsWith(CELL_CYCLE_COLUMN_PREFIX));
  const same_keys = current.length === desired.size && current.every((col) => desired.has(col));
  const unchanged = same_keys && [...desired].every(([col, values]) => {
    const existing = frame.col(col);
    return existing.length === values.length && existing.every((value, index) => value === values[index]);
  });
  if (unchanged) return;

  for (const col of current) frame.dropCol(col);
  for (const [col, values] of desired) frame.setCol(col, values);
  render_file_table();
}

/**
 * Refresh the columns whenever fits change (cell-cycle-fit-changed, dispatched
 * by the fit / recalc / undo / restore paths) and whenever the plotted set
 * changes (fcs-selection-change) so un-plotting a sample blanks its column.
 */
export function init_cell_cycle_columns() {
  document.addEventListener("cell-cycle-fit-changed", update_cell_cycle_fraction_columns);
  document.addEventListener("fcs-selection-change", update_cell_cycle_fraction_columns);
}
