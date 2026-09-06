#!/usr/bin/env python3
"""E2E coverage for the sidebar's Identify Peaks and Model & Fit panels:
automatic peak detection, manual G1/G2 region editing (with inline
validation), Reset, Accept, and fitting a registered cell-cycle model
(Dean-Jett / Dean-Jett-Fox / Watson Pragmatic / Automatic) against the
reviewed regions. This replaced the old manual Stage 5-8 Dean-Jett-Fox
button strip."""

import re

from helpers import (
    TestContext,
    confirm_time_qc_method,
    enter_modeling_mode,
    exit_modeling_mode,
    isolate_first_plotted_sample,
    restore_row_selection,
    select_all_visible_rows,
    status_bar_text,
    wait_for_render,
    wait_for_overlay_hidden,
)

_QC_FILTER_IDS = ["qc_structural", "qc_time", "qc_cellgate", "qc_singlet"]


def _ensure_qc_applied(page):
    """Turn on every Pre-modeling QC gate that isn't already on, and wait for
    each to apply. Checks gates individually rather than using the combined
    #qc_filter_all toggle, since that button's click semantics (turn all on,
    or clear if already all on) depend on the current state."""
    for stage in range(4):
        selector = f"#{_QC_FILTER_IDS[stage]}"
        if page.eval_on_selector(selector, "e => e.getAttribute('aria-pressed')") != "true":
            page.click(selector)
            # Structural QC requires an explicit ceiling review.
            if stage == 0:
                page.wait_for_selector("#structural_qc_modal:not([hidden])", timeout=10000)
                page.click("#structural_qc_apply")
                page.wait_for_selector("#structural_qc_modal", state="hidden", timeout=10000)
            # Time QC asks which method to run when it is switched on.
            if stage == 1:
                confirm_time_qc_method(page)
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
        handle.focus()
        handle.press("ArrowLeft")
        handle.press("ArrowLeft")
        keyboard_state = _modeling_state(page, sample_name)
        ctx.check(
            group,
            "Repeated peak-slider arrow keys retain focus and synchronize the numeric input",
            page.evaluate("() => document.activeElement?.dataset?.boundaryKey === 'g1_left'")
            and keyboard_state["peakSelection"]["regions"]["g1"]["left"] < regions["g1"]["left"]
            and abs(page.eval_on_selector("#peak_region_g1_left", "e => Number(e.value)")
                    - keyboard_state["peakSelection"]["regions"]["g1"]["left"]) < 0.01,
            str(keyboard_state["peakSelection"]["regions"]),
        )
        page.click("#peak_regions_reset_button")
        page.wait_for_function(
            "(sampleName) => window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection?.source === 'automatic'",
            arg=sample_name,
            timeout=5000,
        )
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
        page.select_option("#cell_cycle_model_select", "watson_pragmatic")
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
            and page.eval_on_selector("#peak_region_g2_left", "e => e.getAttribute('aria-invalid') === 'true'")
            and page.eval_on_selector("#peak_regions_accept_button", "e => e.disabled")
            and page.eval_on_selector("#cell_cycle_fit_current_button", "e => e.disabled")
            and page.eval_on_selector("#cell_cycle_fit_all_button", "e => e.disabled")
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
            "Accept uses exactly the four displayed region boundaries",
            _modeling_state(page, sample_name)["peakSelection"]["reviewed"] is True
            and page.evaluate(
                """(name) => {
                  const r = window.PhaseFinder.pipeline.get_state(name).modeling.peakSelection.regions;
                  return Number(document.querySelector('#peak_region_g1_left').value) === r.g1.left
                    && Number(document.querySelector('#peak_region_g1_right').value) === r.g1.right
                    && Number(document.querySelector('#peak_region_g2_left').value) === r.g2.left
                    && Number(document.querySelector('#peak_region_g2_right').value) === r.g2.right;
                }""",
                sample_name,
            ),
        )

        status_after = status_bar_text(page)
        ctx.check(
            group,
            "Peak-region actions report progress in the status bar",
            "accepted" in status_after.lower() or "peak" in status_after.lower(),
            status_after,
        )

        # Model & Fit: pick a registered model and fit it against the
        # just-accepted regions. Watson Pragmatic first -- it makes no G2:G1-
        # ratio assumption, so it fits whatever regions the detector produced
        # (this sample's own low-confidence "inferred_g2" pair included --
        # see the drag-test comment above) without the biological-ratio
        # feasibility check the generative models apply.
        page.select_option("#cell_cycle_model_select", "watson_pragmatic")
        ctx.check(
            group,
            "Fit Current is enabled once regions are accepted",
            not page.eval_on_selector("#cell_cycle_fit_current_button", "e => e.disabled"),
        )

        page.click("#cell_cycle_fit_current_button")
        page.wait_for_function(
            "() => !document.querySelector('#cell_cycle_fit_result').hidden",
            timeout=30000,
        )
        fit_result_dom = page.evaluate(
            """() => ({
              header: document.querySelector('.cell_cycle_fit_result_header')?.textContent.trim(),
              convergence: document.querySelector('.cell_cycle_fit_convergence')?.textContent.trim(),
              fractionRows: Array.from(document.querySelectorAll('.cell_cycle_fit_fraction_row')).map(
                (row) => row.textContent.trim()
              ),
              warnings: document.querySelector('.cell_cycle_fit_warnings')?.textContent.trim(),
            })"""
        )
        modeling_after_fit = _modeling_state(page, sample_name)
        active_result = modeling_after_fit["resultsByKey"][modeling_after_fit["activeResultKey"]]
        ctx.check(
            group,
            "Fit Current fits Watson Pragmatic and renders a model-neutral phase-fraction summary",
            active_result["modelId"] == "watson_pragmatic"
            and isinstance(active_result["converged"], bool)
            and len(fit_result_dom["fractionRows"]) == 3
            and "G1" in fit_result_dom["fractionRows"][0]
            and "%" in fit_result_dom["fractionRows"][0],
            str({"active_result_fractions": active_result["phaseFractions"], "dom": fit_result_dom}),
        )
        provenance = active_result.get("histogramProvenance") or {}
        ctx.check(
            group,
            "A fit persists its exact analysis domain, bins, and underflow/overflow provenance",
            provenance.get("domain", {}).get("min") == modeling_after_fit["fitDomain"]["min"]
            and provenance.get("domain", {}).get("max") == modeling_after_fit["fitDomain"]["max"]
            and len(provenance.get("binEdges", [])) == len(provenance.get("counts", [])) + 1
            and isinstance(provenance.get("underflow"), (int, float))
            and isinstance(provenance.get("overflow"), (int, float)),
            str({"domain": provenance.get("domain"), "underflow": provenance.get("underflow"),
                 "overflow": provenance.get("overflow")}),
        )

        status_after_fit = status_bar_text(page)
        ctx.check(
            group,
            "Fitting a model reports progress in the status bar",
            "fit" in status_after_fit.lower(),
            status_after_fit,
        )

        # DOMAIN-01: the on-demand "Check domain sensitivity" action. It calls
        # assess_domain_sensitivity() (modeling_state.js) against the fit
        # already on screen rather than fitting anything new, and only appears
        # once a reportable result exists (refresh_panel() in modeling_ui.js),
        # which the fit above just put in place.
        ctx.check(
            group,
            "Check domain sensitivity appears once a fit result exists",
            not page.eval_on_selector("#cell_cycle_domain_sensitivity_button", "e => e.hidden"),
        )

        page.click("#cell_cycle_domain_sensitivity_button")
        # The sweep re-fits the sample ~12 times (bin count x domain
        # perturbation), so give it a generous timeout rather than the plain
        # fit's 30s.
        page.wait_for_function(
            "() => !document.querySelector('#cell_cycle_domain_sensitivity_status').hidden",
            timeout=60000,
        )
        domain_sensitivity_status_text = page.eval_on_selector(
            "#cell_cycle_domain_sensitivity_status", "e => e.textContent.trim()"
        )
        modeling_after_sensitivity = _modeling_state(page, sample_name)
        # An "invalid" verdict demotes activeResultKey to lastDiagnosticResultKey
        # (assess_domain_sensitivity()'s documented side effect), so the result
        # carrying the verdict may be filed under either key depending on what
        # this sample's real sweep found.
        sensitivity_result = next(
            (
                modeling_after_sensitivity["resultsByKey"][key]
                for key in (
                    modeling_after_sensitivity["activeResultKey"],
                    modeling_after_sensitivity["lastDiagnosticResultKey"],
                )
                if key and modeling_after_sensitivity["resultsByKey"].get(key, {}).get("domainSensitivity")
            ),
            None,
        )
        sensitivity_verdict = sensitivity_result["domainSensitivity"]["status"] if sensitivity_result else None
        ctx.check(
            group,
            "Clicking Check domain sensitivity runs the real sweep and shows its verdict on the result",
            sensitivity_result is not None
            and sensitivity_verdict in ("ok", "warning", "invalid")
            and domain_sensitivity_status_text.startswith("Domain sensitivity:")
            and sensitivity_verdict in domain_sensitivity_status_text
            and len(sensitivity_result["domainSensitivity"]["variants"]) == 12,
            str({"status_text": domain_sensitivity_status_text, "verdict": sensitivity_verdict}),
        )

        status_after_sensitivity = status_bar_text(page)
        ctx.check(
            group,
            "Checking domain sensitivity reports its outcome in the status bar",
            "domain sensitivity" in status_after_sensitivity.lower(),
            status_after_sensitivity,
        )

        # assess_domain_sensitivity() mutates the same result object it was
        # given (appends warnings, may flip its reporting verdict) -- exactly
        # the qualify/block behavior this action exists to exercise, but the
        # several checks below this point capture their own "active_result"
        # off the pre-sensitivity-check fit and expect it to still match what
        # is on screen. Re-fitting with the same model and (unchanged) regions
        # is deterministic and produces a fresh result with no
        # domainSensitivity mutation, restoring that match for the rest of
        # this sample's checks. build_result_key() (modeling_state.js) is a
        # pure content-based cache key, so the key itself does not change
        # across an identical re-fit -- wait on the mutation being gone
        # instead of on the key.
        page.click("#cell_cycle_fit_current_button")
        page.wait_for_function(
            """(name) => {
              const modeling = window.PhaseFinder.pipeline.get_state(name).modeling;
              const result = modeling.resultsByKey[modeling.activeResultKey];
              return Boolean(result) && !result.domainSensitivity;
            }""",
            arg=sample_name,
            timeout=30000,
        )

        result_key_before_view = page.evaluate(
            "(name) => window.PhaseFinder.pipeline.get_state(name).modeling.activeResultKey",
            sample_name,
        )
        page.click("#plot_tool_zoom_in")
        page.click("#plot_area svg")
        wait_for_render(page)
        result_key_after_view = page.evaluate(
            "(name) => window.PhaseFinder.pipeline.get_state(name).modeling.activeResultKey",
            sample_name,
        )
        ctx.check(
            group,
            "Viewport-only zoom leaves the scientific fit identity unchanged",
            result_key_after_view == result_key_before_view,
            str({"before": result_key_before_view, "after": result_key_after_view}),
        )
        page.click("#plot_tool_pan")
        page.click("#plot_tool_home")

        # The plot itself picks up the same active model-neutral result
        # (js/plotting/render.js's pipeline_fit_for_series()): the floating
        # on-plot results table shows the fitted G1/S/G2 percentages, and the
        # SVG gained filled component-overlay paths beyond the plain sample
        # curves/axes that were already there.
        page.wait_for_selector("#djf_fit_table:not([hidden])", timeout=15000)
        plot_overlay_dom = page.evaluate(
            """() => ({
              tableText: document.querySelector('#djf_fit_table')?.textContent || '',
              filledPathCount: Array.from(document.querySelectorAll('#plot_area svg path'))
                .filter((p) => p.getAttribute('fill') && p.getAttribute('fill') !== 'none').length,
              warningItems: Array.from(
                document.querySelectorAll('#djf_fit_table .djf_fit_warnings_list li')
              ).map((li) => li.textContent.trim()),
            })"""
        )
        table_g1_percent_match = re.search(r"G1\s*/\s*1C.*?(-?[\d.]+)%", plot_overlay_dom["tableText"], re.S)
        table_g1_percent = float(table_g1_percent_match.group(1)) if table_g1_percent_match else None
        # A loose (2-point) tolerance rather than an exact string match: the
        # on-plot table's percent comes from summing each component's
        # observed-domain (histogram-truncated) counts (render.js's
        # component_moments()), while phaseFractions comes from the model's
        # own true parameter areas -- close but not bit-identical whenever a
        # component's Gaussian tail extends past the histogram's edges.
        ctx.check(
            group,
            "Fitting a model draws its component overlay on the plot and populates the on-plot results table",
            table_g1_percent is not None
            and abs(table_g1_percent - active_result["phaseFractions"]["g1"] * 100) < 2.0
            and plot_overlay_dom["filledPathCount"] >= 3,
            str({**plot_overlay_dom, "parsedG1Percent": table_g1_percent, "resultG1Fraction": active_result["phaseFractions"]["g1"]}),
        )

        modeled_tree = page.locator("#plot_area").aria_snapshot()
        ctx.check(
            group,
            "UI-05D: browser accessibility tree exposes the modeled plot and phase fractions",
            "img" in modeled_tree
            and "watson pragmatic" in modeled_tree.lower()
            and all(phase in modeled_tree for phase in ("G1", "S", "G2/M")),
            modeled_tree,
        )

        # The actual fit warning messages (not just a count) render in the same
        # top-right overlay -- one list item per warning on the active result.
        result_warnings = active_result.get("warnings") or []
        ctx.check(
            group,
            "The fit's warning messages (if any) are listed in the on-plot overlay",
            len(plot_overlay_dom["warningItems"]) == len(result_warnings)
            and all(
                any(w["message"] in item for item in plot_overlay_dom["warningItems"])
                for w in result_warnings
            ),
            str({"overlayWarnings": plot_overlay_dom["warningItems"],
                 "resultWarnings": [w["message"] for w in result_warnings]}),
        )

        # The fit's phase fractions also populate the metadata table as a
        # per-model group: a "Watson Pragmatic" header over G1/S/G2-M sub-headers,
        # with the fitted sample's row carrying the percentages
        # (cell_cycle_columns.js). UI-01: an unconverged (or otherwise
        # untrusted) result's cell carries a trailing " ⚠" glyph
        # (format_fraction_cell()/fraction_trust_reason() in
        # cell_cycle_columns.js / result_contract.js) -- that glyph is
        # deliberate, tested, documented behavior, not noise, so the expected
        # text must allow for it rather than requiring a bare percentage.
        g1pct = f"{active_result['phaseFractions']['g1'] * 100:.1f}%"
        g1pct_untrusted = f"{g1pct} ⚠"
        columns_dom = page.wait_for_function(
            """({ g1pct, g1pctUntrusted }) => {
              const groups = [...document.querySelectorAll('#file_table th.cell_cycle_group_th')].map((e) => e.textContent.trim());
              const subs = [...document.querySelectorAll('#file_table th.cell_cycle_sub_th')].map((e) => e.textContent.trim());
              const cells = [...document.querySelectorAll('#file_table td.cell_cycle_td')]
                .map((e) => e.textContent.trim()).filter((t) => t.includes('%'));
              const ok = groups.includes('Watson Pragmatic')
                && subs.slice(0, 3).join(',') === 'G1,S,G2/M'
                && cells.some((c) => c === g1pct || c === g1pctUntrusted);
              return ok ? { groups, subs, cells } : null;
            }""",
            arg={"g1pct": g1pct, "g1pctUntrusted": g1pct_untrusted},
            timeout=15000,
        )
        columns_info = columns_dom.json_value()
        ctx.check(
            group,
            "Fit fractions populate a per-model G1/S/G2-M group in the metadata table",
            "Watson Pragmatic" in columns_info["groups"]
            and columns_info["subs"][:3] == ["G1", "S", "G2/M"]
            and any(c.endswith("%") or c.endswith("⚠") for c in columns_info["cells"]),
            str(columns_info),
        )

        # Compare every consumer against the same stored result while this
        # known-good single-sample Watson fit is still active.
        page.select_option("#plot_view_mode", "ridge")
        page.wait_for_selector("#plot_area .ridge_row", timeout=10000)
        cross_surface = page.evaluate("""async (sampleName) => {
          const exports = await import('./js/plotting/plot_export.js');
          const series = window.PhaseFinder.plot.series.find(item => item.name === sampleName);
          const modeling = window.PhaseFinder.pipeline.get_state(sampleName).modeling;
          const result = modeling.resultsByKey[modeling.activeResultKey];
          const badge = document.querySelector(`.ridge_row[data-sample-name="${CSS.escape(sampleName)}"] .ridge_badge`)?.textContent?.trim() || '';
          const table = document.querySelector(`#file_table tr[data-file-id="${CSS.escape(series.row.id)}"]`)?.textContent || '';
          const fractions = ['g1', 's', 'g2'].map(key => `${(result.phaseFractions[key] * 100).toFixed(1)}%`);
          const svg = new XMLSerializer().serializeToString(exports.exportable_plot_svg());
          const html = exports.build_analysis_report_html();
          return {
            activeResultKey: modeling.activeResultKey,
            badge,
            tableMatches: fractions.every(value => table.includes(value)),
            reportMatches: fractions.every(value => html.includes(value)),
            exportMatches: svg.includes(sampleName.replace(/\\.fcs$/i, '')) && svg.includes(badge),
          };
        }""", sample_name)
        ctx.check(
            group,
            "CI-10/UI-13: stored result, ridge badge, table fractions, and export labels agree",
            cross_surface["activeResultKey"] == modeling_after_fit["activeResultKey"]
            and bool(cross_surface["badge"])
            and cross_surface["tableMatches"]
            and cross_surface["reportMatches"]
            and cross_surface["exportMatches"],
            str(cross_surface),
        )
        page.select_option("#plot_view_mode", "overlay")
        wait_for_render(page)

        # Changing bins rebuilds the histogram and detector proposal. PEAK-01
        # only forbids silently PROMOTING a fresh *automatic* proposal to
        # reviewed/active -- this sample's regions are "manual" and already
        # "reviewed" (the Accept step above), and bin_settings_sync.js's
        # recalculate_all() deliberately refits a reviewed manual selection
        # against the rebuilt histogram rather than discarding it ("Reviewed
        # manual regions remain active and may be refit; a fresh automatic
        # proposal stays unreviewed and is never silently promoted by a
        # bin-count change"). detect_peak_regions() only resets `reviewed`
        # when it is REPLACING an automatic selection (peakSelection.source
        # === "automatic"), so a manual selection's `reviewed` flag survives
        # the bin change untouched, exactly as intended.
        bins_before = page.evaluate(
            "(name) => window.PhaseFinder.pipeline.get_state(name)?.histogram?.binCount",
            sample_name,
        )
        page.evaluate(
            """() => {
              const slider = document.querySelector('#plot_bins');
              slider.value = '2';  // BIN_STOPS index 2 -> 512 bins (default is 256)
              slider.dispatchEvent(new Event('input', { bubbles: true }));
              slider.dispatchEvent(new Event('change', { bubbles: true }));
            }"""
        )
        # Wait until the recalc has fully settled and the modal is hidden.
        page.wait_for_function(
            """(name) => {
              const state = window.PhaseFinder.pipeline.get_state(name);
              const modal = document.querySelector('#bin_recalc_modal');
              return state?.histogram?.binCount === 512
                && modal.hidden;
            }""",
            arg=sample_name,
            timeout=30000,
        )
        recalc_modeling = _modeling_state(page, sample_name)
        recalc_active = (
            recalc_modeling["resultsByKey"].get(recalc_modeling["activeResultKey"])
            if recalc_modeling["activeResultKey"]
            else None
        )
        bins_after = page.evaluate(
            "(name) => window.PhaseFinder.pipeline.get_state(name)?.histogram?.binCount",
            sample_name,
        )
        ctx.check(
            group,
            "Changing Bins rebuilds the histogram and refits a reviewed manual selection without resetting review",
            bins_before != 512
            and bins_after == 512
            and page.eval_on_selector("#plot_bins_value", "e => e.textContent") == "512"
            and recalc_active is not None
            and recalc_modeling["peakSelection"]["source"] == "manual"
            and recalc_modeling["peakSelection"]["reviewed"] is True
            and page.eval_on_selector("#bin_recalc_modal", "e => e.hidden") is True,
            str({"binsBefore": bins_before, "binsAfter": bins_after,
                 "reviewed": recalc_modeling["peakSelection"]["reviewed"],
                 "source": recalc_modeling["peakSelection"]["source"],
                 "hasActive": recalc_active is not None}),
        )

        # The Undo button appears after a bin-size recalc; one click reverts the
        # whole change from the snapshot taken before it (bin_settings_sync.js),
        # restoring the previous bin count and the sample's fit. The recommended
        # default is data-dependent, so assert against the captured value rather
        # than an obsolete fixed 256-bin assumption.
        undo_visible = page.eval_on_selector("#plot_bins_undo", "e => !e.hidden")
        page.click("#plot_bins_undo")
        page.wait_for_function(
            """(arg) => {
              const state = window.PhaseFinder.pipeline.get_state(arg.name);
              return state?.histogram?.binCount === arg.bins
                && document.querySelector('#plot_bins_undo').hidden
                && Boolean(state.modeling.activeResultKey)
                && state.modeling.activeResultKey.includes(`|${arg.bins}|`);
            }""",
            arg={"name": sample_name, "bins": bins_before},
            timeout=30000,
        )
        ctx.check(
            group,
            "Undo button reverts a bin-size change, restoring the previous bin count and fit",
            undo_visible
            and page.eval_on_selector("#plot_bins_value", "e => e.textContent") == str(bins_before)
            and not page.eval_on_selector("#cell_cycle_fit_result", "e => e.hidden"),
            f"undo_was_visible={undo_visible}",
        )

        # Dean-Jett assumes a biological ~2:1 G2:G1 ratio by default
        # (fitRatioRange [1.65, 2.25] -- dean_jett.js). The plan requires an
        # infeasible ratio to surface as a clear inline error instead of
        # hanging or silently fitting something meaningless ("If a
        # constraint is infeasible, disable Fit and explain it inline"),
        # enforced by assert_ratio_feasible()/projectMeansToFeasible()
        # throwing before the optimizer ever runs (shared.js). Relying on a
        # specific real FCS sample's own detected regions to coincidentally
        # land outside that band is fragile -- it drifts as peak-detection
        # and pedestal-subtraction logic changes elsewhere (MODEL-06/
        # MODEL-09 already moved this exact sample from "infeasible at 512
        # bins" to "feasible, just slow to converge"). Instead, force the
        # infeasibility directly and deterministically: keep the reviewed G1
        # region as-is and edit G2 down to a narrow window immediately
        # adjacent to G1's right edge (still a valid L1 < R1 <= L2 < R2
        # ordering) so its ratio to G1 is pinned near 1x -- below the 1.65x
        # floor for every (mu1, mu2) pair in the two regions, regardless of
        # the sample's absolute channel scale.
        # The window must also clear GATE-01's independent minimum-event-support
        # precondition (result_contract.js: MINIMUM_PEAK_SUPPORT_EVENTS, checked
        # in model_preflight() before the model ever runs) -- a window too
        # narrow to contain real events fails for THAT reason first, masking
        # the ratio check this test exists to exercise. Search outward from
        # G1's right edge over the sample's real histogram bins, accumulating
        # real event support one bin at a time, and stop at the first point
        # that both clears the event-support floor and is still ratio-
        # infeasible (there is plenty of room: for this geometry the ratio
        # stays infeasible until G2's right edge reaches roughly 8-9x G1's
        # span past G1's right edge, far beyond what a few real bins need).
        # window.CellCycleResultContract/CellCycleModelRegistry are only
        # attached on the unit-test harness page (tests/unit/test_harness.html)
        # -- the real app page e2e drives deliberately omits the model
        # registry from window.PhaseFinder (GATE-01's own enforced rule, see
        # tests/ci/test_gate_entry_points.py). Mirror the two source
        # constants directly instead: MINIMUM_PEAK_SUPPORT_EVENTS = 10
        # (result_contract.js) and fitRatioRange [1.65, 2.25] (dean_jett.js
        # DEFAULT_CONFIG), same as this test's own comment above already cites.
        infeasible_search = page.evaluate(
            """(name) => {
              const minEvents = 10;
              const [ratioMin, ratioMax] = [1.65, 2.25];
              const state = window.PhaseFinder.pipeline.get_state(name);
              const hist = state.histogram;
              const centers = hist.centers ?? hist.x;
              const counts = hist.counts ?? hist.y;
              const g1 = state.modeling.peakSelection.regions.g1;
              const g2Left = g1.right;
              const tail = centers
                .map((c, i) => ({ c, count: counts[i] }))
                .filter((b) => b.c > g2Left)
                .sort((a, b) => a.c - b.c);
              let support = 0;
              let g2Right = g2Left;
              for (const bin of tail) {
                support += bin.count;
                g2Right = bin.c;
                const mu1Lo = Math.max(g1.left, g2Left / ratioMax);
                const mu1Hi = Math.min(g1.right, g2Right / ratioMin);
                if (support >= minEvents) {
                  return { g2Left, g2Right, support, infeasible: mu1Lo > mu1Hi, exhausted: false };
                }
              }
              return { g2Left, g2Right, support, infeasible: false, exhausted: true };
            }""",
            sample_name,
        )
        current_regions = _modeling_state(page, sample_name)["peakSelection"]["regions"]
        infeasible_g2_left = infeasible_search["g2Left"]
        infeasible_g2_right = infeasible_search["g2Right"]
        page.select_option("#cell_cycle_model_select", "dean_jett")
        _set_region_input(page, "#peak_region_g2_left", infeasible_g2_left)
        _set_region_input(page, "#peak_region_g2_right", infeasible_g2_right)
        page.wait_for_function(
            """([sampleName, expected]) => {
              const selection = window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection;
              return Math.abs((selection?.regions?.g2?.right ?? NaN) - expected) < 0.01;
            }""",
            arg=[sample_name, infeasible_g2_right],
            timeout=5000,
        )
        page.click("#cell_cycle_fit_current_button")
        # Wait for the *new* status text specifically, not just visibility --
        # the status element is already visible from the Watson fit above and
        # would otherwise resolve immediately without waiting for this fit.
        try:
            page.wait_for_function(
                "() => (document.querySelector('#cell_cycle_fit_status')?.textContent || '').toLowerCase().includes('ratio')",
                timeout=15000,
            )
        except Exception:
            # Keep collecting the independent UI/browser checks below when a
            # scientific expectation fails instead of aborting the whole flow.
            pass
        status_text = page.eval_on_selector("#cell_cycle_fit_status", "e => e.textContent")
        ctx.check(
            group,
            "An infeasible ratio constraint surfaces a clear inline error instead of hanging",
            "ratio" in status_text.lower() and "g2" in status_text.lower(),
            str({"status_text": status_text, "regions": {
                "g1": current_regions["g1"],
                "g2": {"left": infeasible_g2_left, "right": infeasible_g2_right},
            }, "search": infeasible_search}),
        )

        # The sliver G2 region above was only meant to trip the ratio-feasibility
        # gate -- it's too narrow to contain any histogram bin centers, so any
        # model other than Dean-Jett (which throws before ever touching bin
        # data) would fail differently on it. Reset back to the automatic
        # proposal before the checks below reuse this sample.
        page.click("#peak_regions_reset_button")
        page.wait_for_function(
            """(sampleName) => {
              const selection = window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection;
              return selection?.source === 'automatic';
            }""",
            arg=sample_name,
            timeout=5000,
        )
        # Reset alone leaves the automatic proposal unreviewed --
        # fit_cell_cycle_model() gates on review, so accept it before the
        # Watson Pragmatic re-fit below.
        page.click("#peak_regions_accept_button")
        page.wait_for_function(
            """(sampleName) => Boolean(
              window.PhaseFinder.pipeline.get_state(sampleName)?.modeling?.peakSelection?.reviewed
            )""",
            arg=sample_name,
            timeout=5000,
        )

        # Session modeling persistence (recompute-on-reload). Runs last so its
        # region/source mutations don't perturb the assertions above. First put
        # a clean Watson fit back (Dean-Jett just failed), then verify the saved
        # config re-applies: collecting it and re-applying (as reload does, after
        # clearing the cached fit) restores the same fit by re-fitting from the
        # saved regions/model -- no serialized results. (modeling_session.js)
        page.select_option("#cell_cycle_model_select", "watson_pragmatic")
        page.click("#cell_cycle_fit_current_button")
        try:
            page.wait_for_function(
                """(name) => {
                  const m = window.PhaseFinder.pipeline.get_state(name)?.modeling;
                  return Boolean(m?.activeResultKey)
                    && m.resultsByKey[m.activeResultKey]?.modelId === 'watson_pragmatic';
                }""",
                arg=sample_name,
                timeout=30000,
            )
        except Exception as error:
            # Diagnose rather than let this surface as an opaque catch-all
            # timeout: capture exactly what the modeling state, fit status,
            # and fit button looked like at the moment the wait gave up.
            diagnostic = page.evaluate(
                """(name) => {
                  const m = window.PhaseFinder.pipeline.get_state(name)?.modeling;
                  const button = document.querySelector('#cell_cycle_fit_current_button');
                  const select = document.querySelector('#cell_cycle_model_select');
                  return {
                    activeResultKey: m?.activeResultKey ?? null,
                    resultKeys: m ? Object.keys(m.resultsByKey || {}) : null,
                    activeModelId: m?.activeResultKey ? (m.resultsByKey[m.activeResultKey]?.modelId ?? null) : null,
                    settingsModelId: m?.settings?.modelId ?? null,
                    peakSelectionSource: m?.peakSelection?.source ?? null,
                    peakSelectionStale: m?.peakSelection?.stale ?? null,
                    fitStatusText: document.querySelector('#cell_cycle_fit_status')?.textContent ?? null,
                    buttonDisabled: button ? button.disabled : null,
                    selectValue: select ? select.value : null,
                  };
                }""",
                sample_name,
            )
            raise AssertionError(
                f"Watson Pragmatic re-fit after reset never reached activeResultKey: {diagnostic}"
            ) from error
        restore_result = page.evaluate(
            """async (name) => {
              const config = window.PhaseFinder.session.collect_modeling();
              const state = window.PhaseFinder.pipeline.get_state(name);
              // Simulate the post-reload starting point: no cached fit.
              state.modeling.resultsByKey = {};
              state.modeling.activeResultKey = null;
              const summary = await window.PhaseFinder.session.apply_modeling(config);
              const after = window.PhaseFinder.pipeline.get_state(name).modeling;
              const active = after.activeResultKey ? after.resultsByKey[after.activeResultKey] : null;
              return {
                summary,
                savedSample: config.samples.find((s) => s.name === name) || null,
                activeModel: active ? active.modelId : null,
                g1: active && active.phaseFractions ? active.phaseFractions.g1 : null,
              };
            }""",
            sample_name,
        )
        ctx.check(
            group,
            "Saved modeling config re-applies (recompute-on-reload) and restores the fit",
            restore_result["savedSample"] is not None
            and restore_result["savedSample"]["model"] == "watson_pragmatic"
            and restore_result["summary"]["restored"] == 1
            and restore_result["activeModel"] == "watson_pragmatic"
            and isinstance(restore_result["g1"], (int, float)),
            str(restore_result),
        )

        # STATE-01 box 1: restoring an UNREVIEWED saved sample must restore the
        # reviewed flag faithfully (stay false) and must not silently accept/refit
        # the regions -- exercised against the real apply_modeling_session(), not
        # a stand-in, since that is the actual restore path a reload takes.
        unreviewed_restore_result = page.evaluate(
            """async (name) => {
              const config = window.PhaseFinder.session.collect_modeling();
              const sample = config.samples.find((s) => s.name === name);
              sample.reviewed = false;  // simulate a saved-but-never-reviewed session
              const state = window.PhaseFinder.pipeline.get_state(name);
              state.modeling.resultsByKey = {};
              state.modeling.activeResultKey = null;
              state.modeling.peakSelection.reviewed = false;
              const summary = await window.PhaseFinder.session.apply_modeling(config);
              const after = window.PhaseFinder.pipeline.get_state(name).modeling;
              return {
                summary,
                reviewedAfter: after.peakSelection.reviewed,
                resultCount: Object.keys(after.resultsByKey || {}).length,
              };
            }""",
            sample_name,
        )
        ctx.check(
            group,
            "STATE-01: restoring an unreviewed saved sample leaves it unreviewed and does not refit",
            unreviewed_restore_result["summary"]["restored"] == 1
            and unreviewed_restore_result["reviewedAfter"] is not True
            and unreviewed_restore_result["resultCount"] == 0,
            str(unreviewed_restore_result),
        )

        # STATE-01 box 2: on restore, a saved model_version that no longer matches
        # the current implementation's version must label the recomputed result as
        # NEW, not as a reproduction of the saved values -- exercised through the
        # real apply_modeling_session() restore path, not a copy of its logic.
        drift_restore_result = page.evaluate(
            """async (name) => {
              const config = window.PhaseFinder.session.collect_modeling();
              const sample = config.samples.find((s) => s.name === name);
              sample.reviewed = true;
              sample.model_version = '0.0.1-state01-drift-probe';
              const state = window.PhaseFinder.pipeline.get_state(name);
              state.modeling.resultsByKey = {};
              state.modeling.activeResultKey = null;
              state.modeling.peakSelection.reviewed = true;
              await window.PhaseFinder.session.apply_modeling(config);
              const after = window.PhaseFinder.pipeline.get_state(name).modeling;
              const active = after.activeResultKey ? after.resultsByKey[after.activeResultKey] : null;
              return {
                reproduction: active ? active.reproduction : null,
                warningCodes: active ? (active.warnings || []).map((w) => w.code) : [],
              };
            }""",
            sample_name,
        )
        ctx.check(
            group,
            "STATE-01: restoring a version-drifted saved model labels the result recomputed_new, carrying a warning",
            drift_restore_result["reproduction"] is not None
            and drift_restore_result["reproduction"]["status"] == "recomputed_new"
            and drift_restore_result["reproduction"]["savedModelVersion"] == "0.0.1-state01-drift-probe"
            and "model_version_drift" in drift_restore_result["warningCodes"],
            str(drift_restore_result),
        )

        # A deliberate scientific-domain change recomputes the modeling
        # histogram; ordinary display bounds and viewport gestures do not.
        x_range_result = page.evaluate(
            """async (name) => {
              const hist = window.PhaseFinder.pipeline.get_state(name).histogram;
              const fullMin = hist.min, fullMax = hist.max;
              const span = fullMax - fullMin;
              const newMin = fullMin + span * 0.2;
              const newMax = fullMax - span * 0.2;
              const data = await import('./js/plotting/data.js');
              const previousKey = window.PhaseFinder.pipeline.get_state(name).modeling.activeResultKey;
              data.set_analysis_domain_override(newMin, newMax);
              document.dispatchEvent(new CustomEvent('pf-analysis-domain-changed'));
              return { fullMin, fullMax, newMin, newMax, previousKey };
            }""",
            sample_name,
        )
        page.wait_for_function(
            """(arg) => {
              const hist = window.PhaseFinder.pipeline.get_state(arg.name)?.histogram;
              return hist && Math.abs(hist.min - arg.newMin) < 1e-6
                && Math.abs(hist.max - arg.newMax) < 1e-6
                && document.querySelector('#bin_recalc_modal').hidden;
            }""",
            arg={"name": sample_name, "newMin": x_range_result["newMin"], "newMax": x_range_result["newMax"]},
            timeout=30000,
        )
        histogram_after = page.evaluate(
            """(name) => {
              const state = window.PhaseFinder.pipeline.get_state(name);
              return { min: state.histogram.min, max: state.histogram.max,
                resultKey: state.modeling.activeResultKey };
            }""",
            sample_name,
        )
        ctx.check(
            group,
            "Narrowing the analysis domain excludes out-of-range events from the modeling histogram",
            abs(histogram_after["min"] - x_range_result["newMin"]) < 1e-6
            and abs(histogram_after["max"] - x_range_result["newMax"]) < 1e-6
            and x_range_result["newMin"] > x_range_result["fullMin"]
            and x_range_result["newMax"] < x_range_result["fullMax"]
            and histogram_after["resultKey"] != x_range_result["previousKey"],
            str({"after": histogram_after, "requested": x_range_result}),
        )

        # Bulk auto-fit previews its inclusion/exclusion decision. Only strong
        # detections on proven-compatible DNA axes share robust median regions;
        # weak/incompatible samples are still fit, but independently.
        page.evaluate(
            """async () => {
              const data = await import('./js/plotting/data.js');
              data.set_analysis_domain_override(null, null);
            }"""
        )
        # Exercise the real bulk-selection control. Dispatching change on a
        # captured NodeList of row checkboxes is brittle because the first
        # selection notification may rebuild the table and detach the rest.
        select_all_visible_rows(page)
        page.wait_for_function("() => (window.PhaseFinder.plot.series || []).length >= 2", timeout=30000)
        page.select_option("#cell_cycle_model_select", "watson_pragmatic")
        page.once("dialog", lambda dialog: dialog.accept())
        page.click("#cell_cycle_fit_all_button")
        page.wait_for_selector("#progress_overlay:not([hidden])", timeout=5000)
        checkbox = page.locator("#file_table tbody .row_select").first
        blocked_selection_change = {
            "before": checkbox.is_checked(),
            "appInert": page.eval_on_selector("main.app", "main => main.inert"),
        }
        try:
            checkbox.click(timeout=250)
            blocked_selection_change["trustedClickBlocked"] = False
        except Exception:
            blocked_selection_change["trustedClickBlocked"] = True
        blocked_selection_change["after"] = checkbox.is_checked()
        page.wait_for_function(
            """() => /^Auto-fit /.test(
              document.querySelector('#status_bar_message')?.textContent || '')""",
            timeout=90000,
        )
        bulk = page.evaluate(
            """() => {
              const names = window.PhaseFinder.plot.series.map((s) => s.name);
              const attempts = names.map((n) => {
                const m = window.PhaseFinder.pipeline.get_state(n).modeling;
                return { result: m.resultsByKey[m.activeResultKey] || null, error: m.lastFitError || null };
              });
              return {
                count: names.length,
                attempted: attempts.filter(({ result, error }) => result || error).length,
                modes: attempts.filter(({ result }) => result).map(({ result }) => result.bulkRegionProvenance?.mode || null),
                allSuccessfulHaveEvidence: attempts.every(({ result }) =>
                  !result || result.bulkRegionProvenance?.calibrationEvidence),
              };
            }"""
        )
        ctx.check(
            group,
            "Fit All Samples previews safe sharing, fits every sample, and records calibration provenance",
            bulk["count"] >= 2
            and bulk["attempted"] == bulk["count"]
            and bulk["allSuccessfulHaveEvidence"] is True
            and all(mode in ("shared_median_normalized", "independent") for mode in bulk["modes"]),
            str(bulk),
        )
        ctx.check(
            group,
            "UI-11: a fit-all operation blocks a rapid selection change until its inputs are safe",
            blocked_selection_change["appInert"]
            and blocked_selection_change["trustedClickBlocked"]
            and blocked_selection_change["after"] == blocked_selection_change["before"],
            str(blocked_selection_change),
        )

        # Regression for todo.md #2 ("Auto-Fit All ... doesn't add the values for
        # each sample to the table"): a bulk fit dispatches cell-cycle-fit-changed
        # like a single fit, so cell_cycle_columns.js must populate the Watson
        # G1/S/G2-M cells for EVERY plotted sample's row, not just the active one.
        try:
            table_fill = page.wait_for_function(
                """(want) => {
                  const rows = [...document.querySelectorAll('#file_table tbody tr')];
                  const filled = rows.filter((tr) =>
                    [...tr.querySelectorAll('td.cell_cycle_td')].some((td) => td.textContent.includes('%'))
                  ).length;
                  return filled >= want ? { filled } : null;
                }""",
                arg=len(bulk["modes"]),
                timeout=30000,
            )
            table_fill_detail = table_fill.json_value()
        except Exception as error:
            table_fill_detail = page.evaluate(
                """async () => {
                  const rows = [...document.querySelectorAll('#file_table tbody tr')];
                  const filled = rows.filter((tr) =>
                    [...tr.querySelectorAll('td.cell_cycle_td')].some((td) => td.textContent.includes('%'))
                  ).length;
                  const names = window.PhaseFinder.plot.series.map((s) => s.name);
                  const pipelineStateModule = await import('./js/analysis/pipeline/pipeline_state.js');
                  const perSample = names.map((name) => {
                    const modeling = window.PhaseFinder.pipeline.get_state(name)?.modeling;
                    const result = modeling?.activeResultKey ? modeling.resultsByKey[modeling.activeResultKey] : null;
                    const gated = pipelineStateModule.get_active_model_result(pipelineStateModule.get_state(name));
                    return {
                      name,
                      activeResultKey: modeling?.activeResultKey ?? null,
                      hasPhaseFractions: Boolean(result?.phaseFractions),
                      modelId: result?.modelId ?? null,
                      validForReporting: result?.validForReporting ?? null,
                      contractVersion: result?.contractVersion ?? null,
                      gatedReportable: Boolean(gated),
                    };
                  });
                  const frame = window.PhaseFinder.app.get_file_table();
                  const frameCols = frame ? frame.columns.filter((c) => c.startsWith('cellCycleFit:') || c === 'Cell-Cycle Fit Status') : null;
                  const rawCellTexts = [...document.querySelectorAll('#file_table tbody tr')]
                    .map((tr) => ({
                      name: tr.querySelector('.filename_cell')?.textContent?.trim() ?? null,
                      cells: [...tr.querySelectorAll('td.cell_cycle_td')].map((td) => JSON.stringify(td.textContent)),
                    }))
                    .filter((r) => r.cells.length);
                  const dataModule = await import('./js/plotting/data.js');
                  const plottableNames = dataModule.plottable_rows().map((r) => r.name);
                  const selectedNames = window.PhaseFinder.app.get_selected_files().map((f) => f.name);
                  const columns = await import('./js/ui/cell_cycle_columns.js');
                  columns.update_cell_cycle_fraction_columns();
                  const filledAfterManualCall = [...document.querySelectorAll('#file_table tbody tr')].filter((tr) =>
                    [...tr.querySelectorAll('td.cell_cycle_td')].some((td) => td.textContent.includes('%'))
                  ).length;
                  return { filled, error: true, perSample, frameCols, plottableNames, selectedNames, rawCellTexts, filledAfterManualCall };
                }"""
            )
            table_fill_detail["exception"] = str(error)
        ctx.check(
            group,
            "Fit All Samples writes each fitted sample's fractions into its own table row",
            table_fill_detail.get("filled", 0) >= len(bulk["modes"]) and not table_fill_detail.get("error"),
            str({"table_fill": table_fill_detail, "bulk": bulk}),
        )

        # A bulk fit auto-switches the plot to the Ridge view: one stacked
        # small-multiple per plotted sample, each with a state-derived badge
        # and its own histogram, in a scrollable container (render.js Phase 1).
        ridge = page.evaluate(
            """() => {
              const container = document.querySelector('#plot_area .ridge_container');
              const rows = [...document.querySelectorAll('#plot_area .ridge_row')];
              const badges = [...document.querySelectorAll('#plot_area .ridge_row .ridge_badge')];
              return {
                mode: document.querySelector('#plot_view_mode').value,
                hasContainer: Boolean(container),
                rowCount: rows.length,
                badgeCount: badges.length,
                badgeReasonsPresent: badges.every(badge => Boolean(badge.title)),
                badgeStates: badges.map(badge => badge.textContent.trim()),
                svgPaths: document.querySelectorAll('#plot_area .ridge_row svg path').length,
              };
            }"""
        )
        ctx.check(
            group,
            "A bulk fit switches to the Ridge view with a per-sample badge and histogram row each",
            ridge["mode"] == "ridge"
            and ridge["hasContainer"] is True
            and ridge["rowCount"] == bulk["count"]
            and ridge["badgeCount"] == bulk["count"]
            and ridge["badgeReasonsPresent"] is True
            and ridge["svgPaths"] >= bulk["count"],
            str(ridge),
        )

        # In-place editing: dragging a G1 boundary handle in the ridge (no
        # blow-up) edits that sample's region and re-fits it. The first
        # .ridge_region_hit is the G1-left boundary; drag it left and assert the
        # region moved, went "manual", and the sample still has a fit.
        wait_for_overlay_hidden(page, timeout_ms=30000)
        page.wait_for_selector("#plot_area .ridge_row .ridge_region_hit", state="visible", timeout=10000)
        wait_for_render(page)
        region_before = page.evaluate(
            """() => {
              const name = window.PhaseFinder.plot.series[0].name;
              const regions = window.PhaseFinder.pipeline.get_state(name).modeling.peakSelection.regions;
              return { name, g1left: regions.g1.left };
            }"""
        )
        hit = page.query_selector("#plot_area .ridge_row .ridge_region_hit")
        hit_box = hit.bounding_box()
        page.mouse.move(hit_box["x"] + hit_box["width"] / 2, hit_box["y"] + hit_box["height"] / 2)
        page.mouse.down()
        page.mouse.move(hit_box["x"] - 25, hit_box["y"] + hit_box["height"] / 2, steps=6)
        page.mouse.up()
        page.wait_for_function(
            """(arg) => {
              const state = window.PhaseFinder.pipeline.get_state(arg.name);
              const regions = state.modeling.peakSelection.regions;
              return regions.g1.left < arg.g1left - 1e-6
                && state.modeling.peakSelection.source === 'manual'
                && Boolean(state.modeling.activeResultKey);
            }""",
            arg=region_before,
            timeout=30000,
        )
        region_after = page.evaluate(
            """(name) => {
              const state = window.PhaseFinder.pipeline.get_state(name);
              return {
                g1left: state.modeling.peakSelection.regions.g1.left,
                source: state.modeling.peakSelection.source,
                hasFit: Boolean(state.modeling.activeResultKey),
              };
            }""",
            region_before["name"],
        )
        ctx.check(
            group,
            "Dragging a G1 boundary in the ridge edits that sample's region in place and re-fits",
            region_after["g1left"] < region_before["g1left"]
            and region_after["source"] == "manual"
            and region_after["hasFit"] is True,
            str({"before": region_before, "after": region_after}),
        )

        # The same four boundaries are available as native number inputs, so
        # keyboard/touch users do not need to manipulate SVG geometry.
        numeric_editor = page.locator("#plot_area .ridge_row .ridge_region_numeric").first
        numeric_editor.locator("summary").click()
        numeric_before = float(numeric_editor.locator("input[name='g1_left']").input_value())
        numeric_right = float(numeric_editor.locator("input[name='g1_right']").input_value())
        numeric_target = (numeric_before + numeric_right) / 2
        numeric_editor.locator("input[name='g1_left']").fill(str(numeric_target))
        numeric_editor.locator("input[name='g1_left']").press("Enter")
        page.wait_for_function(
            """(arg) => Math.abs(window.PhaseFinder.pipeline.get_state(arg.name).modeling.peakSelection.regions.g1.left - arg.value) < 1e-6""",
            arg={"name": region_before["name"], "value": numeric_target},
            timeout=30000,
        )
        ctx.check(
            group,
            "UI-13: native numeric controls edit every ridge boundary by keyboard",
            numeric_editor.locator("input").count() == 4,
            f"g1_left={numeric_target}",
        )

        # Phase 2: a per-row Review blows that sample up to the full plot (badge
        # "Under manual review", Accept button, ridge hidden, only that sample
        # rendered); Accept returns to the ridge (render.js review flow).
        page.click("#plot_area .ridge_row .ridge_review_button")
        page.wait_for_selector(".ridge_review_bar", timeout=10000)
        blowup = page.evaluate(
            """() => ({
              reviewBadge: (document.querySelector('.ridge_badge_review') || {}).textContent,
              hasAccept: Boolean(document.querySelector('.ridge_review_accept')),
              seriesCount: (window.PhaseFinder.plot.series || []).length,
              ridgeHidden: !document.querySelector('#plot_area .ridge_container'),
            })"""
        )
        ctx.check(
            group,
            "Review blows a ridge sample up to the full plot for manual editing",
            blowup["reviewBadge"] == "Under manual review"
            and blowup["hasAccept"] is True
            and blowup["seriesCount"] == 1
            and blowup["ridgeHidden"] is True,
            str(blowup),
        )
        page.click(".ridge_review_accept")
        page.wait_for_selector("#plot_area .ridge_container", timeout=10000)
        back_to_ridge = page.evaluate(
            "() => ({ rows: document.querySelectorAll('#plot_area .ridge_row').length,"
            " barGone: !document.querySelector('.ridge_review_bar') })"
        )
        ctx.check(
            group,
            "Accept returns from the blow-up to the ridge view",
            back_to_ridge["rows"] == bulk["count"] and back_to_ridge["barGone"] is True,
            str(back_to_ridge),
        )

        # Return to Overlay so the propagate check below runs against the normal plot.
        page.select_option("#plot_view_mode", "overlay")

        # Propagate ("Apply to All"): focus one sample, nudge its G1-left to a
        # distinct value, then copy that sample's regions to every plotted sample
        # and re-fit. Every sample should end up with the focused sample's exact
        # (edited) G1-left -- distinguishing it from the averaged regions above.
        focus = page.evaluate(
            "() => ({ name: window.PhaseFinder.plot.series[0].name, id: window.PhaseFinder.plot.series[0].row.id })"
        )
        page.eval_on_selector(
            f'#file_table tbody tr[data-file-id="{focus["id"]}"] .filename_cell',
            "el => el.click()",
        )
        page.wait_for_selector("#peak_regions_apply_all_button:not([disabled])", timeout=15000)
        new_left = page.evaluate(
            """() => {
              const input = document.querySelector('#peak_region_g1_left');
              const g1left = parseFloat(input.value);
              const g1right = parseFloat(document.querySelector('#peak_region_g1_right').value);
              // Nudge left by 10% of the G1 width -- stays positive and < G1 right
              // regardless of the DNA-A scale, so the region edit is always valid.
              const value = g1left - (g1right - g1left) * 0.1;
              input.value = String(value);
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return value;
            }"""
        )
        page.once("dialog", lambda dialog: dialog.accept())
        page.click("#peak_regions_apply_all_button")
        page.wait_for_function(
            """() => /^Applied .*regions/.test(
              document.querySelector('#status_bar_message')?.textContent || '')""",
            timeout=30000,
        )
        propagate_ok = page.evaluate(
            """(left) => {
              const names = window.PhaseFinder.plot.series.map((s) => s.name);
              return names.every((n) =>
                Math.abs(window.PhaseFinder.pipeline.get_state(n).modeling.peakSelection.regions.g1.left - left) < 1e-6);
            }""",
            new_left,
        )
        ctx.check(
            group,
            "Apply to All copies the focused sample's regions and attempts a gated refit for every plotted sample",
            propagate_ok is True,
            str({"propagatedG1Left": new_left, "allMatch": propagate_ok}),
        )
    except Exception as error:
        ctx.check(group, "Identify Peaks region-review flow", False, str(error))
    finally:
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
        if page.is_visible("#structural_qc_modal"):
            page.eval_on_selector("#structural_qc_cancel", "button => button.click()")
        # Return the sidebar to file mode so later tests (e.g. Calculate
        # Statistics) can reach the file-mode action buttons again.
        exit_modeling_mode(page)
        if previous_selection:
            restore_row_selection(page, previous_selection)
