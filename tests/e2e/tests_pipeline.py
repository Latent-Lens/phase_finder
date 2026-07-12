#!/usr/bin/env python3
"""E2E coverage for the manual nine-stage Dean-Jett-Fox pipeline."""

from helpers import (
    TestContext,
    density_curve_count,
    fit_curve_count,
    isolate_first_plotted_sample,
    restore_row_selection,
    wait_for_overlay_hidden,
)


def _run_stage(page, stage, sample_name):
    selector = f"#djf_stage{stage}"
    page.click(selector)
    timeout = 180000 if stage in (6, 7) else 60000
    page.wait_for_function(
        """([selector, stage, sampleName]) => {
          const button = document.querySelector(selector);
          const state = window.PhaseFinder?.pipeline?.get_state?.(sampleName);
          return button?.classList.contains('djf_stage_complete')
            && !button.classList.contains('djf_stage_running')
            && state?.lastStageRun === stage;
        }""",
        arg=[selector, stage, sample_name],
        timeout=timeout,
    )
    wait_for_overlay_hidden(page, timeout_ms=10000)


def _state_summary(page, sample_name, stage):
    return page.evaluate(
        """([sampleName, stage]) => {
          const pipeline = window.PhaseFinder.pipeline;
          const state = pipeline.get_state(sampleName);
          const row = window.PhaseFinder.app.get_parsed_files()
            .find((candidate) => candidate.name === sampleName);
          if (!state || !row) return null;

          if (stage === 0) {
            return {
              lastStageRun: state.lastStageRun,
              eventCount: row.data.eventCount,
              retained: state.structuralQC?.retainedEventCount,
              maskLength: row.data.masks.structural?.length,
              finalLength: row.data.masks.final?.length,
            };
          }
          if (stage === 1) {
            return {
              lastStageRun: state.lastStageRun,
              skipped: state.timeQC?.skipped,
              bins: state.timeQC?.scoredBins?.length || 0,
              segments: state.timeQC?.segmentCount || 0,
              retained: state.timeQC?.retainedEventCount || 0,
              maskLength: row.data.masks.timeQC?.length || 0,
            };
          }
          if (stage === 2) {
            return {
              lastStageRun: state.lastStageRun,
              skipped: state.scatterGate?.skipped,
              components: state.scatterGate?.components?.length || 0,
              fitted: state.scatterGate?.fittedEventCount || 0,
              retained: state.scatterGate?.retainedEventCount || 0,
              maskLength: row.data.masks.scatter?.length || 0,
            };
          }
          if (stage === 3) {
            return {
              lastStageRun: state.lastStageRun,
              skipped: state.singletResult?.skipped,
              geometryMode: state.singletResult?.geometryMode,
              fitted: state.singletResult?.fittedEventCount || 0,
              retained: state.singletResult?.retainedSingletCount || 0,
              maskLength: row.data.masks.singlet?.length || 0,
            };
          }
          if (stage === 4) {
            const histogram = state.histogram;
            return {
              lastStageRun: state.lastStageRun,
              bins: histogram?.x?.length || 0,
              countSum: histogram?.y?.reduce((sum, value) => sum + value, 0) || 0,
              binnedCount: histogram?.binnedCount || 0,
              plotBins: window.PhaseFinder.plot.get_histogram(sampleName)?.counts?.length || 0,
            };
          }
          if (stage === 5) {
            return {
              lastStageRun: state.lastStageRun,
              found: state.peaks?.found,
              ratio: state.peaks?.ratio,
              mu1: state.peaks?.mu1,
              mu2: state.peaks?.mu2,
            };
          }
          if (stage === 6) {
            return {
              lastStageRun: state.lastStageRun,
              curveBins: state.baseFit?.curves?.fitted?.length || 0,
              mu1: state.baseFit?.parameters?.mu1,
              ratio: state.baseFit?.parameters?.R,
              converged: state.baseFit?.diagnostics?.converged,
              iterations: state.baseFit?.diagnostics?.iterations,
            };
          }
          if (stage === 7) {
            return {
              lastStageRun: state.lastStageRun,
              selectedModel: state.extendedFit?.selectedModel,
              candidates: state.extendedFit?.diagnostics?.candidateFits?.length || 0,
              curveBins: state.extendedFit?.curves?.fitted?.length || 0,
            };
          }

          const fractions = state.report?.fractions?.biologicalSinglets;
          return {
            lastStageRun: state.lastStageRun,
            oneC: fractions?.oneC,
            sPhase: fractions?.sPhase,
            twoC: fractions?.twoC,
            fractionSum: fractions
              ? fractions.oneC + fractions.sPhase + fractions.twoC
              : null,
            warnings: state.report?.warnings?.length,
            hasDisplaySummary: Boolean(state.report?.displaySummary?.cellCycle),
          };
        }""",
        [sample_name, stage],
    )


def test_pipeline(ctx: TestContext):
    page = ctx.page
    group = "DJF Pipeline"
    previous_selection = []

    try:
        sample_name, previous_selection = isolate_first_plotted_sample(page)

        fixture = page.evaluate(
            """(sampleName) => {
              const row = window.PhaseFinder.app.get_parsed_files()
                .find((candidate) => candidate.name === sampleName);
              const data = row?.data;
              const channelNames = ['DNA_A', 'DNA_H', 'DNA_W', 'FSC_A', 'SSC_A', 'Time'];
              return {
                eventCount: data?.eventCount || 0,
                channelLengths: channelNames.map((name) => data?.channels?.[name]?.length || 0),
                indexes: data?.indexes,
              };
            }""",
            sample_name,
        )
        ctx.check(
            group,
            "Synthetic fixture loads index-aligned DNA A/H/W, FSC-A, SSC-A, and Time channels",
            fixture["eventCount"] > 0
            and all(length == fixture["eventCount"] for length in fixture["channelLengths"])
            and all(fixture["indexes"].get(key) is not None for key in
                    ("dna_a", "dna_h", "dna_w", "fsc_a", "ssc_a", "time")),
            str(fixture),
        )

        pipeline_before = page.evaluate("() => window.PhaseFinder.pipeline")
        ctx.check(
            group,
            "Pipeline implementation is lazy-loaded before the first manual stage",
            pipeline_before is None,
            f"pipeline={pipeline_before!r}",
        )

        for stage in range(9):
            try:
                _run_stage(page, stage, sample_name)
            except Exception as error:
                ctx.check(group, f"Manual Stage {stage} button completes", False, str(error))
                return

            readout = page.eval_on_selector("#djf_readout", "element => element.textContent")
            ctx.check(
                group,
                f"Manual Stage {stage} button runs only its pipeline checkpoint",
                f"Stage {stage}" in readout
                and page.locator(f"#djf_stage{stage}").evaluate(
                    "button => button.classList.contains('djf_stage_complete')"
                ),
                readout.strip(),
            )

            summary = _state_summary(page, sample_name, stage)
            if stage == 0:
                ok = (summary["retained"] == summary["eventCount"]
                      and summary["maskLength"] == summary["eventCount"]
                      and summary["finalLength"] == summary["eventCount"])
                label = "Stage 0 stores structural and final masks in original event order"
            elif stage == 1:
                ok = (summary["skipped"] is False and summary["bins"] >= 2
                      and summary["segments"] >= 1 and summary["retained"] > 0
                      and summary["maskLength"] == fixture["eventCount"])
                label = "Stage 1 exercises Time QC instead of the missing-channel skip path"
            elif stage == 2:
                modal_visible = page.locator("#djf_scatter_modal").is_visible()
                scatter_marks = page.locator("#djf_scatter_plot svg circle").count()
                ok = (summary["skipped"] is False and summary["components"] == 2
                      and 0 < summary["retained"] <= summary["fitted"]
                      and summary["maskLength"] == fixture["eventCount"]
                      and modal_visible and scatter_marks > 0)
                label = "Stage 2 fits FSC/SSC GMM and opens populated gate diagnostics"
                page.click("#djf_scatter_modal_close")
                page.wait_for_selector("#djf_scatter_modal", state="hidden", timeout=10000)
            elif stage == 3:
                ok = (summary["skipped"] is False and bool(summary["geometryMode"])
                      and 0 < summary["retained"] <= summary["fitted"]
                      and summary["maskLength"] == fixture["eventCount"])
                label = "Stage 3 exercises pulse-geometry singlet gating"
            elif stage == 4:
                ok = (summary["bins"] >= 16 and summary["countSum"] > 0
                      and summary["countSum"] == summary["binnedCount"]
                      and summary["plotBins"] == summary["bins"]
                      and density_curve_count(page) == 1)
                label = "Stage 4 publishes its retained-event histogram to the plot"
            elif stage == 5:
                ok = (summary["found"] is True and 1.7 <= summary["ratio"] <= 2.3
                      and summary["mu1"] > 0 and summary["mu2"] > summary["mu1"])
                label = "Stage 5 detects the synthetic 1C/2C peak pair"
            elif stage == 6:
                ok = (summary["curveBins"] >= 16 and summary["mu1"] > 0
                      and 1.7 <= summary["ratio"] <= 2.3
                      and fit_curve_count(page) == 1)
                label = "Stage 6 stores and overlays a constrained base DJF fit"
            elif stage == 7:
                ok = (bool(summary["selectedModel"]) and summary["candidates"] >= 1
                      and summary["curveBins"] >= 16 and fit_curve_count(page) == 1)
                label = "Stage 7 compares contamination extensions and keeps a selected model"
            else:
                readout_has_fractions = all(token in readout for token in ("1C", "S", "2C", "%"))
                report_rows = page.locator("#djf_fit_table .djf_fit_phase_row").count()
                diagnostic_rows = page.locator("#djf_fit_table .djf_fit_diagnostics_row").count()
                ok = (abs(summary["fractionSum"] - 1) < 1e-6
                      and summary["hasDisplaySummary"] and readout_has_fractions
                      and report_rows >= 5 and diagnostic_rows >= 1)
                label = "Stage 8 shows normalized fractions and fit diagnostics"

            ctx.check(group, label, ok, str(summary))

        pipeline_after = page.evaluate(
            "() => typeof window.PhaseFinder.pipeline?.run_stage === 'function'"
            " && typeof window.PhaseFinder.pipeline?.get_state === 'function'"
        )
        ctx.check(
            group,
            "Loaded pipeline is exposed through window.PhaseFinder.pipeline",
            pipeline_after is True,
            f"loaded={pipeline_after}",
        )

        # A user can rerun any earlier checkpoint after inspecting the final
        # report.  Prove that both JS state and visual completion markers are
        # invalidated together, so stale fit/report output cannot survive.
        _run_stage(page, 2, sample_name)
        invalidated = page.evaluate(
            """(sampleName) => {
              const state = window.PhaseFinder.pipeline.get_state(sampleName);
              const row = window.PhaseFinder.app.get_parsed_files()
                .find((candidate) => candidate.name === sampleName);
              const finalCount = row.data.masks.final
                ? Array.from(row.data.masks.final).reduce((sum, value) => sum + value, 0)
                : null;
              return {
                lastStageRun: state.lastStageRun,
                hasScatter: Boolean(state.scatterGate),
                singletResult: state.singletResult,
                histogram: state.histogram,
                peaks: state.peaks,
                baseFit: state.baseFit,
                extendedFit: state.extendedFit,
                report: state.report,
                singletMask: row.data.masks.singlet,
                finalCount,
                filteredCount: row.data.filtered?.eventCount,
                downstreamComplete: Array.from({ length: 6 }, (_, offset) => offset + 3)
                  .filter((stage) => document.querySelector(`#djf_stage${stage}`)
                    ?.classList.contains('djf_stage_complete')).length,
                fitPaths: document.querySelectorAll('.djf-fit-overlay').length,
              };
            }""",
            sample_name,
        )
        ctx.check(
            group,
            "Rerunning Stage 2 invalidates Stage 3→8 state, masks, and completion badges",
            invalidated["lastStageRun"] == 2
            and invalidated["hasScatter"]
            and invalidated["singletResult"] is None
            and invalidated["histogram"] is None
            and invalidated["peaks"] is None
            and invalidated["baseFit"] is None
            and invalidated["extendedFit"] is None
            and invalidated["report"] is None
            and invalidated["singletMask"] is None
            and invalidated["downstreamComplete"] == 0
            and fit_curve_count(page) == 0,
            str(invalidated),
        )
        ctx.check(
            group,
            "Rerunning an upstream gate rebuilds the compacted view from the new final mask",
            invalidated["filteredCount"] == invalidated["finalCount"]
            and invalidated["finalCount"] > 0,
            str(invalidated),
        )
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
            page.wait_for_selector("#djf_scatter_modal", state="hidden", timeout=10000)
    except Exception as error:
        ctx.check(group, "Manual Stage 0→8 pipeline flow", False, str(error))
    finally:
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
        if previous_selection:
            restore_row_selection(page, previous_selection)
