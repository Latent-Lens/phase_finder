// Writes each plotted sample's active cell-cycle fit fractions (G1/S/G2-M) into
// the metadata table as read-only columns -- one 3-column group per model in
// use. Column keys are "cellCycleFit:<modelId>:<phase>"; table_render.js
// recognises that prefix and renders a per-model header block (model name over
// G1/S/G2-M). Only plotted samples with an active fit contribute a value
// (plotted-data-only rule); every other row is blank. Columns are rebuilt from
// scratch on each update, so a cleared/refit result stays in sync.
//
// active_result() reads a sample's active fit; peak_region_columns() builds the
// accepted-region columns; format_bound() formats a boundary value;
// update_cell_cycle_fraction_columns() rebuilds every column and re-renders when
// anything changed; init_cell_cycle_columns() wires the refresh events.

import { plottable_rows } from "../plotting/data.js";
import { get_state, get_active_model_result } from "../analysis/pipeline_state.js";
import { get_file_table } from "../state/app_state.js";
import { render_file_table } from "./table_render.js";
import {
  CELL_CYCLE_COLUMN_PREFIX,
  CELL_CYCLE_PHASES,
  PEAK_REGION_COLUMNS,
  format_cell_cycle_value,
} from "../data_structs/derived_columns.js";

/*

Purpose:
	Returns a sample's active (selected) cell-cycle fit result, or null when it has
	none.

Input:
	name [string]: the sample name

Output:
	result [object|null]: the active normalized fit result, or null

*/
function active_result(name) {
  return get_active_model_result(get_state(name));
}

/*

Purpose:
	Formats a peak-region boundary value to match the 2-decimal rounding the Identify
	Peaks inputs display (so the table and sidebar never disagree), with Number()
	dropping the trailing zeros toFixed adds.

Input:
	value [number]: the boundary value

Output:
	text [string]: the formatted value, or "" when not finite

*/
function format_bound(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(2))) : "";
}

/*

Purpose:
	Rebuilds the four accepted-peak-region columns (G1/G2-M left and right) from
	the plotted samples' current regions. Blank for any row without accepted
	regions, and the whole group is dropped when no sample has any.

Input:
	names [array]: the frame's row names, in row order

Output:
	desired [Map]: column label -> per-row string values

*/
function peak_region_columns(names) {
  const regions_by_name = new Map();
  for (const row of plottable_rows()) {
    const regions = get_state(row.name)?.modeling?.peakSelection?.regions;
    if (regions) regions_by_name.set(row.name, regions);
  }

  const desired = new Map();
  if (!regions_by_name.size) return desired;
  for (const column of PEAK_REGION_COLUMNS) {
    desired.set(column.label, names.map((name) => {
      const regions = regions_by_name.get(name);
      return regions ? format_bound(regions[column.region]?.[column.edge]) : "";
    }));
  }
  return desired;
}

/*

Purpose:
	Rebuilds the cellCycleFit:* columns from the plotted samples' active fits and the
	accepted-peak-region columns, then re-renders the metadata table -- but only when
	the resulting columns/values actually differ, so it's cheap to call on selection
	changes and after fits.

Input:
	(none)

Output:
	(none) [void]: rewrites the metadata-table columns and re-renders

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
        return format_cell_cycle_value(
          Number.isFinite(fraction) ? `${(fraction * 100).toFixed(1)}%` : null,
          "",
        );
      });
      desired.set(`${CELL_CYCLE_COLUMN_PREFIX}${modelId}:${phase}`, values);
    }
  }
  for (const [label, values] of peak_region_columns(names)) desired.set(label, values);

  const region_labels = new Set(PEAK_REGION_COLUMNS.map((column) => column.label));
  const current = frame.columns.filter(
    (col) => col.startsWith(CELL_CYCLE_COLUMN_PREFIX) || region_labels.has(col),
  );
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

/*

Purpose:
	Refreshes the columns whenever fits change (cell-cycle-fit-changed, dispatched by
	the fit / recalc / undo / restore paths), the plotted set changes
	(fcs-selection-change) so un-plotting a sample blanks its column, or regions
	change (cell-cycle-regions-changed).

Input:
	(none)

Output:
	(none) [void]: registers the document event listeners

*/
export function init_cell_cycle_columns() {
  document.addEventListener("cell-cycle-fit-changed", update_cell_cycle_fraction_columns);
  document.addEventListener("fcs-selection-change", update_cell_cycle_fraction_columns);
  // The peak-region columns change on detect/edit/accept/apply-to-all, which
  // are region events rather than fit events.
  document.addEventListener("cell-cycle-regions-changed", update_cell_cycle_fraction_columns);
}
