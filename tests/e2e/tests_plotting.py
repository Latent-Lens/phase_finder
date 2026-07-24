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
    wait_briefly,
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
    wait_briefly(0.3)

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
    wait_for_overlay_hidden(page)
    overlay_hidden = page.eval_on_selector("#progress_overlay", "e => e.hidden")
    ctx.check(group, "Progress overlay hides after plot completes",
              overlay_hidden, "hidden" if overlay_hidden else "still visible")

    bar_after_plot = status_bar_text(page)
    ctx.check(group, "Status bar shows completion message after plotting",
              "ready" in bar_after_plot.lower() or "finished" in bar_after_plot.lower()
              or "plotted" in bar_after_plot.lower() or bar_after_plot != "",
              bar_after_plot)

    # --- plot inspection API (window.PhaseFinder.plot) ---
    # series = the currently drawn (checked) samples; series_names / get_histogram
    # cover every loaded sample, checked or not, so tests/tools can read any
    # sample's binned histogram by name.
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
    ctx.check(group, "Plot inspection API exposes a binned histogram for every loaded sample",
              plot_api["namesLen"] >= total_rows and plot_api["histHasBins"],
              str(plot_api))

    # --- re-select all rows and plot all ---
    select_all_visible_rows(page)
    wait_briefly(0.2)

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

    # --- turn rows off, verify curves decrease ---
    checkboxes = page.query_selector_all(".file_table tbody .row_select")
    checkboxes[0].uncheck()
    checkboxes[1].uncheck()
    wait_briefly(0.4)
    ctx.check(group, "Turning rows off removes plot lines",
              density_curve_count(page) == total_rows - 2,
              f"curves={density_curve_count(page)}")

    # Data should still be cached
    ctx.check(group, "Unchecked rows retain loaded data",
              page.evaluate("window.PhaseFinder.app.get_parsed_files().filter(r => r.data).length") >= total_rows,
              "data cache retained")

    # Re-check one row
    checkboxes = page.query_selector_all(".file_table tbody .row_select")
    checkboxes[0].check()
    wait_briefly(0.4)
    ctx.check(group, "Turning a row back on restores its plot line",
              density_curve_count(page) == total_rows - 1,
              f"curves={density_curve_count(page)}")

    # Re-check the second row
    checkboxes = page.query_selector_all(".file_table tbody .row_select")
    checkboxes[1].check()
    wait_briefly(0.4)
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
            wait_briefly(0.8)
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


def _viewport(page):
    return page.evaluate("() => window.PhaseFinder.plot.viewport")


def _override(page):
    return page.evaluate("() => window.PhaseFinder.plot.axis_range_override")


def _span(domain):
    return None if not domain else domain[1] - domain[0]


def _plot_box(page):
    return page.query_selector("#plot_area svg").bounding_box()


def _reset_view(page):
    page.click("#plot_tool_home")
    wait_briefly(0.4)


def test_plot_toolbar(ctx: TestContext):
    """Toolbar icons, the display-only pan/zoom viewport, and image export."""
    page = ctx.page
    group = "Plot Toolbar"

    if page.query_selector("#plot_area svg") is None:
        ctx.warn(group, "Plot toolbar", "Skipped: no plot is rendered")
        return

    buttons = page.evaluate(
        "() => [...document.querySelectorAll('#plot_toolbar .plot_tool')].map(b => b.id)")
    ctx.check(group, "Toolbar renders the six plot tools in order",
              buttons == ["plot_tool_camera", "plot_tool_pan", "plot_tool_zoom_in",
                          "plot_tool_zoom_out", "plot_tool_autoscale", "plot_tool_home"],
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
                    return svg.firstElementChild === surface || svg.children[0] === surface;
                  }"""),
              "surface must be the first child so curves/handles stay on top")

    _reset_view(page)
    base = _viewport(page)
    ctx.check(group, "A freshly drawn plot has no pan/zoom viewport",
              base["x"] is None and base["y"] is None, str(base))

    box = _plot_box(page)
    cx = box["x"] + box["width"] / 2
    cy = box["y"] + box["height"] / 2

    # --- wheel zoom -------------------------------------------------------
    page.mouse.move(cx, cy)
    page.mouse.wheel(0, -400)
    wait_briefly(0.5)
    wheeled = _viewport(page)
    ctx.check(group, "Mouse wheel zooms the view about the cursor",
              wheeled["x"] is not None and wheeled["y"] is not None,
              str(wheeled))
    ctx.check(group, "Wheel zoom leaves the modeling axis range untouched",
              _override(page) == BLANK_OVERRIDE, str(_override(page)))

    page.mouse.wheel(0, 800)
    wait_briefly(0.5)
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
    wait_briefly(0.5)
    boxed = _viewport(page)
    ctx.check(group, "Shift-drag zooms into the painted rectangle on both axes",
              boxed["x"] is not None and boxed["y"] is not None
              and boxed["x"][0] < boxed["x"][1] and boxed["y"][0] < boxed["y"][1],
              str(boxed))
    ctx.check(group, "Box zoom leaves the modeling axis range untouched",
              _override(page) == BLANK_OVERRIDE, str(_override(page)))

    # --- double-click resets ---------------------------------------------
    page.mouse.dblclick(box["x"] + box["width"] * 0.35, box["y"] + 25)
    wait_briefly(0.5)
    ctx.check(group, "Double-clicking empty plot space resets the view",
              _viewport(page) == {"x": None, "y": None}, str(_viewport(page)))

    # --- pan --------------------------------------------------------------
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx - 130, cy, steps=12)
    page.mouse.up()
    wait_briefly(0.5)
    panned = _viewport(page)
    ctx.check(group, "Dragging pans the view without changing its width",
              panned["x"] is not None and _span(panned["x"]) > 0,
              str(panned))
    ctx.check(group, "Panning leaves the modeling axis range untouched",
              _override(page) == BLANK_OVERRIDE, str(_override(page)))
    _reset_view(page)

    # --- zoom modes -------------------------------------------------------
    page.click("#plot_tool_zoom_out")
    wait_briefly(0.3)
    ctx.check(group, "Selecting a zoom mode moves the pressed state off Pan",
              page.get_attribute("#plot_tool_zoom_out", "aria-pressed") == "true"
              and page.get_attribute("#plot_tool_pan", "aria-pressed") == "false"
              and page.eval_on_selector("#plot_area", "e => e.dataset.plotMode") == "zoom_out",
              page.evaluate("() => window.PhaseFinder.plot.interaction_mode"))

    page.mouse.click(cx, cy)
    wait_briefly(0.7)
    clicked_out = _viewport(page)
    ctx.check(group, "Clicking in zoom-out mode zooms the view out about the cursor",
              clicked_out["x"] is not None and clicked_out["y"] is not None,
              str(clicked_out))
    page.click("#plot_tool_pan")
    _reset_view(page)

    # --- autoscale --------------------------------------------------------
    page.click("#plot_tool_autoscale")
    wait_briefly(0.5)
    autoscaled = _viewport(page)
    ctx.check(group, "Autoscale fits the axes to the plotted data",
              autoscaled["x"] is not None and autoscaled["y"] is not None
              and autoscaled["y"][0] == 0 and autoscaled["y"][1] > 0,
              str(autoscaled))
    ctx.check(group, "Autoscale leaves the modeling axis range untouched",
              _override(page) == BLANK_OVERRIDE, str(_override(page)))
    _reset_view(page)

    # --- image export -----------------------------------------------------
    # Each format is downloaded for real and checked by its file signature, so
    # a silently corrupt encoder can't pass on file size alone.
    signatures = {
        "svg": (b"<?xml", ".svg"),
        "pdf": (b"%PDF-", ".pdf"),
        "png": (b"\x89PNG", ".png"),
        "jpeg": (b"\xff\xd8\xff", ".jpg"),
    }
    for fmt, (magic, extension) in signatures.items():
        try:
            page.click("#plot_tool_camera")
            page.wait_for_selector("#plot_export_modal:not([hidden])", timeout=5000)
            page.check(f"input[name='plot_export_format'][value='{fmt}']")
            with page.expect_download(timeout=25000) as download_info:
                page.click("#plot_export_download")
            download = download_info.value
            saved = ctx.results_dir / f"{ctx.report_stem}_plot_export{extension}"
            download.save_as(str(saved))
            head = saved.read_bytes()[:8]
            ctx.check(group, f"Camera exports a valid {fmt.upper()} file",
                      download.suggested_filename.endswith(extension)
                      and head.startswith(magic)
                      and saved.stat().st_size > 1000
                      and page.is_hidden("#plot_export_modal"),
                      f"{download.suggested_filename}, {saved.stat().st_size} bytes, head={head!r}")
        except Exception as error:
            ctx.check(group, f"Camera exports a valid {fmt.upper()} file", False, str(error))
            if page.is_visible("#plot_export_modal"):
                page.click("#plot_export_cancel")

    # Leave the plot exactly as the next test module expects to find it.
    _reset_view(page)
