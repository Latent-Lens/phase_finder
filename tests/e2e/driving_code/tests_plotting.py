#!/usr/bin/env python3
"""Plotting tests: channel selection, Plot Channel Events, row toggles, channel change."""

from helpers import (
    TestContext,
    STATUS_WARN,
    another_channel,
    click_plot_events,
    density_curve_count,
    ensure_channel_option,
    plot_title,
    select_all_visible_rows,
    select_channel,
    selected_row_count,
    status_bar_text,
    table_row_count,
    try_catch_progress,
    wait_for_render,
    wait_for_curves,
    wait_for_overlay_hidden,
)


def test_plotting(ctx: TestContext, preferred_channel: str):
    page = ctx.page
    group = "Plotting"
    total_rows = table_row_count(page)

    # Ensure all rows are checked before plotting
    select_all_visible_rows(page)
    ctx.check(group, "All loaded rows selected before plotting",
              selected_row_count(page) == total_rows,
              f"selected={selected_row_count(page)}, rows={total_rows}")

    # Select channel
    channel, warning = ensure_channel_option(page, preferred_channel)
    select_channel(page, channel)
    if warning:
        ctx.warn(group, f"Select {preferred_channel} channel", warning)
    else:
        ctx.check(group, f"Select {preferred_channel} channel",
                  page.eval_on_selector("#channel_select", "e => e.value") == channel)

    # --- plot a strict subset first to verify subset behavior ---
    checkboxes = page.query_selector_all(".file_table tbody .row_select")
    subset_count = min(2, total_rows)
    # Uncheck all except the first subset_count
    for i, cb in enumerate(checkboxes):
        if i < subset_count:
            cb.check()
        else:
            cb.uncheck()
    wait_for_render(page)

    page.click("#start_analysis_button")
    # Catch progress overlay during plot
    progress_during_plot = try_catch_progress(page, timeout_ms=10000)
    page.wait_for_selector("#plot_area svg", timeout=120000)
    wait_for_curves(page, subset_count)

    ctx.check(group, "Plot strict subset of files",
              density_curve_count(page) == subset_count,
              f"curves={density_curve_count(page)}, expected={subset_count}")
    ctx.check(group, "Progress overlay appears during Plot Channel Events",
              progress_during_plot,
              "overlay caught" if progress_during_plot else "loaded too fast to observe")
    progress_a11y = page.evaluate("""() => {
      const bar = document.querySelector('#progress_overlay [role=progressbar]');
      return { min: bar?.getAttribute('aria-valuemin'), max: bar?.getAttribute('aria-valuemax'), now: bar?.getAttribute('aria-valuenow') };
    }""")
    ctx.check(group, "UI-10: determinate progress exposes progressbar semantics",
              progress_a11y["min"] == "0" and progress_a11y["max"] == "100"
              and progress_a11y["now"] is not None, str(progress_a11y))
    wait_for_overlay_hidden(page)
    overlay_hidden = page.eval_on_selector("#progress_overlay", "e => e.hidden")
    ctx.check(group, "Progress overlay hides after plot completes",
              overlay_hidden, "hidden" if overlay_hidden else "still visible")

    operation_ownership = page.evaluate("""async () => {
      const progress = await import('./js/ui/status_channels.js');
      const oldId = progress.show_progress('Old operation');
      let oldCancelled = false;
      progress.show_progress_cancel(() => { oldCancelled = true; }, oldId);
      const newId = progress.show_progress('New operation');
      let newCancelled = false;
      progress.show_progress_cancel(() => { newCancelled = true; }, newId);
      const staleUpdateRejected = progress.update_progress(99, 'Stale update', '', '', oldId) === false;
      const staleStatusRejected = progress.set_status_bar('Stale status', false, null, oldId) === false;
      const staleHideRejectedAtCall = progress.hide_progress(0, oldId) === false;
      document.querySelector('#progress_cancel').click();
      await new Promise(resolve => setTimeout(resolve, 20));
      const staleHideRejected = !document.querySelector('#progress_overlay').hidden;
      progress.hide_progress(0, newId);
      await new Promise(resolve => setTimeout(resolve, 20));
      return { staleUpdateRejected, staleStatusRejected, staleHideRejectedAtCall,
        staleHideRejected, staleCancelRejected: !oldCancelled, currentCancelRan: newCancelled,
        finalHidden: document.querySelector('#progress_overlay').hidden };
    }""")
    ctx.check(group, "UI-10: superseded progress/status/hide updates cannot overwrite the current operation",
              all(operation_ownership.values()), str(operation_ownership))

    bar_after_plot = status_bar_text(page)
    ctx.check(group, "Status bar shows completion message after plotting",
              "ready" in bar_after_plot.lower() or "finished" in bar_after_plot.lower()
              or "plotted" in bar_after_plot.lower() or bar_after_plot != "",
              bar_after_plot)

    # --- plot inspection API (window.PhaseFinder.plot) ---
    # The inspection API retains only currently drawn samples. This keeps
    # unchecked samples from being rescanned or retained on every redraw.
    plot_api = page.evaluate(
        """() => {
            const p = window.PhaseFinder.plot;
            const names = p.series_names;
            const hist = names.length ? p.get_histogram(names[0]) : null;
            return {
                seriesIsArray: Array.isArray(p.series),
                seriesLen: p.series.length,
                namesLen: names.length,
                histHasBins: !!(hist && Array.isArray(hist.counts) && Array.isArray(hist.binEdges) && hist.counts.length > 0),
            };
        }""")
    ctx.check(group, "Plot inspection API exposes the drawn series (window.PhaseFinder.plot.series)",
              plot_api["seriesIsArray"] and plot_api["seriesLen"] == subset_count,
              str(plot_api))
    ctx.check(group, "PERF-UI-04: plot inspection caches only drawn samples",
              plot_api["namesLen"] == subset_count and plot_api["histHasBins"],
              str(plot_api))
    redraw_profile = page.evaluate("""async () => {
      const { render_density_plot } = await import('./js/plotting/render.js');
      window.PhaseFinder.plot.performance.reset();
      const started = performance.now();
      for (let index = 0; index < 5; index += 1) render_density_plot();
      return { elapsedMs: performance.now() - started, ...window.PhaseFinder.plot.performance.snapshot() };
    }""")
    ctx.check(group, "PERF-UI-04: repeated redraws do not rescan events or retain unchecked samples",
              redraw_profile["eventScans"] == 0
              and redraw_profile["histogramBuilds"] == 0
              and redraw_profile["cacheHits"] >= subset_count * 5
              and redraw_profile["cachedSamples"] == subset_count
              and redraw_profile["elapsedMs"] < 1500,
              str(redraw_profile))

    # --- re-select all rows and plot all ---
    select_all_visible_rows(page)
    wait_for_render(page)

    click_plot_events(page)
    wait_for_curves(page, total_rows)
    title = plot_title(page)

    ctx.check(group, "Plot Channel Events plots all loaded files",
              density_curve_count(page) == total_rows,
              f"curves={density_curve_count(page)}, title={title}")
    ctx.check(group, "Plot title and y-axis update",
              title.startswith(f"Histogram of Events:  {total_rows} Samples  |  ")
              and page.eval_on_selector_all(
                  "#plot_area svg text",
                  "els => els.some(t => t.textContent === 'Number of Events')"
              ),
              title)
    ctx.check(group, "Run DJF Pipeline button becomes enabled after plotting",
              not page.eval_on_selector("#cell_cycle_modeling_button", "e => e.disabled"))

    accessible_plot = page.evaluate(
        """() => {
            const svg = document.querySelector('#plot_area svg');
            const details = document.querySelector('.plot_accessibility_summary');
            return {
                role: svg?.getAttribute('role'),
                title: svg?.querySelector('title')?.textContent || '',
                desc: svg?.querySelector('desc')?.textContent || '',
                labelled: (svg?.getAttribute('aria-labelledby') || '').split(' ').every(id => document.getElementById(id)),
                rows: details?.querySelectorAll('tbody tr').length || 0,
                text: details?.textContent || '',
                decorativeHidden: [...(svg?.children || [])].filter(el => ['g', 'defs'].includes(el.localName)).every(el => el.getAttribute('aria-hidden') === 'true'),
            };
        }""")
    ctx.check(group, "Plot has a current SVG name, description, and structured text alternative",
              accessible_plot["role"] == "img"
              and f"{total_rows} samples" in accessible_plot["title"].lower()
              and "x axis" in accessible_plot["desc"].lower()
              and accessible_plot["labelled"]
              and accessible_plot["rows"] == total_rows
              and "events" in accessible_plot["text"].lower()
              and accessible_plot["decorativeHidden"],
              str(accessible_plot))
    accessibility_tree = page.locator("#plot_area").aria_snapshot()
    ctx.check(group, "UI-05D: browser accessibility tree exposes the histogram and data summary",
              "img" in accessibility_tree
              and f"{total_rows} samples" in accessibility_tree.lower()
              and "x axis" in accessibility_tree.lower(),
              accessibility_tree)

    # --- turn rows off, verify curves decrease ---
    checkboxes = page.query_selector_all(".file_table tbody .row_select")
    checkboxes[0].uncheck()
    checkboxes[1].uncheck()
    wait_for_render(page)
    ctx.check(group, "Turning rows off removes plot lines",
              density_curve_count(page) == total_rows - 2
              and page.evaluate("window.PhaseFinder.plot.histogram_names.length") == total_rows - 2,
              f"curves={density_curve_count(page)}, cached={page.evaluate('window.PhaseFinder.plot.histogram_names.length')}")

    # Data should still be cached
    ctx.check(group, "Unchecked rows retain loaded data",
              page.evaluate("window.PhaseFinder.app.get_parsed_files().filter(r => r.data).length") >= total_rows,
              "data cache retained")

    # Re-check one row
    checkboxes = page.query_selector_all(".file_table tbody .row_select")
    checkboxes[0].check()
    wait_for_render(page)
    ctx.check(group, "Turning a row back on restores its plot line",
              density_curve_count(page) == total_rows - 1,
              f"curves={density_curve_count(page)}")

    # Re-check the second row
    checkboxes = page.query_selector_all(".file_table tbody .row_select")
    checkboxes[1].check()
    wait_for_render(page)
    ctx.check(group, "All rows back on restores all plot lines",
              density_curve_count(page) == total_rows,
              f"curves={density_curve_count(page)}")

    # --- channel change behavior ---
    other = another_channel(page, channel)
    if other:
        select_channel(page, other)
        try:
            page.wait_for_function(
                "() => document.querySelector('#start_analysis_button').textContent.trim() === 'Plot Channel Events'",
                timeout=60000,
            )
            wait_for_render(page)
            btn = page.eval_on_selector("#start_analysis_button", "e => e.textContent.trim()")
            ctx.check(group, "Changing channel restores Plot Channel Events button",
                      btn == "Plot Channel Events", btn)
            ctx.check(group, "Changing channel clears curves but keeps axes",
                      density_curve_count(page) == 0
                      and page.eval_on_selector_all(
                          "#plot_area svg text",
                          "els => els.some(t => t.textContent === 'Number of Events')"
                      ),
                      f"curves={density_curve_count(page)}, title={plot_title(page)}")
            empty_tree = page.locator("#plot_area").aria_snapshot()
            ctx.check(group, "UI-05D: browser accessibility tree exposes the empty plot state",
                      "img" in empty_tree and "0 samples" in empty_tree.lower()
                      and "empty histogram" in empty_tree.lower(), empty_tree)
            bar = status_bar_text(page)
            ctx.check(group, "Changing channel shows progress/status during reload",
                      "ready" in bar.lower() or "loading" in bar.lower() or bar != "",
                      bar)
            load_ok = "failed" not in bar.lower() and "error" not in bar.lower()
            if load_ok:
                page.click("#start_analysis_button")
                wait_for_curves(page, total_rows)
                ctx.check(group, "Plot Channel Events replots the newly selected channel",
                          density_curve_count(page) == total_rows,
                          f"channel={other}, curves={density_curve_count(page)}")
            else:
                ctx.warn(group, "Plot Channel Events replots the newly selected channel",
                         f"Skipped: channel data load failed ({bar})")
        except Exception as error:
            ctx.check(group, "Changing channel restores Plot Channel Events button", False, str(error))

        # Always restore the original channel so downstream test modules start clean
        select_channel(page, channel)
        try:
            page.wait_for_function(
                "() => document.querySelector('#start_analysis_button').textContent.trim() === 'Plot Channel Events'",
                timeout=30000,
            )
        except Exception:
            pass
        # Re-plot the original channel so downstream pipeline tests start clean.
        click_plot_events(page)
        wait_for_curves(page, total_rows)
    else:
        ctx.warn(group, "Changing channel restores Plot Channel Events button",
                 "Only one channel option available")


# ---------------------------------------------------------------------------
# Plot toolbar: display-only pan/zoom + image export
# ---------------------------------------------------------------------------

# The invariant this whole group exists to protect: pan/zoom is a VIEW change.
# It must never write axis_range_override (the modeling range), because that
# would silently re-run peak detection and every fit just from looking around.
BLANK_OVERRIDE = {"x_min": None, "x_max": None, "y_min": None, "y_max": None}
BLANK_ANALYSIS_DOMAIN = {"x_min": None, "x_max": None}


def _viewport(page):
    return page.evaluate("() => window.PhaseFinder.plot.viewport")


def _override(page):
    return page.evaluate("() => window.PhaseFinder.plot.axis_range_override")


def _analysis_domain(page):
    return page.evaluate("() => window.PhaseFinder.plot.analysis_domain")


def _span(domain):
    return None if not domain else domain[1] - domain[0]


def _plot_box(page):
    return page.query_selector("#plot_area svg").bounding_box()


def _reset_view(page):
    page.click("#plot_tool_home")
    wait_for_render(page)


def test_plot_toolbar(ctx: TestContext):
    """Toolbar icons, the display-only pan/zoom viewport, and image export."""
    page = ctx.page
    group = "Plot Toolbar"

    if page.query_selector("#plot_area svg") is None:
        ctx.warn(group, "Plot toolbar", "Skipped: no plot is rendered")
        return

    buttons = page.evaluate(
        "() => [...document.querySelectorAll('#plot_toolbar .plot_tool')].map(b => b.id)")
    # UI-07 added a seventh toolbar button, plot_tool_axes (opens the
    # axis-range dialog that a hidden double-click used to be the only way to
    # reach), appended after Reset axes/home.
    ctx.check(group, "Toolbar renders the seven plot tools in order",
              buttons == ["plot_tool_camera", "plot_tool_pan", "plot_tool_zoom_in",
                          "plot_tool_zoom_out", "plot_tool_autoscale", "plot_tool_home",
                          "plot_tool_axes"],
              str(buttons))

    ctx.check(group, "Pan is the armed mode by default",
              page.get_attribute("#plot_tool_pan", "aria-pressed") == "true"
              and page.evaluate("() => window.PhaseFinder.plot.interaction_mode") == "pan"
              and page.eval_on_selector("#plot_area", "e => e.dataset.plotMode") == "pan",
              page.evaluate("() => window.PhaseFinder.plot.interaction_mode"))

    ctx.check(group, "An interaction surface is drawn under the plot layers",
              page.evaluate("() => document.querySelectorAll('#plot_area .plot_interaction_surface').length") == 1
              and page.evaluate(
                  """() => {
                    const svg = document.querySelector('#plot_area svg');
                    const surface = svg.querySelector('.plot_interaction_surface');
                    const graphical = [...svg.children]
                      .filter(child => !['title', 'desc', 'defs'].includes(child.localName));
                    return graphical[0] === surface;
                  }"""),
              "surface must be the first graphical child so curves/handles stay on top")

    _reset_view(page)
    base = _viewport(page)
    ctx.check(group, "A freshly drawn plot has no pan/zoom viewport",
              base["x"] is None and base["y"] is None, str(base))

    # The axis dialog is a real form: Enter in a numeric field or on Apply is
    # the only submit path; Reset, Cancel, Close, and the checkbox retain their
    # native keyboard behavior without accidentally applying the draft.
    axis_hit = "#plot_area .x_axis_group .axis_hit_area"
    page.dblclick(axis_hit)
    page.focus("#axis_range_reset")
    page.press("#axis_range_reset", "Enter")
    reset_safe = page.locator("#axis_range_modal").is_hidden() and _override(page) == BLANK_OVERRIDE
    page.dblclick(axis_hit)
    page.focus("#axis_range_cancel")
    page.press("#axis_range_cancel", "Space")
    cancel_safe = page.locator("#axis_range_modal").is_hidden() and _override(page) == BLANK_OVERRIDE
    page.dblclick(axis_hit)
    page.focus("#axis_range_close")
    page.press("#axis_range_close", "Enter")
    close_safe = page.locator("#axis_range_modal").is_hidden() and _override(page) == BLANK_OVERRIDE
    page.dblclick(axis_hit)
    page.focus("#axis_range_analysis_domain")
    page.press("#axis_range_analysis_domain", "Space")
    checkbox_safe = page.is_checked("#axis_range_analysis_domain") and page.locator("#axis_range_modal").is_visible()
    page.press("#axis_range_analysis_domain", "Space")
    page.fill("#axis_range_x_min", "1")
    page.fill("#axis_range_x_max", "2")
    page.focus("#axis_range_x_max")
    page.press("#axis_range_x_max", "Enter")
    input_submit = page.locator("#axis_range_modal").is_hidden() and _override(page)["x_min"] == 1 and _override(page)["x_max"] == 2
    page.dblclick(axis_hit)
    page.focus("#axis_range_reset")
    page.press("#axis_range_reset", "Space")
    page.dblclick(axis_hit)
    page.fill("#axis_range_x_min", "1")
    page.fill("#axis_range_x_max", "2")
    page.focus("#axis_range_apply")
    page.press("#axis_range_apply", "Space")
    apply_submit = page.locator("#axis_range_modal").is_hidden() and _override(page)["x_min"] == 1 and _override(page)["x_max"] == 2
    page.dblclick(axis_hit)
    page.press("#axis_range_reset", "Enter")
    ctx.check(group, "UI-15: axis form controls have safe Enter/Space behavior",
              reset_safe and cancel_safe and close_safe and checkbox_safe and input_submit and apply_submit,
              str({"reset": reset_safe, "cancel": cancel_safe, "close": close_safe,
                   "checkbox": checkbox_safe, "input": input_submit, "apply": apply_submit}))

    box = _plot_box(page)
    cx = box["x"] + box["width"] / 2
    cy = box["y"] + box["height"] / 2

    # --- wheel zoom -------------------------------------------------------
    page.mouse.move(cx, cy)
    page.mouse.wheel(0, -400)
    wait_for_render(page)
    wheeled = _viewport(page)
    ctx.check(group, "Mouse wheel zooms the view about the cursor",
              wheeled["x"] is not None and wheeled["y"] is not None,
              str(wheeled))
    ctx.check(group, "Wheel zoom leaves the modeling axis range untouched",
              _override(page) == BLANK_OVERRIDE
              and _analysis_domain(page) == BLANK_ANALYSIS_DOMAIN,
              str({"display": _override(page), "analysis": _analysis_domain(page)}))

    page.mouse.wheel(0, 800)
    wait_for_render(page)
    zoomed_out = _viewport(page)
    ctx.check(group, "Wheeling back out widens the view again",
              zoomed_out["x"] is None or _span(zoomed_out["x"]) > _span(wheeled["x"]),
              f"{zoomed_out['x']} vs {wheeled['x']}")

    # --- home ------------------------------------------------------------
    _reset_view(page)
    ctx.check(group, "Reset axes clears the pan/zoom viewport",
              _viewport(page) == {"x": None, "y": None}, str(_viewport(page)))

    # --- shift+drag box zoom ---------------------------------------------
    page.keyboard.down("Shift")
    page.mouse.move(cx - 150, cy - 90)
    page.mouse.down()
    page.mouse.move(cx + 60, cy + 90, steps=10)
    page.mouse.up()
    page.keyboard.up("Shift")
    wait_for_render(page)
    boxed = _viewport(page)
    ctx.check(group, "Shift-drag zooms into the painted rectangle on both axes",
              boxed["x"] is not None and boxed["y"] is not None
              and boxed["x"][0] < boxed["x"][1] and boxed["y"][0] < boxed["y"][1],
              str(boxed))
    ctx.check(group, "Box zoom leaves the modeling axis range untouched",
              _override(page) == BLANK_OVERRIDE, str(_override(page)))

    # --- double-click resets ---------------------------------------------
    page.mouse.dblclick(box["x"] + box["width"] * 0.35, box["y"] + 25)
    wait_for_render(page)
    ctx.check(group, "Double-clicking empty plot space resets the view",
              _viewport(page) == {"x": None, "y": None}, str(_viewport(page)))

    # --- pan --------------------------------------------------------------
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx - 130, cy, steps=12)
    page.mouse.up()
    wait_for_render(page)
    panned = _viewport(page)
    ctx.check(group, "Dragging pans the view without changing its width",
              panned["x"] is not None and _span(panned["x"]) > 0,
              str(panned))
    ctx.check(group, "Panning leaves the modeling axis range untouched",
              _override(page) == BLANK_OVERRIDE
              and _analysis_domain(page) == BLANK_ANALYSIS_DOMAIN,
              str({"display": _override(page), "analysis": _analysis_domain(page)}))
    _reset_view(page)

    # --- zoom modes -------------------------------------------------------
    page.click("#plot_tool_zoom_out")
    wait_for_render(page)
    ctx.check(group, "Selecting a zoom mode moves the pressed state off Pan",
              page.get_attribute("#plot_tool_zoom_out", "aria-pressed") == "true"
              and page.get_attribute("#plot_tool_pan", "aria-pressed") == "false"
              and page.eval_on_selector("#plot_area", "e => e.dataset.plotMode") == "zoom_out",
              page.evaluate("() => window.PhaseFinder.plot.interaction_mode"))

    page.mouse.click(cx, cy)
    page.wait_for_function(
        "() => window.PhaseFinder.plot.viewport.x !== null && window.PhaseFinder.plot.viewport.y !== null",
        timeout=2000,
    )
    clicked_out = _viewport(page)
    ctx.check(group, "Clicking in zoom-out mode zooms the view out about the cursor",
              clicked_out["x"] is not None and clicked_out["y"] is not None,
              str(clicked_out))
    page.click("#plot_tool_pan")
    _reset_view(page)

    # --- autoscale --------------------------------------------------------
    page.click("#plot_tool_autoscale")
    page.wait_for_function(
        "() => window.PhaseFinder.plot.viewport.y?.[0] === 0",
        timeout=2000,
    )
    autoscaled = _viewport(page)
    ctx.check(group, "Autoscale fits the axes to the plotted data",
              autoscaled["x"] is not None and autoscaled["y"] is not None
              and autoscaled["y"][0] == 0 and autoscaled["y"][1] > 0,
              str(autoscaled))
    ctx.check(group, "Autoscale leaves the modeling axis range untouched",
              _override(page) == BLANK_OVERRIDE, str(_override(page)))
    _reset_view(page)

    # Collapsing the table must release its height to the plot and dock the
    # remaining table title bar at the bottom of the workspace.
    page.click("#metadata_panel_toggle")
    page.wait_for_timeout(300)
    collapsed_layout = page.evaluate("""() => {
      const workspace = document.querySelector('.workspace').getBoundingClientRect();
      const plot = document.querySelector('#plot_panel').getBoundingClientRect();
      const table = document.querySelector('#metadata_panel').getBoundingClientRect();
      return { bottomGap: Math.round(workspace.bottom - table.bottom), plotHeight: plot.height, ordered: plot.bottom <= table.top };
    }""")
    ctx.check(group, "Collapsed table docks at the bottom and releases space to the plot",
              abs(collapsed_layout["bottomGap"]) <= 1 and collapsed_layout["ordered"] and collapsed_layout["plotHeight"] > 460,
              str(collapsed_layout))
    page.click("#metadata_panel_toggle")
    page.wait_for_timeout(300)

    # --- image export -----------------------------------------------------
    # Each format is downloaded for real and checked by its file signature, so
    # a silently corrupt encoder can't pass on file size alone.
    signatures = {
        "html": (b"<!doctype", ".html"),
        "svg": (b"<?xml", ".svg"),
        "pdf": (b"%PDF-", ".pdf"),
        "png": (b"\x89PNG", ".png"),
        "jpeg": (b"\xff\xd8\xff", ".jpg"),
    }
    page.focus("#plot_tool_camera")
    page.press("#plot_tool_camera", "Enter")
    page.wait_for_selector("#plot_export_modal:not([hidden])", timeout=5000)
    page.wait_for_function("() => document.querySelector('main.app').inert")
    page.focus("#plot_export_modal .stats_modal_position_reset")
    page.keyboard.press("Tab")
    wrapped_forward = page.locator("#plot_export_close").evaluate("element => element === document.activeElement")
    page.keyboard.press("Shift+Tab")
    wrapped_backward = page.locator("#plot_export_modal .stats_modal_position_reset").evaluate(
        "element => element === document.activeElement"
    )
    background_inert = page.eval_on_selector("main.app", "element => element.inert")
    page.keyboard.press("Escape")
    page.wait_for_selector("#plot_export_modal", state="hidden", timeout=5000)
    ctx.check(group, "UI-05E: modal traps focus, makes the background inert, and restores its trigger",
              wrapped_forward and wrapped_backward and background_inert
              and page.locator("#plot_tool_camera").evaluate("element => element === document.activeElement"),
              f"forward={wrapped_forward}, backward={wrapped_backward}, inert={background_inert}")
    export_guards = page.evaluate("""async () => {
      const exports = await import('./js/plotting/plot_export.js');
      const cancelled = new AbortController();
      cancelled.abort();
      let cancelName = '', sizeMessage = '';
      try { await exports.export_plot_image('png', 2, cancelled.signal); }
      catch (error) { cancelName = error.name; }
      try { await exports.export_plot_image('png', 1000); }
      catch (error) { sizeMessage = error.message; }
      return { cancelName, sizeMessage };
    }""")
    ctx.check(group, "UI-14: export cancellation and raster memory bounds fail safely before download",
              export_guards["cancelName"] == "AbortError"
              and "too large" in export_guards["sizeMessage"].lower(), str(export_guards))
    export_resilience = page.evaluate("""async () => {
      const exports = await import('./js/plotting/plot_export.js');
      const originalClick = HTMLAnchorElement.prototype.click;
      let downloads = 0;
      HTMLAnchorElement.prototype.click = function () { downloads += 1; };
      exports.open_plot_export_modal();
      document.querySelector('input[name="plot_export_format"][value="svg"]').checked = true;
      await Promise.all([exports.submit_plot_export(), exports.submit_plot_export()]);
      HTMLAnchorElement.prototype.click = originalClick;

      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null); };
      let failure = '';
      try { await exports.export_plot_image('png', 1); }
      catch (error) { failure = error.message; }
      finally { HTMLCanvasElement.prototype.toBlob = originalToBlob; }
      return { downloads, failure, hidden: document.querySelector('#plot_export_modal').hidden };
    }""")
    ctx.check(group, "UI-14: repeated submission is single-flight and encoder failure is recoverable",
              export_resilience["downloads"] == 1 and export_resilience["hidden"]
              and "could not encode" in export_resilience["failure"].lower(), str(export_resilience))
    for fmt, (magic, extension) in signatures.items():
        try:
            page.click("#plot_tool_camera")
            page.wait_for_selector("#plot_export_modal:not([hidden])", timeout=5000)
            page.check(f"input[name='plot_export_format'][value='{fmt}']")
            with page.expect_download(timeout=25000) as download_info:
                page.click("#plot_export_download")
            download = download_info.value
            # The browser exposes the download before the async click handler
            # resumes and closes the picker.  Wait for that success state
            # instead of racing it in the assertion below.
            page.wait_for_selector("#plot_export_modal", state="hidden", timeout=5000)
            saved = ctx.results_dir / f"{ctx.report_stem}_plot_export{extension}"
            download.save_as(str(saved))
            head = saved.read_bytes()[:16]
            report_ok = fmt != "html" or (
                "Metadata and results" in saved.read_text(encoding="utf-8")
                and "Plots and modeled areas" in saved.read_text(encoding="utf-8")
                and "phasefinder-analysis-provenance" in saved.read_text(encoding="utf-8")
                and "applicationVersion" in saved.read_text(encoding="utf-8")
                and "<svg" in saved.read_text(encoding="utf-8")
                and "<table" in saved.read_text(encoding="utf-8")
            )
            svg_provenance_ok = fmt != "svg" or (
                "phasefinder-analysis-provenance" in saved.read_text(encoding="utf-8")
                and "applicationVersion" in saved.read_text(encoding="utf-8")
                and "phasefinder_export_provenance" in saved.read_text(encoding="utf-8")
            )
            ctx.check(group, f"Camera exports a valid {fmt.upper()} file",
                      download.suggested_filename.startswith("phasefinder_overlay_")
                      and download.suggested_filename.endswith(extension)
                      and "/" not in download.suggested_filename and "\\" not in download.suggested_filename
                      and head.startswith(magic)
                      and saved.stat().st_size > 1000
                      and report_ok and svg_provenance_ok,
                      f"{download.suggested_filename}, {saved.stat().st_size} bytes, head={head!r}")
        except Exception as error:
            ctx.check(group, f"Camera exports a valid {fmt.upper()} file", False, str(error))
            if page.is_visible("#plot_export_modal"):
                page.click("#plot_export_cancel")

    # Ridge exports must contain the complete stacked plot, not the first SVG.
    page.select_option("#plot_view_mode", "ridge")
    page.wait_for_function("document.querySelectorAll('.ridge_row').length >= 3")
    ridge_names = page.eval_on_selector_all(".ridge_row_name", "nodes => nodes.map(node => node.textContent.trim())")
    ridge_source = page.evaluate("""async () => {
      const exports = await import('./js/plotting/plot_export.js');
      return new XMLSerializer().serializeToString(exports.exportable_plot_svg());
    }""")
    ctx.check(group, "UI-14: every ridge encoder shares one complete provenance-bearing source",
              all(name in ridge_source for name in ridge_names)
              and "phasefinder-analysis-provenance" in ridge_source
              and "phasefinder_export_provenance" in ridge_source,
              f"rows={len(ridge_names)}, source_bytes={len(ridge_source)}")
    for fmt in ("svg", "pdf", "png", "jpeg"):
        extension = {"svg": ".svg", "pdf": ".pdf", "png": ".png", "jpeg": ".jpg"}[fmt]
        try:
            page.click("#plot_tool_camera")
            page.check(f"input[name='plot_export_format'][value='{fmt}']")
            with page.expect_download(timeout=25000) as download_info:
                page.click("#plot_export_download")
            saved = ctx.results_dir / f"{ctx.report_stem}_ridge_export{extension}"
            download_info.value.save_as(str(saved))
            page.wait_for_selector("#plot_export_modal", state="hidden", timeout=5000)
            svg_has_every_name = fmt != "svg" or all(name in saved.read_text(encoding="utf-8") for name in ridge_names)
            ctx.check(group, f"UI-04: {fmt.upper()} exports all {len(ridge_names)} ridge rows",
                      download_info.value.suggested_filename.startswith("phasefinder_ridge_")
                      and saved.stat().st_size > 1000 and svg_has_every_name,
                      f"rows={len(ridge_names)}, bytes={saved.stat().st_size}")
        except Exception as error:
            ctx.check(group, f"UI-04: {fmt.upper()} exports every ridge row", False, str(error))
            if page.is_visible("#plot_export_modal"):
                page.click("#plot_export_cancel")
    page.select_option("#plot_view_mode", "overlay")

    # Leave the plot exactly as the next test module expects to find it.
    _reset_view(page)
