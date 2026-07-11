#!/usr/bin/env python3
"""Modeling tests for the staged DJF pipeline's Run-all convenience action."""

from helpers import (
    TestContext,
    fit_curve_count,
    isolate_first_plotted_sample,
    restore_row_selection,
    status_bar_text,
    wait_for_overlay_hidden,
)


def test_modeling(ctx: TestContext):
    page = ctx.page
    group = "Modeling"
    previous_selection = []

    try:
        sample_name, previous_selection = isolate_first_plotted_sample(page)

        # Start from an empty per-sample result so this check proves that the
        # UI action executes all nine stages, rather than merely redisplaying
        # state left by the preceding manual-button test.
        page.evaluate(
            """(sampleName) => {
              window.PhaseFinder.pipeline?.clear_state?.(sampleName);
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
                stagesComplete: [...document.querySelectorAll('[id^="djf_stage"]')]
                  .filter((button) => /^djf_stage[0-8]$/.test(button.id))
                  .filter((button) => button.classList.contains('djf_stage_complete'))
                  .length,
              };
            }""",
            sample_name,
        )
        all_products = all(summary[key] for key in (
            "structural",
            "timeQC",
            "scatter",
            "singlet",
            "histogram",
            "peaks",
            "baseFit",
            "extendedFit",
            "report",
        ))
        ctx.check(
            group,
            "Run all executes Stage 0→8 and retains every checkpoint product",
            summary["lastStageRun"] == 8
            and summary["stagesComplete"] == 9
            and all_products,
            str(summary),
        )

        readout = page.eval_on_selector("#djf_readout", "element => element.textContent.trim()")
        status_after = status_bar_text(page)
        phase_rows = page.locator("#djf_fit_table .djf_fit_phase_row").count()
        ctx.check(
            group,
            "Run-all result is rendered as a fit overlay, report table, and fraction readout",
            fit_curve_count(page) == 1
            and phase_rows >= 5
            and all(token in readout for token in ("Stage 8", "1C", "S", "2C", "%"))
            and abs(summary["fractionSum"] - 1) < 1e-6,
            f"fits={fit_curve_count(page)}, rows={phase_rows}, readout={readout}",
        )
        ctx.check(
            group,
            "Run all reports completion in the status bar",
            "all nine" in status_after.lower()
            and status_after != status_before,
            f"before={status_before!r}, after={status_after!r}",
        )
    except Exception as error:
        ctx.check(group, "Run-all Stage 0→8 pipeline flow", False, str(error))
    finally:
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
        if previous_selection:
            restore_row_selection(page, previous_selection)
