#!/usr/bin/env python3
"""Modeling tests for the manual Stage 5-8 pipeline's Run-all convenience
action. Run all (#djf_run_all) only executes the modeling checkpoints
(Peaks/Fit/Extend/Report) -- it never touches Pre-modeling QC (Stage 0-3),
which is a separate action with its own "Run All" button. This module applies
QC explicitly before Run all, matching what a real user does, rather than
depending on QC state left over by an earlier test module."""

from helpers import (
    TestContext,
    enter_modeling_mode,
    exit_modeling_mode,
    fit_curve_count,
    isolate_first_plotted_sample,
    restore_row_selection,
    status_bar_text,
    wait_for_overlay_hidden,
)


def _readout_text(page):
    """#djf_readout is a debug readout the current UI doesn't render (its
    consumers all guard with `if (djf_readout)`); tolerate its absence rather
    than fail the whole flow on a missing selector."""
    if page.query_selector("#djf_readout") is None:
        return ""
    return page.eval_on_selector("#djf_readout", "element => element.textContent.trim()")


def _ensure_qc_applied(page):
    """Turn on every Pre-modeling QC gate that isn't already on, and wait for
    each to apply. Checks gates individually rather than using the combined
    #qc_stage_all toggle, since that button's click semantics (turn all on,
    or clear if already all on) depend on the current state."""
    for stage in range(4):
        selector = f"#qc_stage{stage}"
        if page.eval_on_selector(selector, "e => e.getAttribute('aria-pressed')") != "true":
            page.click(selector)
            page.wait_for_function(
                "(sel) => !document.querySelector(sel)?.disabled",
                arg=selector, timeout=30000,
            )
            if page.locator("#djf_scatter_modal").is_visible():
                page.click("#djf_scatter_modal_close")
                page.wait_for_selector("#djf_scatter_modal", state="hidden", timeout=10000)


def test_modeling(ctx: TestContext):
    page = ctx.page
    group = "Modeling"
    previous_selection = []

    try:
        sample_name, previous_selection = isolate_first_plotted_sample(page)

        # Run all / stage buttons now live in the sidebar's Cell Cycle Modeling
        # mode; open it before driving them.
        enter_modeling_mode(page)

        _ensure_qc_applied(page)

        # Clear only the modeling checkpoints (not the QC just applied above)
        # so this check proves Run all executes real work, rather than merely
        # redisplaying state left by an earlier test module.
        page.evaluate(
            """(sampleName) => {
              const state = window.PhaseFinder.pipeline?.get_state?.(sampleName);
              if (state) {
                state.peaks = null;
                state.baseFit = null;
                state.extendedFit = null;
                state.report = null;
              }
              document.querySelector('#djf_run_all')?.classList.remove('djf_stage_complete');
            }""",
            sample_name,
        )

        run_all_enabled = page.locator("#djf_run_all").is_enabled()
        ctx.check(
            group,
            "Run-all pipeline control is enabled after plotting a DNA channel",
            run_all_enabled,
        )
        if not run_all_enabled:
            return

        status_before = status_bar_text(page)
        page.click("#djf_run_all")
        page.wait_for_function(
            """(sampleName) => {
              const button = document.querySelector('#djf_run_all');
              const state = window.PhaseFinder?.pipeline?.get_state?.(sampleName);
              return state?.lastStageRun === 8
                && button?.classList.contains('djf_stage_complete')
                && !button.disabled
                && !button.classList.contains('djf_stage_running');
            }""",
            arg=sample_name,
            timeout=300000,
        )
        wait_for_overlay_hidden(page, timeout_ms=15000)

        summary = page.evaluate(
            """(sampleName) => {
              const state = window.PhaseFinder.pipeline.get_state(sampleName);
              const fractions = state.report?.fractions?.biologicalSinglets;
              return {
                lastStageRun: state.lastStageRun,
                structural: Boolean(state.structuralMask),
                timeQC: Boolean(state.timeQC) && !state.timeQC.skipped,
                scatter: Boolean(state.scatterGate) && !state.scatterGate.skipped,
                singlet: Boolean(state.singletResult) && !state.singletResult.skipped,
                histogram: Boolean(state.histogram),
                peaks: Boolean(state.peaks),
                baseFit: Boolean(state.baseFit),
                extendedFit: Boolean(state.extendedFit),
                report: Boolean(state.report),
                fractionSum: fractions
                  ? fractions.oneC + fractions.sPhase + fractions.twoC
                  : null,
                stagesComplete: [5, 6, 7, 8]
                  .filter((stage) => document.querySelector(`#djf_stage${stage}`)
                    ?.classList.contains('djf_stage_complete'))
                  .length,
              };
            }""",
            sample_name,
        )
        ctx.check(
            group,
            "Pre-modeling QC (applied explicitly above) is in effect for this sample",
            summary["structural"] and summary["timeQC"] and summary["scatter"] and summary["singlet"],
            str(summary),
        )
        modeling_products = all(summary[key] for key in (
            "histogram", "peaks", "baseFit", "extendedFit", "report",
        ))
        ctx.check(
            group,
            "Run all executes Stage 5-8 and retains every modeling checkpoint product",
            summary["lastStageRun"] == 8
            and summary["stagesComplete"] == 4
            and modeling_products,
            str(summary),
        )

        readout = _readout_text(page)
        status_after = status_bar_text(page)
        phase_rows = page.locator("#djf_fit_table .djf_fit_phase_row").count()
        ctx.check(
            group,
            "Run-all result is rendered as a fit overlay, report table, and fraction readout",
            fit_curve_count(page) == 1
            and phase_rows >= 5
            and (not readout or all(token in readout for token in ("Stage 8", "1C", "S", "2C", "%")))
            and abs(summary["fractionSum"] - 1) < 1e-6,
            f"fits={fit_curve_count(page)}, rows={phase_rows}, readout={readout}",
        )
        ctx.check(
            group,
            "Run all reports completion in the status bar",
            "modeling stages completed" in status_after.lower()
            and status_after != status_before,
            f"before={status_before!r}, after={status_after!r}",
        )

        table_stats = page.evaluate(
            """(sampleName) => {
              const frame = window.PhaseFinder.app.get_file_table();
              const columns = [
                'Structural lost', 'Time QC lost', 'Scatter lost', 'Singlet lost',
                'G1 %', 'S %', 'G2/M %',
              ];
              const rowIndex = [...frame.col('name')].indexOf(sampleName);
              return {
                rowIndex,
                columnsPresent: columns.every((column) => frame.columns.includes(column)),
                values: Object.fromEntries(columns.map((column) => [
                  column,
                  frame.columns.includes(column) && rowIndex >= 0
                    ? frame.col(column)[rowIndex]
                    : null,
                ])),
                visibleHeaders: [...document.querySelectorAll('#file_table thead th')]
                  .map((cell) => cell.textContent.trim()),
              };
            }""",
            sample_name,
        )
        losses = [table_stats["values"][name] for name in (
            "Structural lost", "Time QC lost", "Scatter lost", "Singlet lost",
        )]
        fractions = [table_stats["values"][name] for name in ("G1 %", "S %", "G2/M %")]
        formatted_losses = all(
            value == "—" or (isinstance(value, str) and "(" in value and value.endswith("%)"))
            for value in losses
        )
        formatted_fractions = all(
            isinstance(value, str) and value.endswith("%") for value in fractions
        )
        fraction_total = sum(float(value.rstrip("%")) for value in fractions) if formatted_fractions else 0
        ctx.check(
            group,
            "Stage 8 publishes sequential filter losses and G1/S/G2-M percentages to the metadata table",
            table_stats["rowIndex"] >= 0
            and table_stats["columnsPresent"]
            and formatted_losses
            and formatted_fractions
            and abs(fraction_total - 100) <= 0.2
            and all(name in table_stats["visibleHeaders"] for name in (
                "Structural lost", "Time QC lost", "Scatter lost", "Singlet lost",
                "G1 %", "S %", "G2/M %",
            )),
            str(table_stats),
        )
    except Exception as error:
        ctx.check(group, "QC-applied, Run-all Stage 5-8 pipeline flow", False, str(error))
    finally:
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
        # Return the sidebar to file mode so later tests (e.g. Calculate
        # Statistics) can reach the file-mode action buttons again.
        exit_modeling_mode(page)
        if previous_selection:
            restore_row_selection(page, previous_selection)
