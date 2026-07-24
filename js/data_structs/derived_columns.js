// Shared definitions for the DJF pipeline's derived metadata-table columns.
// The pipeline UI writes these columns; the table renderer groups them under
// section headers. Keeping the names and grouping here keeps the two in sync.

// Leading raw event-count column. Its header is split across the two header
// rows ("Total number" over "of events"); the frame key is the full name.
export const TOTAL_EVENTS_COLUMN = "Total number of events";
export const TOTAL_EVENTS_HEADER = { top: "Total number", bottom: "of events" };

// Per-filter event-loss columns, ordered by the gating stage that produces them
// (stage index 0..3). Written as each stage completes.
export const QC_LOST_COLUMNS = [
  { key: "structural", label: "Structural lost" },
  { key: "timeQC", label: "Time QC lost" },
  { key: "scatter", label: "Scatter lost" },
  { key: "singlet", label: "Singlet lost" },
];

// Section headers rendered above the derived columns, each centered over its
// member columns (only the members present in the frame are shown). Cell-cycle
// fit fractions are NOT here -- they are dynamic, one 3-column group per model
// in use, keyed by CELL_CYCLE_COLUMN_PREFIX (see below and cell_cycle_columns.js).
export const DERIVED_COLUMN_GROUPS = [
  { label: "Quality Control", columns: QC_LOST_COLUMNS.map((column) => column.label) },
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
