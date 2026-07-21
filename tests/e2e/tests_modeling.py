#!/usr/bin/env python3
"""E2E coverage for the sidebar's Identify Peaks panel: automatic peak
detection, manual G1/G2 region editing (with inline validation), Reset, and
Accept. This replaced the old manual Stage 5-8 Dean-Jett-Fox buttons -- there
is currently no UI path to actually run a model against the reviewed regions
(that lands with the canonical Dean-Jett model), so this module stops at
region review."""

from helpers import (
    TestContext,
    enter_modeling_mode,
    exit_modeling_mode,
    isolate_first_plotted_sample,
    restore_row_selection,
    status_bar_text,
)


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


def _modeling_state(page, sample_name):
    return page.evaluate(
        """(sampleName) => {
          const state = window.PhaseFinder.pipeline?.get_state?.(sampleName);
          return state ? state.modeling : null;
        }""",
        sample_name,
    )


def _set_region_input(page, selector, value):
    """Sets a peak-region numeric input's value and fires a real 'change'
    event -- peak_review_ui.js commits edits on change, not input."""
    page.eval_on_selector(
        selector,
        "(el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }",
        str(value),
    )


def test_modeling(ctx: TestContext):
    page = ctx.page
    group = "Modeling"
    previous_selection = []

    try:
        sample_name, previous_selection = isolate_first_plotted_sample(page)
        enter_modeling_mode(page)
        _ensure_qc_applied(page)

        page.wait_for_function(
            "(sampleName) => Boolean(window.PhaseFinder?.pipeline?.get_state?.(sampleName)?.histogram)",
            arg=sample_name,
            timeout=15000,
        )

        ctx.check(
            group,
            "Identify Peaks shows the reviewed sample and enables Detect Peaks",
            page.eval_on_selector("#peak_review_focus", "e => e.textContent.trim()") == sample_name
            and not page.eval_on_selector("#detect_peaks_button", "e => e.disabled"),
        )

        page.click("#detect_peaks_button")
        page.wait_for_function(
            """(sampleName) => Boolean(
              window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection?.regions
            )""",
            arg=sample_name,
            timeout=30000,
        )

        modeling = _modeling_state(page, sample_name)
        regions = modeling["peakSelection"]["regions"]
        detection = modeling["peakDetection"]
        ok_detected = (
            regions["g1"]["left"] < regions["g1"]["right"] <= regions["g2"]["left"] < regions["g2"]["right"]
            and detection["status"] in ("detected", "low_confidence", "inferred_g2")
            and 0 <= detection["confidence"] <= 1
            and modeling["peakSelection"]["source"] == "automatic"
        )
        ctx.check(
            group,
            "Detect Peaks proposes an ordered, valid G1/G2 region pair",
            ok_detected,
            str({"regions": regions, "detection": detection}),
        )

        dom_regions = page.evaluate(
            """() => ({
              g1Left: Number(document.querySelector('#peak_region_g1_left').value),
              g1Right: Number(document.querySelector('#peak_region_g1_right').value),
              g2Left: Number(document.querySelector('#peak_region_g2_left').value),
              g2Right: Number(document.querySelector('#peak_region_g2_right').value),
              statusVisible: !document.querySelector('#peak_review_status').hidden,
              inputsEnabled: !document.querySelector('#peak_region_g1_left').disabled,
            })"""
        )
        ctx.check(
            group,
            "Sidebar region inputs reflect the detected regions and are enabled",
            abs(dom_regions["g1Left"] - regions["g1"]["left"]) < 0.01
            and abs(dom_regions["g1Right"] - regions["g1"]["right"]) < 0.01
            and abs(dom_regions["g2Left"] - regions["g2"]["left"]) < 0.01
            and abs(dom_regions["g2Right"] - regions["g2"]["right"]) < 0.01
            and dom_regions["statusVisible"]
            and dom_regions["inputsEnabled"],
            str(dom_regions),
        )

        # Dragging the G1 left handle on the plot leftward (toward the domain
        # minimum) commits a manual edit exactly like the sidebar inputs do,
        # keeping the plot overlay and the sidebar's numeric fields in sync.
        # G1 left is used rather than an interior/touching boundary: this
        # sample's low-confidence "inferred_g2" detection placed G1.right and
        # G2.left at the exact same position (a legitimate touching pair per
        # validatePeakRegions's L1 < R1 <= L2 < R2 rule), and G2.right exactly
        # at the plot's domain edge -- both invalid choices for a drag test,
        # since two boundary handles occupying the same pixel would make a
        # coordinate-based drag ambiguous, and the domain edge leaves no room
        # to move outward. G1 left has no such neighbor and is not pinned.
        handle = page.locator('#plot_area svg rect.peak_region_handle[data-boundary-key="g1_left"]')
        handle_box = handle.bounding_box()
        page.mouse.move(handle_box["x"] + handle_box["width"] / 2, handle_box["y"] + handle_box["height"] / 2)
        page.mouse.down()
        page.mouse.move(handle_box["x"] + handle_box["width"] / 2 - 40, handle_box["y"] + handle_box["height"] / 2, steps=8)
        page.mouse.up()
        page.wait_for_function(
            """(sampleName) => {
              const selection = window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection;
              return selection?.source === 'manual';
            }""",
            arg=sample_name,
            timeout=5000,
        )
        after_drag = _modeling_state(page, sample_name)
        dom_after_drag = page.evaluate(
            "() => Number(document.querySelector('#peak_region_g1_left').value)"
        )
        ctx.check(
            group,
            "Dragging a plot region handle commits a manual edit and syncs the sidebar",
            after_drag["peakSelection"]["source"] == "manual"
            and after_drag["peakSelection"]["regions"]["g1"]["left"] < regions["g1"]["left"]
            and abs(dom_after_drag - after_drag["peakSelection"]["regions"]["g1"]["left"]) < 0.01,
            str({"after_drag": after_drag["peakSelection"], "dom_g1_left": dom_after_drag}),
        )

        # Reset back to the automatic proposal before exercising the invalid/
        # valid manual-input-edit checks below, so they start from a known
        # (detected) baseline rather than the drag's result.
        page.click("#peak_regions_reset_button")
        page.wait_for_function(
            """(sampleName) => {
              const selection = window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection;
              return selection?.source === 'automatic';
            }""",
            arg=sample_name,
            timeout=5000,
        )

        # An invalid edit (G2 left dragged into the middle of the G1 region)
        # must be rejected: the sidebar shows an inline error and the stored
        # regions are untouched. Scaled to the G1 region's own width so this
        # is robust regardless of the DNA channel's absolute unit scale.
        invalid_g2_left = regions["g1"]["right"] - 0.5 * (regions["g1"]["right"] - regions["g1"]["left"])
        _set_region_input(page, "#peak_region_g2_left", invalid_g2_left)
        page.wait_for_function(
            "() => !document.querySelector('#peak_region_error').hidden",
            timeout=5000,
        )
        after_invalid = _modeling_state(page, sample_name)
        ctx.check(
            group,
            "An invalid region edit (L1 < R1 <= L2 < R2 broken) shows an inline error and leaves state untouched",
            page.eval_on_selector("#peak_region_error", "e => e.textContent.length > 0")
            and after_invalid["peakSelection"]["regions"] == regions,
            str(after_invalid["peakSelection"]["regions"]),
        )

        # Restoring G2 left to its original position is itself a valid edit:
        # it commits as manual, clears the error, and leaves the sidebar in a
        # known-good state for the next edit.
        _set_region_input(page, "#peak_region_g2_left", regions["g2"]["left"])
        page.wait_for_function(
            """(sampleName) => {
              const selection = window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection;
              return selection?.source === 'manual';
            }""",
            arg=sample_name,
            timeout=5000,
        )

        # A further valid edit (nudging G1 right partway into the G1/G2 gap,
        # never past G2 left) stays committed as manual and reviewed.
        widened_g1_right = regions["g1"]["right"] + 0.4 * (regions["g2"]["left"] - regions["g1"]["right"])
        _set_region_input(page, "#peak_region_g1_right", widened_g1_right)
        page.wait_for_function(
            """([sampleName, expected]) => {
              const selection = window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection;
              return Math.abs((selection?.regions?.g1?.right ?? NaN) - expected) < 0.01;
            }""",
            arg=[sample_name, widened_g1_right],
            timeout=5000,
        )
        after_valid = _modeling_state(page, sample_name)
        ctx.check(
            group,
            "A valid region edit commits as 'manual', marks reviewed, and clears the error",
            page.eval_on_selector("#peak_region_error", "e => e.hidden")
            and after_valid["peakSelection"]["source"] == "manual"
            and after_valid["peakSelection"]["reviewed"] is True
            and abs(after_valid["peakSelection"]["regions"]["g1"]["right"] - widened_g1_right) < 0.01,
            str(after_valid["peakSelection"]),
        )

        page.click("#peak_regions_reset_button")
        page.wait_for_function(
            """(sampleName) => {
              const selection = window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection;
              return selection?.source === 'automatic';
            }""",
            arg=sample_name,
            timeout=5000,
        )
        after_reset = _modeling_state(page, sample_name)
        ctx.check(
            group,
            "Reset restores the detector's automatic region proposal",
            after_reset["peakSelection"]["regions"] == after_reset["peakSelection"]["automaticRegions"]
            and after_reset["peakSelection"]["reviewed"] is False,
            str(after_reset["peakSelection"]),
        )

        page.click("#peak_regions_accept_button")
        page.wait_for_function(
            """(sampleName) => Boolean(
              window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection?.reviewed
            )""",
            arg=sample_name,
            timeout=5000,
        )
        ctx.check(
            group,
            "Accept marks the current regions as reviewed",
            _modeling_state(page, sample_name)["peakSelection"]["reviewed"] is True,
        )

        status_after = status_bar_text(page)
        ctx.check(
            group,
            "Peak-region actions report progress in the status bar",
            "accepted" in status_after.lower() or "peak" in status_after.lower(),
            status_after,
        )
    except Exception as error:
        ctx.check(group, "Identify Peaks region-review flow", False, str(error))
    finally:
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
        # Return the sidebar to file mode so later tests (e.g. Calculate
        # Statistics) can reach the file-mode action buttons again.
        exit_modeling_mode(page)
        if previous_selection:
            restore_row_selection(page, previous_selection)
