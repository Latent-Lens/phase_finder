#!/usr/bin/env python3
"""Metadata table title-bar and CSV/TSV import behavior tests."""

from pathlib import Path

from helpers import (
    TestContext,
    set_files_via_drag_drop,
    table_row_count,
    wait_for_overlay_hidden,
    write_synthetic_fcs,
)


def _write_text(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return str(path)


def _first_loaded_name(page):
    return page.evaluate("() => window.PhaseFinder.app.get_parsed_files()[0]?.name || ''")


def _table_headers(page):
    return page.evaluate("() => window.PhaseFinder.app.get_table_columns().map((column) => column.label)")


def _field_for_label(page, label):
    return page.evaluate(
        """(label) => {
          const column = window.PhaseFinder.app.get_table_columns().find((entry) => entry.label === label);
          return column ? column.field : "";
        }""",
        label,
    )


def test_metadata_table_actions(ctx: TestContext):
    page = ctx.page
    group = "Metadata Table"

    # The four action buttons live inside .metadata_ops_group wrapper divs
    # (grouped as "Column Operations" / "Table I/O"), not as direct children
    # of .metadata_title_actions -- a plain child selector would only catch
    # the unrelated panel-collapse toggle button. Query all descendant
    # buttons and drop the two that aren't part of this ordering claim
    # (Remove Columns has no fixed position in this set; the collapse toggle
    # isn't a title-bar "action" at all).
    buttons = page.eval_on_selector_all(
        ".metadata_title_actions button",
        """buttons => buttons
          .filter((button) => button.id !== 'metadata_remove_column_button'
            && button.id !== 'metadata_panel_toggle')
          .map((button) => ({
            id: button.id,
            src: button.querySelector('img')?.getAttribute('src') || '',
          }))""",
    )
    expected_order = [
        ("metadata_parse_button", "text_to_col.svg"),
        ("metadata_add_column_button", "manual_add_column.svg"),
        ("metadata_import_button", "table_import.svg"),
        ("metadata_export_button", "table_export.svg"),
    ]
    actual_order = [(entry["id"], Path(entry["src"]).name) for entry in buttons]
    ctx.check(group, "Metadata title-bar actions are ordered wizard, add, upload, download",
              actual_order == expected_order, str(actual_order))

    # --- Add a blank metadata column, edit its header, and edit values ---
    page.click("#metadata_add_column_button")
    page.wait_for_selector(".metadata_header_input", timeout=5000)
    page.wait_for_selector(".metadata_header_ok", timeout=5000)
    page.fill(".metadata_header_input", "Treatment")
    page.click(".metadata_header_ok")
    page.wait_for_function("() => !document.querySelector('.metadata_header_input')", timeout=5000)
    treatment_field = _field_for_label(page, "Treatment")
    ctx.check(group, "Blank-column header can be edited inline",
              treatment_field != "", f"field={treatment_field}")
    sort_label = page.eval_on_selector(
        f'.th_sort[data-sort-field="{treatment_field}"]',
        "button => button.textContent",
    )
    ctx.check(group, "Confirmed blank-column header uses the normal sortable style",
              "Treatment" in sort_label and "▲" in sort_label and "▼" in sort_label,
              sort_label)

    page.fill(f'.file_table tbody input[data-field="{treatment_field}"]', "HU")
    tsv_after_manual = page.evaluate("() => window.PhaseFinder.app.metadata_table_tsv()")
    ctx.check(group, "Blank-column value edits are reflected in TSV export",
              "Treatment" in tsv_after_manual and "\tHU" in tsv_after_manual,
              tsv_after_manual.split("\n")[0])

    # --- Import an authoritative metadata table with one loaded and one missing FCS file ---
    loaded_name = _first_loaded_name(page)
    fixture_dir = ctx.results_dir / f"{ctx.report_stem}_metadata_import_fixtures"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    missing_file = write_synthetic_fcs(
        fixture_dir,
        seed=9901,
        strain="9901",
        timepoint="91",
        replicate="m",
        nocodazole_arrest="N",
    )
    missing_name = Path(missing_file).name
    metadata_path = _write_text(
        ctx.results_dir / f"{ctx.report_stem}_metadata_import.tsv",
        "Filename\tCondition\tDose\n"
        f"{loaded_name}\tloaded-control\t0\n"
        f"{missing_name}\tmissing-drug\t10\n",
    )
    page.set_input_files("#metadata_import_input", metadata_path)
    page.wait_for_function("() => window.PhaseFinder.app.get_table_columns().some((column) => column.label === 'Condition')", timeout=5000)

    headers_after_import = _table_headers(page)
    ctx.check(group, "Imported metadata table overwrites previous editable columns",
              headers_after_import == ["Filename", "Condition", "Dose"],
              str(headers_after_import))
    ctx.check(group, "Imported table preserves imported row count and order",
              table_row_count(page) == 2
              and page.eval_on_selector(".file_table tbody tr:first-child .filename_cell", "e => e.textContent").strip()
              == loaded_name.replace(".fcs", ""),
              f"rows={table_row_count(page)}")

    unlinked_rows = page.eval_on_selector_all(
        ".metadata_row_unlinked",
        "rows => rows.map(row => ({ text: row.textContent, disabled: row.querySelector('.row_select')?.disabled }))",
    )
    ctx.check(group, "Imported rows without loaded FCS files are red/unlinked and not selectable",
              len(unlinked_rows) == 1
              and missing_name.replace(".fcs", "") in unlinked_rows[0]["text"]
              and unlinked_rows[0]["disabled"],
              str(unlinked_rows))

    if page.eval_on_selector("#select_all_files", "e => e.checked"):
        page.click("#select_all_files")
    page.click("#select_all_files")
    selected_count = page.evaluate("() => window.PhaseFinder.app.get_selected_files().length")
    disabled_checked = page.eval_on_selector_all(
        ".metadata_row_unlinked .row_select",
        "boxes => boxes.some(box => box.checked)",
    )
    ctx.check(group, "Select-all selects only linked loaded-FCS rows",
              selected_count == 1 and not disabled_checked,
              f"selected={selected_count}, disabled_checked={disabled_checked}")

    # --- Loading the missing FCS links the existing red row in place ---
    set_files_via_drag_drop(page, "#drop_zone", [missing_file])
    wait_for_overlay_hidden(page)
    page.wait_for_function("() => document.querySelectorAll('.metadata_row_unlinked').length === 0", timeout=10000)
    condition_values = page.eval_on_selector_all(
        f'.file_table tbody input[data-field="{_field_for_label(page, "Condition")}"]',
        "inputs => inputs.map(input => input.value)",
    )
    ctx.check(group, "Later-loaded FCS file links to the existing imported row without duplication",
              table_row_count(page) == 2 and "missing-drug" in condition_values,
              f"rows={table_row_count(page)}, conditions={condition_values}")

    tsv_after_import = page.evaluate("() => window.PhaseFinder.app.metadata_table_tsv()")
    ctx.check(group, "TSV export after import includes linked and formerly unlinked rows",
              loaded_name.replace(".fcs", "") in tsv_after_import
              and missing_name.replace(".fcs", "") in tsv_after_import
              and "missing-drug" in tsv_after_import
              and "GFP/FITC-A Mean" not in tsv_after_import,
              tsv_after_import)

    # --- Invalid import leaves the current table unchanged ---
    before_invalid = page.evaluate("() => ({ headers: window.PhaseFinder.app.get_table_columns().map(c => c.label), rows: window.PhaseFinder.app.metadata_table_tsv() })")
    invalid_path = _write_text(
        ctx.results_dir / f"{ctx.report_stem}_metadata_import_invalid.tsv",
        "Condition\tDose\nno-filename\t99\n",
    )
    page.set_input_files("#metadata_import_input", invalid_path)
    page.wait_for_function(
        "() => /Filename column/.test(document.querySelector('#status_bar_message')?.textContent || '')",
        timeout=5000,
    )
    after_invalid = page.evaluate("() => ({ headers: window.PhaseFinder.app.get_table_columns().map(c => c.label), rows: window.PhaseFinder.app.metadata_table_tsv() })")
    ctx.check(group, "Import without a filename column leaves the current table unchanged",
              after_invalid == before_invalid, str(after_invalid["headers"]))
