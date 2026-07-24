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

        status_after_fit = status_bar_text(page)
        ctx.check(
            group,
            "Fitting a model reports progress in the status bar",
            "fit" in status_after_fit.lower(),
            status_after_fit,
        )

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
        # with the fitted sample's row carrying the percentages (cell_cycle_columns.js).
        columns_dom = page.wait_for_function(
            """(g1pct) => {
              const groups = [...document.querySelectorAll('#file_table th.cell_cycle_group_th')].map((e) => e.textContent.trim());
              const subs = [...document.querySelectorAll('#file_table th.cell_cycle_sub_th')].map((e) => e.textContent.trim());
              const cells = [...document.querySelectorAll('#file_table td.cell_cycle_td')]
                .map((e) => e.textContent.trim()).filter((t) => t.includes('%'));
              const ok = groups.includes('Watson Pragmatic')
                && subs.slice(0, 3).join(',') === 'G1,S,G2/M'
                && cells.some((c) => c === g1pct);
              return ok ? { groups, subs, cells } : null;
            }""",
            arg=f"{active_result['phaseFractions']['g1'] * 100:.1f}%",
            timeout=15000,
        )
        columns_info = columns_dom.json_value()
        ctx.check(
            group,
            "Fit fractions populate a per-model G1/S/G2-M group in the metadata table",
            "Watson Pragmatic" in columns_info["groups"]
            and columns_info["subs"][:3] == ["G1", "S", "G2/M"]
            and any(c.endswith("%") for c in columns_info["cells"]),
            str(columns_info),
        )

        # Changing the Bins slider after a fit auto-recalculates: the histogram
        # is rebuilt at the new bin count and the sample is re-fit with its last
        # model, announced by #bin_recalc_modal (bin_settings_sync.js). Watson
        # is still the active model here, so the refit succeeds deterministically.
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
        # Wait until the recalc has fully settled -- histogram rebuilt at 512,
        # the refit stored (active key carries the new fingerprint), and the
        # modal hidden again -- so the assertions below don't race the refit.
        page.wait_for_function(
            """(name) => {
              const state = window.PhaseFinder.pipeline.get_state(name);
              const modal = document.querySelector('#bin_recalc_modal');
              return state?.histogram?.binCount === 512
                && modal.hidden
                && Boolean(state.modeling.activeResultKey)
                && state.modeling.activeResultKey.includes('|512|');
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
            "Changing the Bins slider rebuilds the histogram at the new bin count and re-fits the sample",
            bins_before != 512
            and bins_after == 512
            and page.eval_on_selector("#plot_bins_value", "e => e.textContent") == "512"
            and recalc_active is not None
            and recalc_active["modelId"] == "watson_pragmatic"
            and page.eval_on_selector("#bin_recalc_modal", "e => e.hidden") is True,
            str({"binsBefore": bins_before, "binsAfter": bins_after,
                 "activeModel": recalc_active and recalc_active["modelId"]}),
        )

        # The Undo button appears after a bin-size recalc; one click reverts the
        # whole change from the snapshot taken before it (bin_settings_sync.js),
        # restoring the previous bin count and the sample's fit. This also puts
        # the bin count back to the 256 default so the Dean-Jett assertion below
        # runs under the same conditions as before this recalc/undo check.
        undo_visible = page.eval_on_selector("#plot_bins_undo", "e => !e.hidden")
        page.click("#plot_bins_undo")
        page.wait_for_function(
            """(name) => {
              const state = window.PhaseFinder.pipeline.get_state(name);
              return state?.histogram?.binCount === 256
                && document.querySelector('#plot_bins_undo').hidden
                && Boolean(state.modeling.activeResultKey)
                && state.modeling.activeResultKey.includes('|256|');
            }""",
            arg=sample_name,
            timeout=30000,
        )
        ctx.check(
            group,
            "Undo button reverts a bin-size change, restoring the previous bin count and fit",
            undo_visible
            and page.eval_on_selector("#plot_bins_value", "e => e.textContent") == "256"
            and page.eval_on_selector("#plot_bins", "e => e.value") == "1"
            and not page.eval_on_selector("#cell_cycle_fit_result", "e => e.hidden"),
            f"undo_was_visible={undo_visible}",
        )

        # Dean-Jett assumes a biological ~2:1 G2:G1 ratio by default. This
        # sample's detected regions don't support any ratio in its configured
        # range (an inferred_g2 fallback, not a confident detection) -- the
        # plan requires that to surface as a clear inline error instead of
        # hanging or silently fitting something meaningless ("If a
        # constraint is infeasible, disable Fit and explain it inline").
        #
        # That infeasibility is bin-count dependent for this sample: it holds at
        # 512 bins but not at the 256 default. Pin the bin count to 512 (which
        # re-detects + refits via the recalc flow) so this sub-test is
        # deterministic regardless of the default.
        page.evaluate(
            """() => {
              const slider = document.querySelector('#plot_bins');
              slider.value = '2';  // BIN_STOPS index 2 -> 512 bins
              slider.dispatchEvent(new Event('input', { bubbles: true }));
              slider.dispatchEvent(new Event('change', { bubbles: true }));
            }"""
        )
        page.wait_for_function(
            "(name) => window.PhaseFinder.pipeline.get_state(name)?.histogram?.binCount === 512"
            " && document.querySelector('#bin_recalc_modal').hidden",
            arg=sample_name,
            timeout=30000,
        )
        page.select_option("#cell_cycle_model_select", "dean_jett")
        page.click("#cell_cycle_fit_current_button")
        # Wait for the *new* status text specifically, not just visibility --
        # the status element is already visible from the Watson fit above and
        # would otherwise resolve immediately without waiting for this fit.
        page.wait_for_function(
            "() => (document.querySelector('#cell_cycle_fit_status')?.textContent || '').toLowerCase().includes('ratio')",
            timeout=15000,
        )
        status_text = page.eval_on_selector("#cell_cycle_fit_status", "e => e.textContent")
        ctx.check(
            group,
            "An infeasible ratio constraint surfaces a clear inline error instead of hanging",
            "ratio" in status_text.lower() and "g2" in status_text.lower(),
            status_text,
        )

        # Session modeling persistence (recompute-on-reload). Runs last so its
        # region/source mutations don't perturb the assertions above. First put
        # a clean Watson fit back (Dean-Jett just failed), then verify the saved
        # config re-applies: collecting it and re-applying (as reload does, after
        # clearing the cached fit) restores the same fit by re-fitting from the
        # saved regions/model -- no serialized results. (modeling_session.js)
        page.select_option("#cell_cycle_model_select", "watson_pragmatic")
        page.click("#cell_cycle_fit_current_button")
        page.wait_for_function(
            """(name) => {
              const m = window.PhaseFinder.pipeline.get_state(name)?.modeling;
              return Boolean(m?.activeResultKey)
                && m.resultsByKey[m.activeResultKey]?.modelId === 'watson_pragmatic';
            }""",
            arg=sample_name,
            timeout=30000,
        )
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

        # Modeling scope = only data within the visible x-range. Explicitly
        # narrowing the x-axis (as the axis-range modal does) fires
        # pf-x-range-changed, which recomputes: the modeling histogram is rebuilt
        # over the new range (clamp_range_to_axis_override), so events outside it
        # are excluded from peaks/fits. Assert the rebuilt histogram's domain
        # matches the override, not the full data extent.
        x_range_result = page.evaluate(
            """async (name) => {
              const hist = window.PhaseFinder.pipeline.get_state(name).histogram;
              const fullMin = hist.min, fullMax = hist.max;
              const span = fullMax - fullMin;
              const newMin = fullMin + span * 0.2;
              const newMax = fullMax - span * 0.2;
              const override = window.PhaseFinder.plot.axis_range_override;
              override.x_min = newMin;
              override.x_max = newMax;
              document.dispatchEvent(new CustomEvent('pf-x-range-changed'));
              return { fullMin, fullMax, newMin, newMax };
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
            "(name) => { const h = window.PhaseFinder.pipeline.get_state(name).histogram; return { min: h.min, max: h.max }; }",
            sample_name,
        )
        ctx.check(
            group,
            "Narrowing the x-axis range excludes out-of-range events from the modeling histogram",
            abs(histogram_after["min"] - x_range_result["newMin"]) < 1e-6
            and abs(histogram_after["max"] - x_range_result["newMax"]) < 1e-6
            and x_range_result["newMin"] > x_range_result["fullMin"]
            and x_range_result["newMax"] < x_range_result["fullMax"],
            str({"after": histogram_after, "requested": x_range_result}),
        )

        # Bulk auto-fit: re-plot every sample, clear the narrow x-override from
        # the previous check, pick Watson (no ratio constraint), and Auto-Fit
        # All. It auto-detects each sample, averages the four region bounds, and
        # applies those shared regions to every sample before fitting -- so all
        # plotted samples end up fit AND sharing identical (averaged) regions.
        page.evaluate(
            """() => {
              const o = window.PhaseFinder.plot.axis_range_override;
              o.x_min = null; o.x_max = null;
              for (const cb of document.querySelectorAll('.file_table tbody .row_select:not(:disabled)')) {
                if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
              }
            }"""
        )
        page.wait_for_function("() => (window.PhaseFinder.plot.series || []).length >= 2", timeout=30000)
        page.select_option("#cell_cycle_model_select", "watson_pragmatic")
        page.click("#cell_cycle_fit_all_button")
        page.wait_for_function(
            """() => {
              const names = (window.PhaseFinder.plot.series || []).map((s) => s.name);
              return names.length >= 2 && names.every((n) => {
                const m = window.PhaseFinder.pipeline.get_state(n)?.modeling;
                return m?.activeResultKey && m.resultsByKey[m.activeResultKey]?.modelId === 'watson_pragmatic';
              });
            }""",
            timeout=90000,
        )
        bulk = page.evaluate(
            """() => {
              const names = window.PhaseFinder.plot.series.map((s) => s.name);
              const regions = names.map((n) => window.PhaseFinder.pipeline.get_state(n).modeling.peakSelection.regions);
              const first = regions[0];
              const all_same = regions.every((r) =>
                Math.abs(r.g1.left - first.g1.left) < 1e-6 && Math.abs(r.g1.right - first.g1.right) < 1e-6
                && Math.abs(r.g2.left - first.g2.left) < 1e-6 && Math.abs(r.g2.right - first.g2.right) < 1e-6);
              return { count: names.length, all_same: all_same };
            }"""
        )
        ctx.check(
            group,
            "Auto-Fit All fits every plotted sample and gives them shared averaged regions",
            bulk["count"] >= 2 and bulk["all_same"] is True,
            str(bulk),
        )

        # A bulk fit auto-switches the plot to the Ridge view: one stacked
        # small-multiple per plotted sample, each with a "Ready to model" badge
        # and its own histogram, in a scrollable container (render.js Phase 1).
        ridge = page.evaluate(
            """() => {
              const container = document.querySelector('#plot_area .ridge_container');
              const rows = [...document.querySelectorAll('#plot_area .ridge_row')];
              const badges = [...document.querySelectorAll('#plot_area .ridge_badge_ready')];
              return {
                mode: document.querySelector('#plot_view_mode').value,
                hasContainer: Boolean(container),
                rowCount: rows.length,
                readyBadges: badges.length,
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
            and ridge["readyBadges"] == bulk["count"]
            and ridge["svgPaths"] >= bulk["count"],
            str(ridge),
        )

        # In-place editing: dragging a G1 boundary handle in the ridge (no
        # blow-up) edits that sample's region and re-fits it. The first
        # .ridge_region_hit is the G1-left boundary; drag it left and assert the
        # region moved, went "manual", and the sample still has a fit.
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

        # Phase 2: a per-row Review blows that sample up to the full plot (badge
        # "Under manual review", Accept button, ridge hidden, only that sample
        # rendered); Accept returns to the ridge (render.js review flow).
        page.click("#plot_area .ridge_row .ridge_review_button")
        page.wait_for_selector("#plot_area .ridge_review_bar", timeout=10000)
        blowup = page.evaluate(
            """() => ({
              reviewBadge: (document.querySelector('#plot_area .ridge_badge_review') || {}).textContent,
              hasAccept: Boolean(document.querySelector('#plot_area .ridge_review_accept')),
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
        page.click("#plot_area .ridge_review_accept")
        page.wait_for_selector("#plot_area .ridge_container", timeout=10000)
        back_to_ridge = page.evaluate(
            "() => ({ rows: document.querySelectorAll('#plot_area .ridge_row').length,"
            " barGone: !document.querySelector('#plot_area .ridge_review_bar') })"
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
            """(left) => {
              const names = (window.PhaseFinder.plot.series || []).map((s) => s.name);
              return names.length >= 2 && names.every((n) => {
                const m = window.PhaseFinder.pipeline.get_state(n)?.modeling;
                const r = m?.peakSelection?.regions;
                return r && Math.abs(r.g1.left - left) < 1e-6 && m.activeResultKey;
              });
            }""",
            arg=new_left,
            timeout=90000,
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
            "Apply to All copies the focused sample's regions to every plotted sample and refits",
            propagate_ok is True,
            str({"propagatedG1Left": new_left, "allMatch": propagate_ok}),
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
