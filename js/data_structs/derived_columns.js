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

// Cell-cycle percentage columns, written once the Stage 8 report exists.
export const DJF_FRACTION_COLUMNS = [
  { key: "g1", label: "G1 %" },
  { key: "s", label: "S %" },
  { key: "g2", label: "G2/M %" },
];

// Section headers rendered above the derived columns, each centered over its
// member columns (only the members present in the frame are shown).
export const DERIVED_COLUMN_GROUPS = [
  { label: "Quality Control", columns: QC_LOST_COLUMNS.map((column) => column.label) },
  { label: "Dean-Jett-Fox Modeling", columns: DJF_FRACTION_COLUMNS.map((column) => column.label) },
];
