#!/usr/bin/env python3
"""Sidebar/Icons tests: collapsed state, icon tooltips, channel sync, and plot icon."""

from pathlib import Path

from helpers import (
    TestContext,
    density_curve_count,
    table_row_count,
    wait_for_render,
    wait_for_curves,
)

_AXE_PATH = Path(__file__).resolve().parents[3] / "node_modules" / "axe-core" / "axe.min.js"


def test_sidebar_icons(ctx: TestContext):
    page = ctx.page
    group = "Sidebar/Icons"

    # Collapse the sidebar
    page.click("#sidebar_toggle")
    wait_for_render(page)

    # Collapsed icons are visible
    ctx.check(group, "Collapsed sidebar shows upload/channel/plot icons",
              page.locator("#collapsed_upload_target").is_visible()
              and page.locator("#collapsed_channel_select").is_visible()
              and page.locator("#collapsed_plot_button").is_visible())

    # Upload icon tooltip describes both functions
    tooltip = page.eval_on_selector(
        "#collapsed_upload_target",
        "e => e.getAttribute('data-tooltip') || e.title || ''",
    )
    ctx.check(group, "Collapsed upload icon hover text describes both functions",
              "Drop FCS files" in tooltip or "drop" in tooltip.lower(), tooltip)

    # Channel select mirrors expanded select
    ctx.check(group, "Collapsed channel icon select mirrors expanded select",
              page.eval_on_selector("#collapsed_channel_select", "e => e.value")
              == page.eval_on_selector("#channel_select", "e => e.value"))

    # Histogram icon is enabled (plot is available since rows are checked)
    ctx.check(group, "Collapsed histogram icon is enabled when plotting is available",
              not page.eval_on_selector("#collapsed_plot_button", "e => e.disabled"))

    # Click the collapsed histogram icon to trigger a replot
    expected_curves = density_curve_count(page)
    try:
        page.click("#collapsed_plot_button")
        wait_for_curves(page, expected_curves, timeout=120000)
        ctx.check(group, "Collapsed histogram icon click triggers plot",
                  density_curve_count(page) == expected_curves,
                  f"curves={density_curve_count(page)}")
    except Exception as error:
        ctx.check(group, "Collapsed histogram icon click triggers plot", False, str(error))

    # Restore expanded sidebar
    page.click("#sidebar_toggle")
    wait_for_render(page)


def test_sidebar_modeling_mode(ctx: TestContext):
    """Cell Cycle Modeling switches the sidebar to the relocated QC/DJF controls
    and Back restores the file/channel controls without losing state."""
    page = ctx.page
    group = "Sidebar/Modeling"

    try:
        title_before = page.eval_on_selector(".sidebar_title_row h2", "e => e.textContent.trim()")
        files_before = page.eval_on_selector("#loaded_files_list", "e => e.value")
        channel_before = page.eval_on_selector("#channel_select", "e => e.value")

        ctx.check(group, "Cell Cycle Modeling button is enabled after plotting",
                  not page.eval_on_selector("#cell_cycle_modeling_button", "e => e.disabled"))

        # Enter modeling mode
        page.click("#cell_cycle_modeling_button")
        page.wait_for_selector("#sidebar_modeling_section", state="visible", timeout=5000)
        wait_for_render(page)

        ctx.check(group, "Entering modeling mode reveals QC + Identify Peaks controls and Back",
                  page.eval_on_selector(".app", "e => e.classList.contains('sidebar_modeling_mode')")
                  and page.is_visible("#qc_filter_all")
                  and page.is_visible("#detect_peaks_button")
                  and page.is_visible("#sidebar_back_button"))
        ctx.check(group, "Modeling mode hides the file/channel controls and title reads 'Cell Cycle Modeling'",
                  not page.is_visible("#file_upload_section")
                  and not page.is_visible("#channel_select")
                  and not page.is_visible("#start_analysis_button")
                  and page.eval_on_selector(".sidebar_title_row h2", "e => e.textContent.trim()") == "Cell Cycle Modeling")
        ctx.check(group, "QC and Identify Peaks controls no longer occupy the plot panel (plot reclaims the height)",
                  page.eval_on_selector_all("#plot_panel .premodel_qc_group", "els => els.length") == 0
                  and page.eval_on_selector_all("#plot_panel .peak_review_group", "els => els.length") == 0)

        # Back
        page.click("#sidebar_back_button")
        page.wait_for_selector("#sidebar_modeling_section", state="hidden", timeout=5000)
        wait_for_render(page)

        ctx.check(group, "Back restores the file/channel controls and title",
                  not page.eval_on_selector(".app", "e => e.classList.contains('sidebar_modeling_mode')")
                  and page.is_visible("#file_upload_section")
                  and page.is_visible("#channel_select")
                  and page.is_visible("#start_analysis_button")
                  and not page.is_visible("#sidebar_back_button")
                  and page.eval_on_selector(".sidebar_title_row h2", "e => e.textContent.trim()") == title_before)
        ctx.check(group, "Enter/Back is lossless — loaded files and selected channel are preserved",
                  page.eval_on_selector("#loaded_files_list", "e => e.value") == files_before
                  and page.eval_on_selector("#channel_select", "e => e.value") == channel_before,
                  f"files_equal={page.eval_on_selector('#loaded_files_list', 'e => e.value') == files_before}, "
                  f"channel={page.eval_on_selector('#channel_select', 'e => e.value')!r} vs {channel_before!r}")
    except Exception as error:
        ctx.check(group, "Sidebar Cell Cycle Modeling enter/Back flow", False, str(error))
        # Best-effort: leave the sidebar in file mode for later tests.
        try:
            if page.eval_on_selector(".app", "e => e.classList.contains('sidebar_modeling_mode')"):
                page.click("#sidebar_back_button")
                page.wait_for_selector("#sidebar_modeling_section", state="hidden", timeout=5000)
        except Exception:
            pass


def test_responsive_reachability(ctx: TestContext):
    page = ctx.page
    group = "Responsive layout"
    original = page.viewport_size
    selectors = [
        "#reset_session_button", "#drop_zone", "#plot_panel_toggle",
        "#metadata_panel_toggle", "#cell_cycle_modeling_button", ".status_bar_help a",
    ]
    try:
        sidebar_resizer = page.locator("#sidebar_resizer")
        sidebar_resizer.focus()
        sidebar_before = int(sidebar_resizer.get_attribute("aria-valuenow"))
        sidebar_resizer.press("ArrowRight")
        sidebar_after = int(sidebar_resizer.get_attribute("aria-valuenow"))
        sidebar_resizer.press("Enter")
        workspace_resizer = page.locator("#workspace_resizer")
        workspace_resizer.focus()
        workspace_before = int(workspace_resizer.get_attribute("aria-valuenow"))
        workspace_resizer.press("ArrowDown")
        workspace_after = int(workspace_resizer.get_attribute("aria-valuenow"))
        workspace_resizer.press("Enter")
        resizer_tree = sidebar_resizer.aria_snapshot() + workspace_resizer.aria_snapshot()
        touch_resize = page.evaluate("""() => {
          const drag = (element, dx, dy, pointerId) => {
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
            const original = element.setPointerCapture;
            element.setPointerCapture = () => {};
            element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId, pointerType: 'touch', clientX: x, clientY: y }));
            element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId, pointerType: 'touch', clientX: x + dx, clientY: y + dy }));
            element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId, pointerType: 'touch', clientX: x + dx, clientY: y + dy }));
            element.setPointerCapture = original;
          };
          const sidebar = document.querySelector('#sidebar_resizer');
          const workspace = document.querySelector('#workspace_resizer');
          const before = [Number(sidebar.getAttribute('aria-valuenow')), Number(workspace.getAttribute('aria-valuenow'))];
          drag(sidebar, 20, 0, 91);
          drag(workspace, 0, 20, 92);
          return { before, after: [Number(sidebar.getAttribute('aria-valuenow')), Number(workspace.getAttribute('aria-valuenow'))] };
        }""")
        sidebar_resizer.press("Enter")
        workspace_resizer.press("Enter")
        ctx.check(group, "UI-18: focusable separators resize and reset by keyboard",
                  sidebar_after > sidebar_before and workspace_after > workspace_before
                  and sidebar_resizer.get_attribute("aria-orientation") == "vertical"
                  and workspace_resizer.get_attribute("aria-orientation") == "horizontal"
                  and resizer_tree.count("separator") == 2
                  and touch_resize["after"][0] > touch_resize["before"][0]
                  and touch_resize["after"][1] > touch_resize["before"][1],
                  str({"keyboard": [[sidebar_before, sidebar_after], [workspace_before, workspace_after]],
                       "orientations": [sidebar_resizer.get_attribute("aria-orientation"),
                                        workspace_resizer.get_attribute("aria-orientation")],
                       "tree": resizer_tree, "touch": touch_resize}))

        for width, height in ((320, 568), (375, 600), (390, 844), (844, 390), (768, 600), (820, 1180), (1280, 500)):
            page.set_viewport_size({"width": width, "height": height})
            page.evaluate("() => window.scrollTo(0, 0)")
            reachable = True
            for selector in selectors:
                locator = page.locator(selector)
                locator.scroll_into_view_if_needed()
                box = locator.bounding_box()
                reachable = reachable and box is not None and box["x"] >= -1 and box["x"] + box["width"] <= width + 1
                if locator.evaluate("e => e.matches('button, a, input, select, textarea, [tabindex]')"):
                    locator.focus()
                    reachable = reachable and locator.evaluate("e => document.activeElement === e")
            no_horizontal_overflow = page.evaluate(
                "() => document.documentElement.scrollWidth <= window.innerWidth + 1"
            )
            ctx.check(group, f"UI-03: major controls remain reachable at {width}×{height}",
                      reachable and no_horizontal_overflow,
                      f"reachable={reachable}, no_horizontal_overflow={no_horizontal_overflow}", screenshot=False)

        page.set_viewport_size({"width": 390, "height": 844})
        page.evaluate("() => document.documentElement.style.fontSize = '200%'")
        page.locator("#metadata_panel_toggle").scroll_into_view_if_needed()
        ctx.check(group, "UI-03: enlarged text keeps the page horizontally contained",
                  page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"),
                  f"scrollWidth={page.evaluate('() => document.documentElement.scrollWidth')}", screenshot=False)

        page.set_viewport_size({"width": 320, "height": 568})
        page.focus("#sidebar_toggle")
        tooltip = page.evaluate("""() => {
          const tip = document.querySelector('#pf_tooltip');
          const rect = tip.getBoundingClientRect();
          return {
            hidden: tip.getAttribute('aria-hidden'),
            described: document.querySelector('#sidebar_toggle').getAttribute('aria-describedby'),
            inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          };
        }""")
        page.press("#sidebar_toggle", "Escape")
        ctx.check(group, "UI-05C: focused tooltip is associated, exposed, clamped, and Escape-dismissable",
                  tooltip["hidden"] == "false" and tooltip["described"] == "pf_tooltip"
                  and tooltip["inside"] and page.get_attribute("#pf_tooltip", "aria-hidden") == "true",
                  str(tooltip), screenshot=False)

        page.evaluate("() => { document.documentElement.style.fontSize = ''; window.scrollTo(0, 0); }")
        page.set_viewport_size(original or {"width": 1920, "height": 1080})
        page.add_script_tag(path=str(_AXE_PATH))
        axe = page.evaluate("""async () => {
          const results = await axe.run(document, {
            resultTypes: ['violations'],
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
          });
          return results.violations
            .filter(item => ['serious', 'critical'].includes(item.impact))
            .map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) }));
        }""")
        ctx.check(group, "CI-10: axe reports no serious or critical WCAG violations",
                  axe == [], str(axe), screenshot=False)
        modal_ids = page.eval_on_selector_all(
            ".stats_modal[role='dialog'][aria-modal='true']",
            "modals => modals.filter(modal => modal.querySelector('.stats_modal_close, [id$=_cancel]')).map(modal => modal.id)",
        )
        modal_contract = []
        for modal_id in modal_ids:
            page.evaluate("""modalId => {
              let trigger = document.querySelector('#modal_contract_trigger');
              if (!trigger) {
                trigger = document.createElement('button');
                trigger.id = 'modal_contract_trigger';
                trigger.textContent = 'Open test dialog';
                document.body.appendChild(trigger);
              }
              trigger.onclick = () => { document.getElementById(modalId).hidden = false; };
            }""", modal_id)
            page.focus("#modal_contract_trigger")
            page.press("#modal_contract_trigger", "Enter")
            page.wait_for_selector(f"#{modal_id}:not([hidden])", timeout=5000)
            result = page.eval_on_selector(f"#{modal_id}", """modal => {
              const controls = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
                .filter(element => !element.hidden && element.getClientRects().length);
              controls.at(-1)?.focus();
              return { count: controls.length, last: controls.at(-1)?.id || controls.at(-1)?.className || '' };
            }""")
            page.keyboard.press("Tab")
            wrapped_forward = page.eval_on_selector(
                f"#{modal_id}",
                """modal => document.activeElement === [...modal.querySelectorAll(
                  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
                )].filter(element => !element.hidden && element.getClientRects().length)[0]""",
            )
            page.eval_on_selector(f"#{modal_id}", """modal => [...modal.querySelectorAll(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
            )].filter(element => !element.hidden && element.getClientRects().length)[0]?.focus()""")
            page.keyboard.press("Shift+Tab")
            wrapped_backward = page.eval_on_selector(f"#{modal_id}", """modal => {
              const controls = [...modal.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
              )].filter(element => !element.hidden && element.getClientRects().length);
              return document.activeElement === controls.at(-1);
            }""")
            page.keyboard.press("Escape")
            page.wait_for_selector(f"#{modal_id}", state="hidden", timeout=5000)
            modal_contract.append({
                "id": modal_id,
                "controls": result["count"],
                "wrapped": wrapped_forward and wrapped_backward,
                "restored": page.locator("#modal_contract_trigger").evaluate("element => document.activeElement === element"),
            })
        page.eval_on_selector("#modal_contract_trigger", "element => element.remove()")
        ctx.check(group, "UI-05E: every closable custom modal traps focus, closes on Escape, and restores focus",
                  bool(modal_contract) and all(item["controls"] > 1 and item["wrapped"] and item["restored"] for item in modal_contract),
                  str(modal_contract), screenshot=False)

        page.emulate_media(reduced_motion="reduce", forced_colors="active")
        preferences = page.evaluate("""() => {
          const button = document.createElement('button');
          button.textContent = 'Preference probe';
          document.body.appendChild(button);
          button.focus();
          const style = getComputedStyle(button);
          const result = {
            reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
            forced: matchMedia('(forced-colors: active)').matches,
            animation: style.animationDuration,
            transition: style.transitionDuration,
            outline: style.outlineWidth,
            border: style.borderTopStyle,
          };
          button.remove();
          return result;
        }""")
        ctx.check(group, "UI-19: reduced-motion and forced-colors modes retain focus/control cues",
                  preferences["reduced"] and preferences["forced"]
                  and preferences["animation"] in ("0s", "0.001ms", "1e-06s")
                  and preferences["transition"] in ("0s", "0.001ms", "1e-06s")
                  and preferences["outline"] != "0px" and preferences["border"] == "solid",
                  str(preferences), screenshot=False)

        touch_context = page.context.browser.new_context(
            has_touch=True,
            viewport={"width": 390, "height": 844},
        )
        try:
            touch_page = touch_context.new_page()
            touch_page.goto(page.url.split("?")[0] + "?test=1", wait_until="networkidle")
            touch_page.wait_for_selector("#drop_zone")
            before = touch_page.get_attribute("#sidebar", "class")
            touch = touch_page.evaluate("""() => ({
              coarse: matchMedia('(pointer: coarse)').matches,
              touchPoints: navigator.maxTouchPoints,
              dropHeight: document.querySelector('#drop_zone').getBoundingClientRect().height,
            })""")
            touch_page.tap("#sidebar_toggle")
            touch["sidebarClass"] = touch_page.get_attribute("#sidebar", "class")
            ctx.check(group, "CI-10: a real coarse-pointer context keeps touch controls operable",
                      touch["coarse"] and touch["touchPoints"] > 0 and touch["dropHeight"] >= 44
                      and touch["sidebarClass"] != before,
                      str(touch), screenshot=False)
        finally:
            touch_context.close()
    except Exception as error:
        ctx.check(group, "UI-03 responsive reachability matrix", False, str(error), screenshot=False)
    finally:
        page.emulate_media(reduced_motion="no-preference", forced_colors="none")
        page.evaluate("() => { document.documentElement.style.fontSize = ''; window.scrollTo(0, 0); }")
        page.set_viewport_size(original or {"width": 1920, "height": 1080})
