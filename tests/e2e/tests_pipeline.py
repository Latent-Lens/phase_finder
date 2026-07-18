#!/usr/bin/env python3
"""E2E coverage for the pre-modeling QC gates (0-3, driven by the #qc_stageN
toggle buttons), the automatic Stage 4 histogram, and the manual Stage 5-8
Dean-Jett-Fox modeling buttons."""

import math

from helpers import (
    TestContext,
    density_curve_count,
    enter_modeling_mode,
    exit_modeling_mode,
    fit_curve_count,
    isolate_first_plotted_sample,
    restore_row_selection,
    wait_for_overlay_hidden,
)


def _run_stage(page, stage, sample_name):
    """Click a manual Stage 5-8 button and wait for it to complete."""
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


def _run_qc_stage(page, stage, sample_name):
    """Click a Pre-modeling QC toggle (0-3) and wait for it to apply. Toggles
    the button's current state (on -> off, off -> on) rather than assuming a
    direction, since apply_qc_selection() re-derives the checked set from
    every button's aria-pressed state, not from which one was just clicked."""
    selector = f"#qc_stage{stage}"
    turning_on = page.eval_on_selector(selector, "e => e.getAttribute('aria-pressed') !== 'true'")
    page.click(selector)
    state_field = ["structuralQC", "timeQC", "scatterGate", "singletResult"][stage]
    page.wait_for_function(
        """([selector, expectPressed, sampleName, stateField]) => {
          const button = document.querySelector(selector);
          if (button?.disabled) return false;
          if (button?.getAttribute('aria-pressed') !== (expectPressed ? 'true' : 'false')) return false;
          const state = window.PhaseFinder?.pipeline?.get_state?.(sampleName);
          const applied = Boolean(state?.[stateField]);
          return expectPressed ? applied : !applied;
        }""",
        arg=[selector, turning_on, sample_name, state_field],
        timeout=60000,
    )
    wait_for_overlay_hidden(page, timeout_ms=10000)


def _readout_text(page):
    """#djf_readout is a debug readout the current UI doesn't render (its
    consumers all guard with `if (djf_readout)`); tolerate its absence rather
    than fail the whole flow on a missing selector."""
    if page.query_selector("#djf_readout") is None:
        return ""
    return page.eval_on_selector("#djf_readout", "element => element.textContent")


def _wait_for_histogram(page, sample_name, timeout=15000):
    """Stage 4 has no button of its own -- it's rebuilt automatically (see
    ensure_histogram_current() / schedule_qc_precompute() in pipeline_ui.js)
    whenever QC changes or shortly after a channel plots."""
    page.wait_for_function(
        "(sampleName) => Boolean(window.PhaseFinder?.pipeline?.get_state?.(sampleName)?.histogram)",
        arg=sample_name,
        timeout=timeout,
    )


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
              curveBins: state.baseFit?.expectedCounts?.length || 0,
              mu1: state.baseFit?.parameters?.mu1,
              ratio: state.baseFit?.parameters?.R,
              converged: state.baseFit?.converged,
              iterations: state.baseFit?.diagnostics?.iterations,
            };
          }
          if (stage === 7) {
            return {
              lastStageRun: state.lastStageRun,
              selectedModel: state.extendedFit?.diagnostics?.selectedModel,
              candidates: state.extendedFit?.diagnostics?.candidateFits?.length || 0,
              curveBins: state.extendedFit?.expectedCounts?.length || 0,
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

        # The manual Stage 5-8 buttons and Run all now live in the sidebar's
        # Cell Cycle Modeling mode; open it before driving them.
        enter_modeling_mode(page)

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

        # The pipeline module now loads silently in the background shortly
        # after any channel plots (see schedule_qc_precompute() in
        # pipeline_ui.js), rather than staying deferred until a manual DJF
        # action -- that's what makes Stage 4 and the first Pre-model QC
        # click instant. Confirm it's actually usable here instead.
        pipeline_ready = page.evaluate(
            "() => typeof window.PhaseFinder.pipeline?.run_stage === 'function'"
        )
        ctx.check(
            group,
            "Pipeline module is loaded and usable before any manual QC/modeling action",
            pipeline_ready is True,
            f"ready={pipeline_ready}",
        )

        # --- Pre-modeling QC gates (0-3), driven by the #qc_stageN toggles ---
        for stage in range(4):
            try:
                _run_qc_stage(page, stage, sample_name)
            except Exception as error:
                ctx.check(group, f"QC toggle {stage} applies", False, str(error))
                return

            ctx.check(
                group,
                f"QC toggle {stage} is marked active after applying",
                page.eval_on_selector(f"#qc_stage{stage}", "e => e.getAttribute('aria-pressed')") == "true",
            )

            summary = _state_summary(page, sample_name, stage)
            if stage == 0:
                ok = (summary["retained"] == summary["eventCount"]
                      and summary["maskLength"] == summary["eventCount"]
                      and summary["finalLength"] == summary["eventCount"])
                label = "Structural QC stores structural and final masks in original event order"
            elif stage == 1:
                ok = (summary["skipped"] is False and summary["bins"] >= 2
                      and summary["segments"] >= 1 and summary["retained"] > 0
                      and summary["maskLength"] == fixture["eventCount"])
                label = "Time QC exercises real scoring instead of the missing-channel skip path"
            elif stage == 2:
                # Turning the Cell Gate toggle on opens the interactive
                # scatter-gate inspector automatically (pipeline_ui.js:
                # open_cell_gate_inspector()) -- this is now the only UI
                # trigger for it.
                modal_visible = page.locator("#djf_scatter_modal").is_visible()
                scatter_marks = page.locator("#djf_scatter_plot svg circle").count()
                ok = (summary["skipped"] is False and summary["components"] == 2
                      and 0 < summary["retained"] <= summary["fitted"]
                      and summary["maskLength"] == fixture["eventCount"]
                      and modal_visible and scatter_marks > 0)
                label = "Cell Gate fits FSC/SSC GMM and opens populated gate diagnostics"

                gate_before = page.evaluate(
                    """(sampleName) => {
                      const result = window.PhaseFinder.pipeline.get_state(sampleName).scatterGate;
                      let indexSum = 0;
                      for (let index = 0; index < result.scatterMask.length; index += 1) {
                        if (result.scatterMask[index]) indexSum += index + 1;
                      }
                      return {
                        mean: [...result.mainComponent.mean],
                        threshold: result.threshold,
                        retained: result.retainedEventCount,
                        indexSum,
                      };
                    }""",
                    sample_name,
                )
                center = page.locator("#djf_scatter_plot .djf_scatter_gate_center")
                center_box = center.bounding_box()
                page.mouse.move(
                    center_box["x"] + center_box["width"] / 2,
                    center_box["y"] + center_box["height"] / 2,
                )
                page.mouse.down()
                page.mouse.move(
                    center_box["x"] + center_box["width"] / 2 + 42,
                    center_box["y"] + center_box["height"] / 2,
                    steps=8,
                )
                page.mouse.up()
                page.wait_for_function(
                    """(sampleName) => Boolean(
                      window.PhaseFinder.pipeline.get_state(sampleName)
                        ?.scatterGate?.manualOverride
                    )""",
                    arg=sample_name,
                    timeout=10000,
                )
                gate_moved = page.evaluate(
                    """(sampleName) => {
                      const state = window.PhaseFinder.pipeline.get_state(sampleName);
                      const row = window.PhaseFinder.app.get_parsed_files()
                        .find((candidate) => candidate.name === sampleName);
                      const result = state.scatterGate;
                      let indexSum = 0;
                      for (let index = 0; index < result.scatterMask.length; index += 1) {
                        if (result.scatterMask[index]) indexSum += index + 1;
                      }
                      return {
                        mean: [...result.mainComponent.mean],
                        threshold: result.threshold,
                        retained: result.retainedEventCount,
                        indexSum,
                        source: result.gateSource,
                        rawMaskIsAuthoritative: row.data.masks.scatter === result.scatterMask,
                        filteredCount: row.data.filtered?.eventCount,
                        finalCount: Array.from(row.data.masks.final)
                          .reduce((sum, value) => sum + value, 0),
                        caption: document.querySelector('#djf_scatter_caption')?.textContent,
                        resetEnabled: !document.querySelector('#djf_scatter_reset')?.disabled,
                      };
                    }""",
                    sample_name,
                )
                ctx.check(
                    group,
                    "Dragging the Cell Gate ellipse applies a new authoritative scatter mask",
                    gate_moved["source"] == "manual"
                    and gate_moved["mean"] != gate_before["mean"]
                    and gate_moved["indexSum"] != gate_before["indexSum"]
                    and gate_moved["rawMaskIsAuthoritative"]
                    and gate_moved["filteredCount"] == gate_moved["finalCount"]
                    and gate_moved["resetEnabled"]
                    and "Manual gate applied" in gate_moved["caption"],
                    f"before={gate_before}, moved={gate_moved}",
                )

                page.click("#djf_scatter_reset")
                page.wait_for_function(
                    """(sampleName) =>
                      !window.PhaseFinder.pipeline.get_state(sampleName)
                        ?.scatterGate?.manualOverride""",
                    arg=sample_name,
                    timeout=10000,
                )
                gate_reset = page.evaluate(
                    """(sampleName) => {
                      const result = window.PhaseFinder.pipeline.get_state(sampleName).scatterGate;
                      let indexSum = 0;
                      for (let index = 0; index < result.scatterMask.length; index += 1) {
                        if (result.scatterMask[index]) indexSum += index + 1;
                      }
                      return {
                        mean: [...result.mainComponent.mean],
                        threshold: result.threshold,
                        retained: result.retainedEventCount,
                        indexSum,
                        source: result.gateSource,
                        resetDisabled: document.querySelector('#djf_scatter_reset')?.disabled,
                      };
                    }""",
                    sample_name,
                )
                ctx.check(
                    group,
                    "Reset fitted gate restores the original ellipse and scatter mask",
                    gate_reset["source"] == "fitted"
                    and gate_reset["mean"] == gate_before["mean"]
                    and gate_reset["threshold"] == gate_before["threshold"]
                    and gate_reset["retained"] == gate_before["retained"]
                    and gate_reset["indexSum"] == gate_before["indexSum"]
                    and gate_reset["resetDisabled"],
                    f"before={gate_before}, reset={gate_reset}",
                )

                fitted_ellipse_box = page.locator(
                    "#djf_scatter_plot .djf_scatter_gate_visible"
                ).bounding_box()
                page.locator("#djf_scatter_coverage").fill("80")
                page.wait_for_function(
                    """(sampleName) => Math.abs(
                      window.PhaseFinder.pipeline.get_state(sampleName)
                        ?.scatterGate?.manualOverride?.coverage - 0.8
                    ) < 1e-9""",
                    arg=sample_name,
                    timeout=10000,
                )
                resized_ellipse_box = page.locator(
                    "#djf_scatter_plot .djf_scatter_gate_visible"
                ).bounding_box()
                gate_resized = page.evaluate(
                    """(sampleName) => {
                      const state = window.PhaseFinder.pipeline.get_state(sampleName);
                      const row = window.PhaseFinder.app.get_parsed_files()
                        .find((candidate) => candidate.name === sampleName);
                      const result = state.scatterGate;
                      return {
                        mean: [...result.mainComponent.mean],
                        threshold: result.threshold,
                        coverage: result.manualOverride?.coverage,
                        retained: result.retainedEventCount,
                        rawMaskIsAuthoritative: row.data.masks.scatter === result.scatterMask,
                        filteredCount: row.data.filtered?.eventCount,
                        coverageLabel: document.querySelector('#djf_scatter_coverage_value')?.textContent,
                        caption: document.querySelector('#djf_scatter_caption')?.textContent,
                      };
                    }""",
                    sample_name,
                )
                ctx.check(
                    group,
                    "Changing Cell Gate coverage resizes the ellipse and applies its mask",
                    gate_resized["mean"] == gate_before["mean"]
                    and abs(gate_resized["threshold"] - (-2 * math.log(0.2))) < 1e-9
                    and abs(gate_resized["coverage"] - 0.8) < 1e-9
                    and gate_resized["retained"] < gate_before["retained"]
                    and gate_resized["rawMaskIsAuthoritative"]
                    and gate_resized["filteredCount"] == gate_resized["retained"]
                    and resized_ellipse_box["width"] < fitted_ellipse_box["width"]
                    and resized_ellipse_box["height"] < fitted_ellipse_box["height"]
                    and gate_resized["coverageLabel"] == "80.0%"
                    and "coverage 80.0%" in gate_resized["caption"],
                    f"before={gate_before}, resized={gate_resized}, boxes={fitted_ellipse_box, resized_ellipse_box}",
                )

                # Restore both the fitted center and fitted coverage before the
                # final translation used to exercise the Singlet Gate.
                page.click("#djf_scatter_reset")
                page.wait_for_function(
                    """(sampleName) =>
                      !window.PhaseFinder.pipeline.get_state(sampleName)
                        ?.scatterGate?.manualOverride""",
                    arg=sample_name,
                    timeout=10000,
                )

                # Leave a manual gate active so the Singlet Gate proves that
                # downstream processing consumes the edited mask rather than
                # the fitted one.
                center = page.locator("#djf_scatter_plot .djf_scatter_gate_center")
                center_box = center.bounding_box()
                page.mouse.move(
                    center_box["x"] + center_box["width"] / 2,
                    center_box["y"] + center_box["height"] / 2,
                )
                page.mouse.down()
                page.mouse.move(
                    center_box["x"] + center_box["width"] / 2 - 32,
                    center_box["y"] + center_box["height"] / 2,
                    steps=8,
                )
                page.mouse.up()
                page.wait_for_function(
                    """(sampleName) => Boolean(
                      window.PhaseFinder.pipeline.get_state(sampleName)
                        ?.scatterGate?.manualOverride
                    )""",
                    arg=sample_name,
                    timeout=10000,
                )
                page.click("#djf_scatter_modal_close")
                page.wait_for_selector("#djf_scatter_modal", state="hidden", timeout=10000)
            elif stage == 3:
                # Toggling the Singlet Gate on re-applies every checked QC
                # stage from scratch (apply_qc_selection resets all state
                # first), so the earlier manual scatter-gate drag doesn't
                # survive -- Cell Gate reruns fresh. Compare against that
                # fresh retained count rather than the stale dragged one.
                current_scatter_retained = page.evaluate(
                    """(sampleName) => window.PhaseFinder.pipeline
                      .get_state(sampleName).scatterGate?.retainedEventCount""",
                    sample_name,
                )
                ok = (summary["skipped"] is False and bool(summary["geometryMode"])
                      and 0 < summary["retained"] <= summary["fitted"]
                      and summary["maskLength"] == fixture["eventCount"]
                      and summary["fitted"] == current_scatter_retained)
                label = "Singlet Gate exercises pulse-geometry singlet gating"

            ctx.check(group, label, ok, str(summary))

        # --- Stage 4: no button of its own, rebuilt automatically ---
        _wait_for_histogram(page, sample_name)
        summary4 = _state_summary(page, sample_name, 4)
        ok4 = (summary4["bins"] >= 16 and summary4["countSum"] > 0
               and summary4["countSum"] == summary4["binnedCount"]
               and summary4["plotBins"] == summary4["bins"]
               and density_curve_count(page) == 1)
        ctx.check(group, "Histogram is automatically kept current and published to the plot", ok4, str(summary4))

        # --- Manual Stage 5-8 Dean-Jett-Fox modeling buttons ---
        for stage in range(5, 9):
            try:
                _run_stage(page, stage, sample_name)
            except Exception as error:
                ctx.check(group, f"Manual Stage {stage} button completes", False, str(error))
                return

            readout = _readout_text(page)
            ctx.check(
                group,
                f"Manual Stage {stage} button runs only its pipeline checkpoint",
                (not readout or f"Stage {stage}" in readout)
                and page.locator(f"#djf_stage{stage}").evaluate(
                    "button => button.classList.contains('djf_stage_complete')"
                ),
                readout.strip(),
            )

            summary = _state_summary(page, sample_name, stage)
            if stage == 5:
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
                readout_has_fractions = not readout or all(token in readout for token in ("1C", "S", "2C", "%"))
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

        # A user can turn an earlier QC gate back off after inspecting the
        # final report. Prove that both JS state and visual completion
        # markers are invalidated together, so stale fit/report output
        # cannot survive an upstream QC change.
        _run_qc_stage(page, 2, sample_name)  # toggles Cell Gate off
        invalidated = page.evaluate(
            """(sampleName) => {
              const state = window.PhaseFinder.pipeline.get_state(sampleName);
              const row = window.PhaseFinder.app.get_parsed_files()
                .find((candidate) => candidate.name === sampleName);
              const finalCount = row.data.masks.final
                ? Array.from(row.data.masks.final).reduce((sum, value) => sum + value, 0)
                : null;
              return {
                scatterGate: state.scatterGate,
                singletResult: state.singletResult,
                hasHistogram: Boolean(state.histogram),
                peaks: state.peaks,
                baseFit: state.baseFit,
                extendedFit: state.extendedFit,
                report: state.report,
                scatterMask: row.data.masks.scatter,
                singletMask: row.data.masks.singlet,
                finalCount,
                filteredCount: row.data.filtered?.eventCount,
                downstreamComplete: [5, 6, 7, 8]
                  .filter((stage) => document.querySelector(`#djf_stage${stage}`)
                    ?.classList.contains('djf_stage_complete')).length,
                fitPaths: document.querySelectorAll('.djf-fit-overlay').length,
              };
            }""",
            sample_name,
        )
        ctx.check(
            group,
            "Turning the Cell Gate filter off clears its own mask and every Stage 5-8 product",
            invalidated["scatterGate"] is None
            and invalidated["scatterMask"] is None
            and invalidated["peaks"] is None
            and invalidated["baseFit"] is None
            and invalidated["extendedFit"] is None
            and invalidated["report"] is None
            and invalidated["downstreamComplete"] == 0
            and fit_curve_count(page) == 0,
            str(invalidated),
        )
        # The Singlet Gate toggle was left on from earlier in the loop, so
        # apply_qc_selection() reapplies it fresh in the same cycle -- it does
        # not depend on Cell Gate having also run, just on whatever the
        # currently-checked stages produce.
        ctx.check(
            group,
            "A still-checked later QC stage reapplies fresh even when an earlier one is turned off",
            invalidated["singletResult"] is not None
            and invalidated["singletMask"] is not None,
            str(invalidated),
        )
        ctx.check(
            group,
            "The histogram is automatically rebuilt from the new (Cell-Gate-off) gated view, not left stale",
            invalidated["hasHistogram"],
            str(invalidated),
        )
        ctx.check(
            group,
            "Turning off an upstream gate rebuilds the compacted view from the new final mask",
            invalidated["filteredCount"] == invalidated["finalCount"]
            and invalidated["finalCount"] > 0,
            str(invalidated),
        )
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
            page.wait_for_selector("#djf_scatter_modal", state="hidden", timeout=10000)
    except Exception as error:
        ctx.check(group, "Pre-modeling QC + manual Stage 5-8 pipeline flow", False, str(error))
    finally:
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
        # Return the sidebar to file mode for the tests that follow.
        exit_modeling_mode(page)
        if previous_selection:
            restore_row_selection(page, previous_selection)
