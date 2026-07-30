// Shared definitions for the DJF pipeline's derived metadata-table columns.
// The pipeline UI writes these columns; the table renderer groups them under
// section headers. Keeping the names and grouping here keeps the two in sync.

// Leading raw event-count column. Its header is split across the two header
// rows ("Total number" over "of events"); the frame key is the full name.
export const TOTAL_EVENTS_COLUMN = "Total number of events";
export const TOTAL_EVENTS_HEADER = { top: "Total number", bottom: "of events" };
export const QC_STATUS_COLUMN = "QC status";
export const CELL_CYCLE_STATUS_COLUMN = "Cell-cycle fit status";

// Per-filter event-loss columns, ordered by the gating filter that produces them
// (filter index 0..3). Written as each filter completes.
export const QC_LOST_COLUMNS = [
  { key: "structural", label: "Structural lost" },
  { key: "timeQC", label: "Time QC lost" },
  { key: "scatter", label: "Scatter lost" },
  { key: "singlet", label: "Singlet lost" },
];

// The accepted G1 and G2/M peak-region bounds for each plotted sample -- the
// same four numbers the Identify Peaks panel edits. Written to the table so a
// run's region choices are visible (and exportable) next to the fit results
// they produced, rather than only being readable one sample at a time.
export const PEAK_REGION_COLUMNS = [
  { key: "g1_left", region: "g1", edge: "left", label: "G1 Left" },
  { key: "g1_right", region: "g1", edge: "right", label: "G1 Right" },
  { key: "g2_left", region: "g2", edge: "left", label: "G2/M Left" },
  { key: "g2_right", region: "g2", edge: "right", label: "G2/M Right" },
];

// Section headers rendered above the derived columns, each centered over its
// member columns (only the members present in the frame are shown). Cell-cycle
// fit fractions are NOT here -- they are dynamic, one 3-column group per model
// in use, keyed by CELL_CYCLE_COLUMN_PREFIX (see below and cell_cycle_columns.js).
export const DERIVED_COLUMN_GROUPS = [
  { label: "Quality Control", columns: [QC_STATUS_COLUMN, ...QC_LOST_COLUMNS.map((column) => column.label)] },
  { label: "Peak Regions", columns: PEAK_REGION_COLUMNS.map((column) => column.label) },
  { label: "Cell-cycle Modeling", columns: [CELL_CYCLE_STATUS_COLUMN] },
];

// Per-model cell-cycle fit fraction columns. Frame keys are
// "cellCycleFit:<modelId>:<phase>" (phase in CELL_CYCLE_PHASES). table_render.js
// recognises the prefix and groups them by model (model label over G1/S/G2-M).
export const CELL_CYCLE_COLUMN_PREFIX = "cellCycleFit:";
export const CELL_CYCLE_PHASES = ["g1", "s", "g2"];
export const CELL_CYCLE_PHASE_LABELS = { g1: "G1", s: "S", g2: "G2/M" };
export const CELL_CYCLE_MODEL_LABELS = {
  auto_dj_djf: "Automatic",
  dean_jett: "Dean–Jett",
  dean_jett_fox: "Dean–Jett–Fox",
  watson_pragmatic: "Watson Pragmatic",
  legacy_bridge_v1: "Legacy Bridge",
};

// Cell-cycle table cells may be restored from older sessions as numbers or
// generated now as percentage strings. Zero and finite negatives are data;
// only absent/non-finite values are missing.
export function format_cell_cycle_value(value, missing = "—") {
  if (value == null || value === "") return missing;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : missing;
  const text = String(value);
  return /^(?:[+-]?infinity|nan)$/i.test(text.trim()) ? missing : text;
}
