export function metadata_field_from_label(label, used_fields = new Set()) {
  const trimmed = String(label || "").trim();
  const known = {
    filename: "filename",
    strain: "strain",
    replicate: "replicate",
    "nocodazole arrest": "nocodazoleArrest",
    nocodazole: "nocodazoleArrest",
    arrest: "nocodazoleArrest",
    timepoint: "timepoint",
    time: "timepoint",
  };
  const lower = trimmed.toLowerCase();
  let base = known[lower] || lower
    .replace(/[^a-z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "");
  if (!base || /^\d/.test(base)) base = `metadata${base ? `_${base}` : ""}`;
  if (base === "id" || base === "name") base = `${base}Metadata`;

  let field = base;
  let suffix = 2;
  while (used_fields.has(field)) field = `${base}${suffix++}`;
  used_fields.add(field);
  return field;
}

export function unique_metadata_label(label, used_labels = new Set()) {
  const base = String(label || "").trim() || "Column";
  let candidate = base;
  let suffix = 2;
  while (used_labels.has(candidate.toLowerCase())) candidate = `${base} ${suffix++}`;
  used_labels.add(candidate.toLowerCase());
  return candidate;
}

export function normalize_metadata_columns(columns, { default_source = "metadata" } = {}) {
  const used_fields = new Set(["id", "name"]);
  const used_labels = new Set();
  return (columns || []).filter(Boolean).map((column) => {
    const label = unique_metadata_label(column.label ?? column.header ?? "Column", used_labels);
    let field = String(column.field || "").trim();
    if (!field || used_fields.has(field)) field = metadata_field_from_label(label, used_fields);
    else used_fields.add(field);
    return {
      field,
      label,
      editable: column.editable !== false,
      filterable: column.filterable !== false,
      headerEditable: Boolean(column.headerEditable ?? column.header_editable ?? false),
      source: column.source || default_source,
      source_header: column.source_header || column.header || column.label || "",
    };
  });
}
