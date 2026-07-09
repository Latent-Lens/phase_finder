#!/usr/bin/env python3
"""Filename metadata wizard tests: delimiter/fixed-width/regex split steps,
column hiding, the live preview, Apply/"Filename Only"/Cancel, and TSV export.

The wizard auto-opens once per run (handled/dismissed in tests_io.py); here it
is reopened manually via the table's title-bar icon, matching how a user would
reconfigure columns later in a session.
"""

from helpers import (
    TestContext,
    set_files_via_drag_drop,
    wait_briefly,
    wait_for_rows,
    write_synthetic_fcs,
)


def _make_wizard_fixture(ctx, seed, strain, timepoint, replicate, arrest):
    fixture_dir = ctx.results_dir / f"{ctx.report_stem}_wizard_fixtures"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    return write_synthetic_fcs(
        fixture_dir, seed=seed, strain=strain, timepoint=timepoint,
        replicate=replicate, nocodazole_arrest=arrest,
    )


def _th_sort_labels(page):
    """Column labels from .th_sort buttons, stripped of the appended
    sort-arrow glyphs that are part of the same element's textContent."""
    raw = page.eval_on_selector_all(".th_sort", "els => els.map(e => e.textContent)")
    return [label.replace("▲", "").replace("▼", "").strip() for label in raw]


def _row_field(page, field, name_fragment):
    """Read a metadata column value directly from the app's table frame for
    the row whose filename contains name_fragment — robust regardless of how
    many other rows earlier test modules have loaded."""
    return page.evaluate(
        """({ field, fragment }) => {
          const frame = window.PhaseFinder.app.get_file_table();
          const names = [...frame.col('name')];
          const idx = names.findIndex((n) => n.includes(fragment));
          if (idx < 0) return undefined;
          const col = frame.col(field);
          return col.length ? col[idx] : undefined;
        }""",
        {"field": field, "fragment": name_fragment},
    )


def test_metadata_wizard(ctx: TestContext):
    page = ctx.page
    group = "Metadata Wizard"

    fixture_a = _make_wizard_fixture(ctx, seed=9500, strain="9500", timepoint="12", replicate="a", arrest="N")
    fixture_b = _make_wizard_fixture(ctx, seed=9501, strain="9501", timepoint="24", replicate="b", arrest="Y")

    before = page.eval_on_selector_all(".file_table tbody .row_select", "els => els.length")
    set_files_via_drag_drop(page, "#drop_zone", [fixture_a, fixture_b])
    wait_for_rows(page, before + 2)

    # --- reopen manually via the table title-bar icon ---
    page.click("#metadata_parse_button")
    ctx.check(group, "Metadata wizard opens via its table title-bar icon",
              not page.eval_on_selector("#metadata_wizard_modal", "e => e.hidden"))

    # Reset to a clean single-step baseline so this test does not depend on
    # whatever configuration earlier suite modules left applied.
    page.click("#metadata_wizard_reset")
    ctx.check(group, '"Filename Only" clears custom columns back to just Filename',
              page.eval_on_selector_all(".file_table thead .th_sort", "els => els.length") == 1)

    page.click("#metadata_parse_button")
    step_count = page.eval_on_selector_all("#metadata_split_steps .metadata_split_step", "els => els.length")
    ctx.check(group, "Reopening after Filename Only shows a single default delimiter step", step_count == 1,
              f"steps={step_count}")

    # --- Step 1 (default delimiter "_"): hide it as the date-ish prefix ---
    page.fill('.metadata_split_step[data-step-index="0"] .metadata_step_column_name', "Date")
    page.check('.metadata_split_step[data-step-index="0"] .metadata_step_hide')

    # --- Step 2: fixed width, using the "Width" + "Set" convenience control ---
    page.click("#metadata_add_split_step")
    page.select_option('.metadata_split_step[data-step-index="1"] .metadata_split_type', "fixed")
    page.fill('.metadata_split_step[data-step-index="1"] .metadata_step_width', "4")
    page.click('.metadata_split_step[data-step-index="1"] .metadata_step_set_width')
    breaks_value = page.eval_on_selector(
        '.metadata_split_step[data-step-index="1"] .metadata_step_breaks', "e => e.value")
    ctx.check(group, 'Fixed-width step: entering a width and clicking "Set" fills the break position',
              breaks_value.strip() == "4", breaks_value)
    page.fill('.metadata_split_step[data-step-index="1"] .metadata_step_column_name', "Strain")

    # --- Steps 3 and 4: fixed width (1 char) for Replicate and Nocodazole Arrest ---
    for idx, label in ((2, "Replicate"), (3, "Nocodazole Arrest")):
        page.click("#metadata_add_split_step")
        row = f'.metadata_split_step[data-step-index="{idx}"]'
        page.select_option(f"{row} .metadata_split_type", "fixed")
        page.fill(f"{row} .metadata_step_breaks", "1")
        page.fill(f"{row} .metadata_step_column_name", label)

    # --- Step 5: regex for Timepoint ---
    page.click("#metadata_add_split_step")
    page.select_option('.metadata_split_step[data-step-index="4"] .metadata_split_type', "regex")
    page.fill('.metadata_split_step[data-step-index="4"] .metadata_step_regex', r"t(\d+)")
    page.fill('.metadata_split_step[data-step-index="4"] .metadata_step_column_name', "Timepoint")

    # Remainder: hide the leftover well/seed suffix.
    page.fill("#metadata_column_editor .metadata_column_name", "Well")
    page.check("#metadata_column_editor .metadata_leaf_hide input")
    wait_briefly(0.2)

    # --- Preview reflects the configured split before Apply is clicked ---
    preview_header = page.eval_on_selector_all(
        "#metadata_preview thead th", "els => els.map(e => e.textContent.trim())")
    ctx.check(group, "Preview header lists only the visible (non-hidden) configured columns",
              preview_header == ["Filename", "Strain", "Replicate", "Nocodazole Arrest", "Timepoint"],
              str(preview_header))

    preview_rows = page.eval_on_selector_all(
        "#metadata_preview tbody tr",
        "rows => rows.map(r => [...r.querySelectorAll('td')].map(td => td.textContent.trim()))",
    )
    ctx.check(group, "Preview body renders one 5-column split row per previewed file",
              len(preview_rows) > 0 and all(len(r) == 5 for r in preview_rows[:5]),
              str(preview_rows[:2]))

    # --- Apply ---
    page.click("#metadata_wizard_apply")
    ctx.check(group, "Apply closes the wizard modal",
              page.eval_on_selector("#metadata_wizard_modal", "e => e.hidden"))

    headers = _th_sort_labels(page)
    ctx.check(group, "Applied columns appear in the metadata table header, in configured order",
              headers[:5] == ["Filename", "Strain", "Replicate", "Nocodazole Arrest", "Timepoint"],
              str(headers))

    strain_a = _row_field(page, "strain", "E2E9500")
    replicate_a = _row_field(page, "replicate", "E2E9500")
    arrest_a = _row_field(page, "nocodazoleArrest", "E2E9500")
    timepoint_a = _row_field(page, "timepoint", "E2E9500")
    ctx.check(group, "Applied wizard values are correct for the first fixture file",
              (strain_a, replicate_a, arrest_a, timepoint_a) == ("9500", "a", "N", "12"),
              f"strain={strain_a}, replicate={replicate_a}, arrest={arrest_a}, timepoint={timepoint_a}")

    strain_b = _row_field(page, "strain", "E2E9501")
    timepoint_b = _row_field(page, "timepoint", "E2E9501")
    ctx.check(group, "Applied wizard values are correct for the second fixture file",
              (strain_b, timepoint_b) == ("9501", "24"), f"strain={strain_b}, timepoint={timepoint_b}")

    # --- Cancel discards in-progress edits without touching the applied table ---
    page.click("#metadata_parse_button")
    reopened_steps = page.eval_on_selector_all(
        "#metadata_split_steps .metadata_split_step",
        """rows => rows.map(row => ({
          type: row.querySelector('.metadata_split_type')?.value,
          label: row.querySelector('.metadata_step_column_name')?.value,
          hidden: Boolean(row.querySelector('.metadata_step_hide')?.checked),
          regex: row.querySelector('.metadata_step_regex')?.value || '',
          breaks: row.querySelector('.metadata_step_breaks')?.value || '',
        }))""",
    )
    ctx.check(group, "Reopening the wizard restores the applied split settings",
              len(reopened_steps) >= 5
              and reopened_steps[0]["type"] == "delimiter"
              and reopened_steps[0]["hidden"]
              and reopened_steps[1]["label"] == "Strain"
              and reopened_steps[4]["regex"] == r"t(\d+)",
              str(reopened_steps[:5]))
    page.fill('.metadata_split_step[data-step-index="0"] .metadata_step_delimiter', "-")
    page.click("#metadata_wizard_cancel")
    headers_after_cancel = _th_sort_labels(page)
    ctx.check(group, "Cancel discards in-progress wizard edits, leaving the applied table unchanged",
              headers_after_cancel[:5] == ["Filename", "Strain", "Replicate", "Nocodazole Arrest", "Timepoint"],
              str(headers_after_cancel))

    # --- TSV export includes the configured columns and their values ---
    tsv = page.evaluate("() => window.PhaseFinder.app.metadata_table_tsv()")
    lines = tsv.strip("\n").split("\n")
    ctx.check(group, "Exported TSV header includes every configured metadata column",
              lines[0].split("\t")[:5] == ["Filename", "Strain", "Replicate", "Nocodazole Arrest", "Timepoint"],
              lines[0])
    row_a_tsv = next((line for line in lines if "9500aN" in line), None)
    ctx.check(group, "Exported TSV row contains the split values for the first fixture file",
              row_a_tsv is not None and row_a_tsv.split("\t")[1:5] == ["9500", "a", "N", "12"],
              row_a_tsv)

    if page.evaluate("() => typeof window.showSaveFilePicker") != "function":
        try:
            with page.expect_download(timeout=8000) as download_info:
                page.click("#metadata_export_button")
            download = download_info.value
            ctx.check(group, "Export icon triggers a TSV file download",
                      download.suggested_filename == "phasefinder_loaded_fcs_samples.tsv",
                      download.suggested_filename)
        except Exception as error:
            ctx.check(group, "Export icon triggers a TSV file download", False, str(error))
    else:
        ctx.warn(group, "Export icon triggers a TSV file download",
                 "window.showSaveFilePicker is available in this browser; skipped to avoid a native file "
                 "dialog the test runner cannot interact with (TSV content itself was verified above)")
