#!/usr/bin/env python3
"""E2E coverage for the pre-modeling QC gates (0-3, driven by the #qc_stageN
toggle buttons) and the automatic Stage 4 histogram. Peak identification (the
workflow that replaced the old manual Stage 5-8 Dean-Jett-Fox buttons) is
covered by tests_modeling.py."""

import math

from helpers import (
    TestContext,
    confirm_time_qc_method,
    density_curve_count,
    enter_modeling_mode,
    exit_modeling_mode,
    fit_curve_count,
    isolate_first_plotted_sample,
    restore_row_selection,
    wait_for_overlay_hidden,
)

_QC_FILTER_IDS = ["qc_structural", "qc_time", "qc_cellgate", "qc_singlet"]


def _run_qc_stage(page, stage, sample_name):
    """Click a Pre-modeling QC toggle (0-3) and wait for it to apply. Toggles
    the button's current state (on -> off, off -> on) rather than assuming a
    direction, since apply_qc_selection() re-derives the checked set from
    every button's aria-pressed state, not from which one was just clicked."""
    selector = f"#{_QC_FILTER_IDS[stage]}"
    turning_on = page.eval_on_selector(selector, "e => e.getAttribute('aria-pressed') !== 'true'")
    page.click(selector)
    # Structural QC now requires an explicit ceiling review; accept the shown
    # defaults so the test exercises the same committed path as a user.
    if stage == 0 and turning_on:
        page.wait_for_selector("#structural_qc_modal:not([hidden])", timeout=10000)
        page.click("#structural_qc_apply")
        page.wait_for_selector("#structural_qc_modal", state="hidden", timeout=10000)
    # Turning Time QC on first asks which method to run; accept the default.
    if stage == 1 and turning_on:
        confirm_time_qc_method(page)
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
              lastRunIndex: state.lastRunIndex,
              eventCount: row.data.eventCount,
              retained: state.structuralQC?.retainedEventCount,
              maskLength: row.data.masks.structural?.length,
              finalLength: row.data.masks.final?.length,
            };
          }
          if (stage === 1) {
            return {
              lastRunIndex: state.lastRunIndex,
              skipped: state.timeQC?.skipped,
              bins: state.timeQC?.scoredBins?.length || 0,
              segments: state.timeQC?.segmentCount || 0,
              retained: state.timeQC?.retainedEventCount || 0,
              maskLength: row.data.masks.timeQC?.length || 0,
            };
          }
          if (stage === 2) {
            return {
              lastRunIndex: state.lastRunIndex,
              skipped: state.scatterGate?.skipped,
              components: state.scatterGate?.components?.length || 0,
              fitted: state.scatterGate?.fittedEventCount || 0,
              retained: state.scatterGate?.retainedEventCount || 0,
              maskLength: row.data.masks.scatter?.length || 0,
            };
          }
          if (stage === 3) {
            return {
              lastRunIndex: state.lastRunIndex,
              skipped: state.singletResult?.skipped,
              geometryMode: state.singletResult?.geometryMode,
              fitted: state.singletResult?.fittedEventCount || 0,
              retained: state.singletResult?.retainedSingletCount || 0,
              maskLength: row.data.masks.singlet?.length || 0,
            };
          }
          const histogram = state.histogram;
          return {
            lastRunIndex: state.lastRunIndex,
            bins: histogram?.x?.length || 0,
            countSum: histogram?.y?.reduce((sum, value) => sum + value, 0) || 0,
            binnedCount: histogram?.binnedCount || 0,
            plotBins: window.PhaseFinder.plot.get_histogram(sampleName)?.counts?.length || 0,
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
            "() => typeof window.PhaseFinder.pipeline?.run_operation === 'function'"
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
                page.eval_on_selector(f"#{_QC_FILTER_IDS[stage]}", "e => e.getAttribute('aria-pressed')") == "true",
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

                # Holding Shift while dragging the ellipse rotates it around its
                # center (a modifier held anywhere during the gesture, checked
                # once at drag start) instead of moving it.
                rotate_center = page.locator("#djf_scatter_plot .djf_scatter_gate_center")
                rotate_box = rotate_center.bounding_box()
                rotate_cx = rotate_box["x"] + rotate_box["width"] / 2
                rotate_cy = rotate_box["y"] + rotate_box["height"] / 2
                # mousedown lands exactly on the center handle (small hit
                # radius); the subsequent moves trace an arc around it, which
                # is what actually produces a rotation (a straight-line drag
                # starting from the center itself is degenerate).
                page.mouse.move(rotate_cx, rotate_cy)
                page.keyboard.down("Shift")
                page.mouse.down()
                page.mouse.move(rotate_cx + 60, rotate_cy, steps=4)
                page.mouse.move(rotate_cx, rotate_cy - 60, steps=8)
                page.mouse.up()
                page.keyboard.up("Shift")
                page.wait_for_function(
                    """(sampleName) => Math.abs(
                      window.PhaseFinder.pipeline.get_state(sampleName)
                        ?.scatterGate?.rotation ?? 0
                    ) > 1e-6""",
                    arg=sample_name,
                    timeout=10000,
                )
                gate_rotated = page.evaluate(
                    """(sampleName) => {
                      const result = window.PhaseFinder.pipeline.get_state(sampleName).scatterGate;
                      return {
                        mean: [...result.mainComponent.mean],
                        rotation: result.rotation,
                        manualRotation: result.manualOverride?.rotation,
                        retained: result.retainedEventCount,
                        source: result.gateSource,
                        caption: document.querySelector('#djf_scatter_caption')?.textContent,
                      };
                    }""",
                    sample_name,
                )
                ctx.check(
                    group,
                    "Shift-dragging the Cell Gate ellipse rotates it around its center and applies a new mask",
                    gate_rotated["mean"] == gate_resized["mean"]
                    and abs(gate_rotated["rotation"]) > 1e-6
                    and gate_rotated["manualRotation"] == gate_rotated["rotation"]
                    and gate_rotated["source"] == "manual"
                    and gate_rotated["retained"] != gate_resized["retained"]
                    and "rotation" in gate_rotated["caption"],
                    f"resized={gate_resized}, rotated={gate_rotated}",
                )

                # Restore the fitted center, coverage, and rotation before the
                # final translation used to exercise the Singlet Gate.
                page.click("#djf_scatter_reset")
                page.wait_for_function(
                    """(sampleName) =>
                      !window.PhaseFinder.pipeline.get_state(sampleName)
                        ?.scatterGate?.manualOverride""",
                    arg=sample_name,
                    timeout=10000,
                )
                gate_after_reset = page.evaluate(
                    """(sampleName) => window.PhaseFinder.pipeline
                      .get_state(sampleName).scatterGate.rotation""",
                    sample_name,
                )
                ctx.check(
                    group,
                    "Reset fitted gate also clears rotation back to zero",
                    gate_after_reset == 0,
                    f"rotation_after_reset={gate_after_reset}",
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

        pipeline_after = page.evaluate(
            "() => typeof window.PhaseFinder.pipeline?.run_operation === 'function'"
            " && typeof window.PhaseFinder.pipeline?.get_state === 'function'"
        )
        ctx.check(
            group,
            "Loaded pipeline is exposed through window.PhaseFinder.pipeline",
            pipeline_after is True,
            f"loaded={pipeline_after}",
        )

        # A user can turn an earlier QC gate back off after inspecting later
        # gates. Prove both JS state and the mask it drove are cleared together.
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
                scatterMask: row.data.masks.scatter,
                singletMask: row.data.masks.singlet,
                finalCount,
                filteredCount: row.data.filtered?.eventCount,
              };
            }""",
            sample_name,
        )
        ctx.check(
            group,
            "Turning the Cell Gate filter off clears its own mask",
            invalidated["scatterGate"] is None
            and invalidated["scatterMask"] is None
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
        ctx.check(group, "Pre-modeling QC gate flow", False, str(error))
    finally:
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
        # Return the sidebar to file mode for the tests that follow.
        exit_modeling_mode(page)
        if previous_selection:
            restore_row_selection(page, previous_selection)


# ---------------------------------------------------------------------------
# Time QC method selection: robust summary vs peak tracking
# ---------------------------------------------------------------------------

def _time_qc_state(page, sample_name):
    """The Stage 1 result the pipeline is currently holding for one sample."""
    return page.evaluate(
        """(sampleName) => {
          const state = window.PhaseFinder?.pipeline?.get_state?.(sampleName);
          const result = state?.timeQC;
          if (!result) return null;
          return {
            method: result.method || null,
            skipped: Boolean(result.skipped),
            algorithmVersion: result.algorithmVersion || null,
            retained: result.retainedEventCount ?? null,
            segments: Array.isArray(result.segmentResults) ? result.segmentResults.length : null,
            bins: result.binCount ?? null,
            warnings: (result.warnings || []).length,
          };
        }""",
        sample_name,
    )


def _set_time_qc(page, active):
    """Force the "2. Time" toggle to `active`, answering the method dialog when
    switching it on (turning it off never prompts)."""
    already = page.eval_on_selector("#qc_time", "e => e.getAttribute('aria-pressed') === 'true'")
    if already == active:
        return
    page.click("#qc_time")
    if active:
        confirm_time_qc_method(page)
    page.wait_for_function(
        "(expected) => (document.querySelector('#qc_time')?.getAttribute('aria-pressed') === 'true') === expected"
        " && !document.querySelector('#qc_time')?.disabled",
        arg=active, timeout=60000,
    )
    wait_for_overlay_hidden(page, timeout_ms=30000)


def test_time_qc_methods(ctx: TestContext):
    """The Time QC method dialog, and running both methods through Stage 1."""
    page = ctx.page
    group = "Time QC Methods"

    if page.query_selector("#plot_area svg") is None:
        ctx.warn(group, "Time QC methods", "Skipped: no plot is rendered")
        return

    previous_selection = None
    try:
        enter_modeling_mode(page)
        sample_name, previous_selection = isolate_first_plotted_sample(page)
        # Start from a known state: Time QC off, method back to the default.
        _set_time_qc(page, False)
        page.evaluate("() => window.PhaseFinder?.time_qc?.reset?.()")

        # The modal owns a draft: Reset and ordinary edits must remain invisible
        # to live/session state until Apply.
        page.evaluate(
            """async () => {
              const settings = await import('/js/analysis/time_qc_settings.js');
              settings.set_time_qc_state({
                robustSummaryOptions: { targetBinSize: 750, includeEventRateCheck: false },
                peakTrackingOptions: { includeEventRateCheck: true },
              });
            }"""
        )
        before_cancel = page.evaluate(
            r"""() => ({
              state: JSON.stringify(window.PhaseFinder.time_qc.state),
              section: window.PhaseFinder.session.collect_toml().match(/\[time_qc\][\s\S]*?(?=\n\[|$)/)?.[0],
            })"""
        )
        page.click("#qc_time")
        page.wait_for_selector("#time_qc_method_modal:not([hidden])", timeout=10000)
        page.click("#time_qc_method_reset")
        page.click("#time_qc_method_cancel")
        after_reset_cancel = page.evaluate(
            r"""() => ({
              state: JSON.stringify(window.PhaseFinder.time_qc.state),
              section: window.PhaseFinder.session.collect_toml().match(/\[time_qc\][\s\S]*?(?=\n\[|$)/)?.[0],
            })"""
        )
        ctx.check(
            group,
            "UI-01: Reset then Cancel preserves byte-identical Time QC configuration",
            after_reset_cancel == before_cancel,
            str(after_reset_cancel),
        )

        page.click("#qc_time")
        page.wait_for_selector("#time_qc_method_modal:not([hidden])", timeout=10000)
        event_rate_round_trip = page.evaluate(
            """() => {
              const eventRate = document.querySelector('#time_qc_event_rate');
              const robust = eventRate.checked;
              document.querySelector("input[value='peak-tracking']").click();
              const peak = eventRate.checked;
              document.querySelector("input[value='robust-summary']").click();
              return { robust, peak, robustAgain: eventRate.checked };
            }"""
        )
        page.fill("#time_qc_target_bin_size", "900")
        page.click("#time_qc_method_cancel")
        after_edit_cancel = page.evaluate("() => JSON.stringify(window.PhaseFinder.time_qc.state)")
        ctx.check(
            group,
            "UI-01: method A→B→A keeps independent event-rate drafts and edits→Cancel is atomic",
            event_rate_round_trip == {"robust": False, "peak": True, "robustAgain": False}
            and after_edit_cancel == before_cancel["state"],
            str(event_rate_round_trip),
        )
        page.evaluate(
            """() => {
              window.__timeQcDraftPromise = import('/js/analysis/time_qc_modal.js')
                .then(module => module.open_time_qc_method_modal({ applyLabel: 'Apply defaults' }));
            }"""
        )
        page.wait_for_selector("#time_qc_method_modal:not([hidden])", timeout=10000)
        page.click("#time_qc_method_reset")
        page.click("#time_qc_method_apply")
        page.wait_for_selector("#time_qc_method_modal", state="hidden", timeout=10000)
        reset_applied = page.evaluate("() => window.__timeQcDraftPromise")
        ctx.check(
            group,
            "UI-01: Reset then Apply atomically commits shipped defaults",
            reset_applied["robustSummaryOptions"]["targetBinSize"] == 500
            and reset_applied["peakTrackingOptions"]["minimumEventsPerBin"] == 150,
            str(reset_applied),
        )

        # Run All includes Time QC, so it must ask which Time method to use
        # before changing any gate state. Cancelling leaves the prior selection
        # untouched.
        before_run_all = page.eval_on_selector_all(
            ".qc_gate_button", "buttons => buttons.map(button => button.getAttribute('aria-pressed'))"
        )
        page.click("#qc_filter_all")
        page.wait_for_selector("#time_qc_method_modal:not([hidden])", timeout=10000)
        run_all_dialog = page.evaluate(
            """() => {
              const buttons = [...document.querySelectorAll('#time_qc_method_modal .stats_modal_actions button')];
              const gaps = buttons.slice(1).map((button, index) =>
                button.getBoundingClientRect().left - buttons[index].getBoundingClientRect().right
              );
              return {
                applyLabel: document.querySelector('#time_qc_method_apply')?.textContent.trim(),
                gateStates: [...document.querySelectorAll('.qc_gate_button')]
                  .map(button => button.getAttribute('aria-pressed')),
                minimumButtonGap: Math.min(...gaps),
              };
            }"""
        )
        ctx.check(
            group,
            "Run All asks for the Time QC method before changing QC gates",
            run_all_dialog["applyLabel"] == "Run All QC"
            and run_all_dialog["gateStates"] == before_run_all,
            str(run_all_dialog),
        )
        ctx.check(
            group,
            "The Time QC modal footer buttons have horizontal spacing",
            run_all_dialog["minimumButtonGap"] >= 10,
            str(run_all_dialog["minimumButtonGap"]),
        )
        page.click("#time_qc_method_cancel")
        page.wait_for_selector("#time_qc_method_modal", state="hidden", timeout=10000)

        page.click("#qc_filter_all")
        confirm_time_qc_method(page, "robust-summary")
        page.wait_for_function(
            "(name) => window.PhaseFinder?.pipeline?.get_state?.(name)?.timeQC?.method === 'robust-summary'",
            arg=sample_name, timeout=120000,
        )
        wait_for_overlay_hidden(page, timeout_ms=60000)
        run_all_result = page.evaluate(
            """(name) => ({
              executed: window.PhaseFinder.pipeline.get_state(name)?.timeQC?.method,
              displayed: document.querySelector('#time_qc_method_name')?.textContent.trim(),
              serialized: window.PhaseFinder.session.collect_toml().includes('method = "robust-summary"'),
            })""",
            sample_name,
        )
        ctx.check(
            group,
            "UI-01: Run All executes, displays, and serializes the chosen Time QC method",
            run_all_result == {
                "executed": "robust-summary",
                "displayed": "Robust summary QC",
                "serialized": True,
            },
            str(run_all_result),
        )
        page.click("#qc_filter_all")
        page.wait_for_function(
            "(name) => !window.PhaseFinder?.pipeline?.get_state?.(name)?.timeQC",
            arg=sample_name, timeout=60000,
        )
        wait_for_overlay_hidden(page, timeout_ms=60000)

        # --- the dialog itself ---
        page.click("#qc_time")
        page.wait_for_selector("#time_qc_method_modal:not([hidden])", timeout=10000)
        # Open the Advanced disclosure so the per-method settings blocks are
        # actually rendered -- checking the `hidden` property alone would miss a
        # CSS `display` rule overriding it, which is exactly how these blocks
        # once stayed visible for both methods at the same time.
        page.click("#time_qc_advanced summary")
        dialog = page.evaluate(
            """() => {
              const visible = (selector) => {
                const element = document.querySelector(selector);
                return Boolean(element && element.getClientRects().length);
              };
              return {
                methods: [...document.querySelectorAll("input[name='time_qc_method']")].map(i => i.value),
                checked: document.querySelector("input[name='time_qc_method']:checked")?.value,
                channels: [...document.querySelectorAll('#time_qc_channels input')]
                  .filter(i => i.checked).map(i => i.value),
                robustShown: visible('#time_qc_robust_settings'),
                peakShown: visible('#time_qc_peak_settings'),
              };
            }"""
        )
        ctx.check(
            group,
            "Turning on Time QC offers both the robust-summary and peak-tracking methods",
            dialog["methods"] == ["robust-summary", "peak-tracking"]
            and dialog["checked"] == "robust-summary",
            str(dialog),
        )
        ctx.check(
            group,
            "The dialog defaults to evaluating DNA-A, FSC-A and SSC-A",
            dialog["channels"] == ["DNA_A", "FSC_A", "SSC_A"],
            str(dialog["channels"]),
        )
        ctx.check(
            group,
            "Only the selected method's settings are shown",
            dialog["robustShown"] is True and dialog["peakShown"] is False,
            str(dialog),
        )

        page.fill("#time_qc_target_bin_size", "50.5")
        page.click("#time_qc_method_apply")
        ctx.check(
            group,
            "UI-01: invalid integer values keep the modal open and identify the field",
            page.is_visible("#time_qc_method_modal")
            and bool(page.eval_on_selector("#time_qc_target_bin_size", "input => input.validationMessage")),
            page.eval_on_selector("#time_qc_target_bin_size", "input => input.validationMessage"),
        )
        page.fill("#time_qc_target_bin_size", "500")

        # Selecting the other method swaps which settings block is shown.
        page.check("input[name='time_qc_method'][value='peak-tracking']")
        swapped = page.evaluate(
            """() => {
              const visible = (selector) => {
                const element = document.querySelector(selector);
                return Boolean(element && element.getClientRects().length);
              };
              return {
                robustShown: visible('#time_qc_robust_settings'),
                peakShown: visible('#time_qc_peak_settings'),
              };
            }"""
        )
        ctx.check(
            group,
            "Choosing peak-tracking swaps the visible settings block",
            swapped["robustShown"] is False and swapped["peakShown"] is True,
            str(swapped),
        )

        # --- cancel leaves the filter off ---
        page.click("#time_qc_method_cancel")
        page.wait_for_selector("#time_qc_method_modal", state="hidden", timeout=10000)
        wait_for_overlay_hidden(page, timeout_ms=10000)
        ctx.check(
            group,
            "Cancelling the method dialog leaves Time QC switched off",
            page.eval_on_selector("#qc_time", "e => e.getAttribute('aria-pressed')") == "false"
            and _time_qc_state(page, sample_name) is None,
            str(_time_qc_state(page, sample_name)),
        )

        # --- run the robust-summary method ---
        page.click("#qc_time")
        confirm_time_qc_method(page, "robust-summary")
        wait_for_overlay_hidden(page, timeout_ms=60000)
        page.wait_for_function(
            "(name) => Boolean(window.PhaseFinder?.pipeline?.get_state?.(name)?.timeQC)",
            arg=sample_name, timeout=60000,
        )
        robust = _time_qc_state(page, sample_name)
        ctx.check(
            group,
            "Applying the dialog runs Stage 1 with the robust-summary method",
            page.eval_on_selector("#qc_time", "e => e.getAttribute('aria-pressed')") == "true"
            and robust is not None and robust["method"] == "robust-summary",
            str(robust),
        )
        ctx.check(
            group,
            "The QC panel names the Time QC method that ran",
            page.is_visible("#time_qc_method_line")
            and page.inner_text("#time_qc_method_name").strip() == "Robust summary QC",
            page.inner_text("#time_qc_method_line").strip(),
        )
        summary = page.inner_text("#time_qc_summary")
        ctx.check(
            group,
            "The Time QC summary reports events evaluated, events removed and regions removed",
            page.is_visible("#time_qc_summary")
            and "Events evaluated" in summary
            and "Events removed" in summary
            and "Acquisition regions removed" in summary,
            " | ".join(line for line in summary.splitlines() if line.strip()),
        )

        # --- switch to peak tracking via "Change…" ---
        page.click("#time_qc_method_edit")
        page.wait_for_selector("#time_qc_method_modal:not([hidden])", timeout=10000)
        page.check("input[name='time_qc_method'][value='peak-tracking']")
        page.click("#time_qc_method_apply")
        page.wait_for_selector("#time_qc_method_modal", state="hidden", timeout=10000)
        page.wait_for_function(
            "(name) => window.PhaseFinder?.pipeline?.get_state?.(name)?.timeQC?.method === 'peak-tracking'",
            arg=sample_name, timeout=120000,
        )
        wait_for_overlay_hidden(page, timeout_ms=60000)
        peak = _time_qc_state(page, sample_name)
        ctx.check(
            group,
            "Change… re-runs Stage 1 with the peak-tracking method",
            peak is not None and peak["method"] == "peak-tracking"
            and peak["algorithmVersion"] == "peak-tracking-v2",
            str(peak),
        )
        ctx.check(
            group,
            "Peak-tracking Stage 1 returns acquisition-segment diagnostics",
            peak is not None and peak["skipped"] is False
            and peak["segments"] is not None and peak["segments"] >= 1
            and peak["bins"] is not None and peak["bins"] > 0,
            str(peak),
        )
        ctx.check(
            group,
            "The panel updates to name Peak-tracking QC",
            page.inner_text("#time_qc_method_name").strip() == "Peak-tracking QC",
            page.inner_text("#time_qc_method_line").strip(),
        )
        ctx.check(
            group,
            "Peak-tracking keeps the stable synthetic acquisition rather than gutting it",
            peak is not None and peak["retained"] is not None and peak["retained"] > 0,
            str(peak),
        )

        # --- the method is recorded in the session file ---
        session_text = page.evaluate(
            """() => {
              const collect = window.PhaseFinder?.session?.collect_toml;
              return typeof collect === 'function' ? collect() : null;
            }"""
        )
        if session_text:
            ctx.check(
                group,
                "The session file records the Time QC method and algorithm version",
                "[time_qc]" in session_text
                and 'method = "peak-tracking"' in session_text
                and 'algorithm_version = "peak-tracking-v2"' in session_text,
                next((line for line in session_text.splitlines() if "algorithm_version" in line), ""),
            )
        else:
            ctx.warn(group, "The session file records the Time QC method and algorithm version",
                     "No session collect hook exposed")

        # --- switching off ---
        # apply_qc_selection() is async, so wait on the state it clears rather
        # than on the progress overlay, which may not have appeared yet.
        page.click("#qc_time")
        page.wait_for_function(
            "(name) => !window.PhaseFinder?.pipeline?.get_state?.(name)?.timeQC",
            arg=sample_name, timeout=60000,
        )
        page.wait_for_selector("#time_qc_summary", state="hidden", timeout=30000)
        wait_for_overlay_hidden(page, timeout_ms=60000)
        ctx.check(
            group,
            "Switching Time QC off does not prompt, and clears the method line and summary",
            page.eval_on_selector("#qc_time", "e => e.getAttribute('aria-pressed')") == "false"
            and page.is_hidden("#time_qc_method_modal")
            and page.is_hidden("#time_qc_summary")
            and page.is_hidden("#time_qc_method_line"),
            f"pressed={page.eval_on_selector('#qc_time', 'e => e.getAttribute(\"aria-pressed\")')}",
        )
    except Exception as error:
        ctx.check(group, "Time QC method flow", False, str(error))
    finally:
        # Leave Time QC off and the method back on the default, so the modeling
        # tests that follow are not silently run through the slower method.
        if page.is_visible("#time_qc_method_modal"):
            page.eval_on_selector("#time_qc_method_cancel", "button => button.click()")
        if page.is_visible("#structural_qc_modal"):
            page.eval_on_selector("#structural_qc_cancel", "button => button.click()")
        try:
            _set_time_qc(page, False)
            page.evaluate("() => window.PhaseFinder?.time_qc?.reset?.()")
        except Exception:
            pass
        exit_modeling_mode(page)
        if previous_selection:
            restore_row_selection(page, previous_selection)
