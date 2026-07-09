#!/usr/bin/env python3
"""Summary Statistics modal tests: channel selection, calculating multiple
stats, already-computed metrics being disabled on reopen, the "All" checkbox,
and auto-computing stats for files loaded after the fact."""

from helpers import (
    TestContext,
    set_files_via_drag_drop,
    wait_briefly,
    wait_for_rows,
    write_synthetic_fcs,
)

STATS_CHANNEL = "GFP/FITC-A"


def _make_stats_fixture(ctx, seed, strain, timepoint, replicate, arrest):
    fixture_dir = ctx.results_dir / f"{ctx.report_stem}_stats_fixtures"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    return write_synthetic_fcs(
        fixture_dir, seed=seed, strain=strain, timepoint=timepoint,
        replicate=replicate, nocodazole_arrest=arrest,
    )


def _frame_stat(page, channel, metric, name_fragment):
    """Read a computed CHANNEL:metric value directly from the app's table
    frame for the row whose filename contains name_fragment. Reading the
    frame directly (rather than scraping table cell positions, which shift
    depending on how many stats groups/columns are present) is robust
    regardless of what else has been loaded earlier in the suite."""
    return page.evaluate(
        """({ channel, metric, fragment }) => {
          const frame = window.PhaseFinder.app.get_file_table();
          const names = [...frame.col('name')];
          const idx = names.findIndex((n) => n.includes(fragment));
          if (idx < 0) return null;
          const col = frame.col(`${channel}:${metric}`);
          return col.length ? col[idx] : null;
        }""",
        {"channel": channel, "metric": metric, "fragment": name_fragment},
    )


def test_summary_statistics(ctx: TestContext):
    page = ctx.page
    group = "Summary Statistics"

    fixture_a = _make_stats_fixture(ctx, seed=8801, strain="9801", timepoint="11", replicate="x", arrest="N")
    fixture_b = _make_stats_fixture(ctx, seed=8802, strain="9802", timepoint="22", replicate="y", arrest="Y")

    before = page.eval_on_selector_all(".file_table tbody .row_select", "els => els.length")
    set_files_via_drag_drop(page, "#drop_zone", [fixture_a, fixture_b])
    wait_for_rows(page, before + 2)

    # --- open modal, verify defaults ---
    page.click("#calculate_stats_button")
    ctx.check(group, "Calculate Statistics modal opens",
              not page.eval_on_selector("#stats_modal", "e => e.hidden"))

    page.select_option("#stats_channel_select", STATS_CHANNEL)
    default_checked = page.eval_on_selector_all(
        'input[name="stat"]:not([value="all"])',
        "els => els.filter(e => e.checked).map(e => e.value)",
    )
    ctx.check(group, "Mean and Std Dev are checked by default",
              set(default_checked) == {"mean", "stddev"}, str(default_checked))

    # Add Median to the default selection, then calculate.
    page.check('input[name="stat"][value="median"]')
    page.click("#stats_calculate_button")
    page.wait_for_function("() => document.querySelector('#stats_modal').hidden", timeout=30000)
    wait_briefly(0.3)

    header_text = " ".join(page.eval_on_selector_all(".file_table thead th", "els => els.map(e => e.textContent)"))
    ctx.check(group, "Computed stats add a grouped column header",
              STATS_CHANNEL in header_text and "Summary Statistics" in header_text, header_text[:200])

    mean_a = _frame_stat(page, STATS_CHANNEL, "mean", "E2E8801")
    stddev_a = _frame_stat(page, STATS_CHANNEL, "stddev", "E2E8801")
    median_a = _frame_stat(page, STATS_CHANNEL, "median", "E2E8801")
    ctx.check(group, "Mean/Std Dev/Median are computed and stored for the selected channel",
              all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (mean_a, stddev_a, median_a)),
              f"mean={mean_a}, stddev={stddev_a}, median={median_a}")

    # --- reopening the modal disables already-computed stats ---
    page.click("#calculate_stats_button")
    page.select_option("#stats_channel_select", STATS_CHANNEL)
    wait_briefly(0.2)
    disabled_map = page.evaluate(
        """() => Object.fromEntries([...document.querySelectorAll('input[name="stat"]:not([value="all"])')]
          .map((e) => [e.value, e.disabled]))"""
    )
    ctx.check(group, "Already-computed statistics are disabled when reopening the modal",
              disabled_map.get("mean") and disabled_map.get("stddev") and disabled_map.get("median")
              and not disabled_map.get("min") and not disabled_map.get("max"),
              str(disabled_map))

    # --- "All" only toggles the remaining enabled checkboxes ---
    page.check('input[name="stat"][value="all"]')
    checked_after_all = page.evaluate(
        """() => Object.fromEntries([...document.querySelectorAll('input[name="stat"]:not([value="all"])')]
          .map((e) => [e.value, e.checked]))"""
    )
    ctx.check(group, 'The "All" checkbox checks only the remaining enabled statistics (min/max)',
              checked_after_all.get("min") and checked_after_all.get("max")
              and not checked_after_all.get("mean"),
              str(checked_after_all))

    page.click("#stats_calculate_button")
    page.wait_for_function("() => document.querySelector('#stats_modal').hidden", timeout=30000)
    wait_briefly(0.3)

    min_a = _frame_stat(page, STATS_CHANNEL, "min", "E2E8801")
    max_a = _frame_stat(page, STATS_CHANNEL, "max", "E2E8801")
    ctx.check(group, "Min/Max compute correctly and are consistent with the mean",
              isinstance(min_a, (int, float)) and isinstance(max_a, (int, float))
              and min_a <= mean_a <= max_a,
              f"min={min_a}, mean={mean_a}, max={max_a}")

    # --- Escape closes the modal ---
    page.click("#calculate_stats_button")
    page.keyboard.press("Escape")
    ctx.check(group, "Escape key closes the Calculate Statistics modal",
              page.eval_on_selector("#stats_modal", "e => e.hidden"))

    # --- newly loaded files automatically get previously-computed stats ---
    fixture_c = _make_stats_fixture(ctx, seed=8803, strain="9803", timepoint="33", replicate="z", arrest="N")
    before_auto = page.eval_on_selector_all(".file_table tbody .row_select", "els => els.length")
    set_files_via_drag_drop(page, "#drop_zone", [fixture_c])
    wait_for_rows(page, before_auto + 1)

    try:
        page.wait_for_function(
            """(fragment) => {
              const frame = window.PhaseFinder.app.get_file_table();
              const names = [...frame.col('name')];
              const idx = names.findIndex((n) => n.includes(fragment));
              if (idx < 0) return false;
              const col = frame.col('""" + STATS_CHANNEL + """:mean');
              return col.length > 0 && col[idx] != null;
            }""",
            arg="E2E8803",
            timeout=20000,
        )
        auto_mean = _frame_stat(page, STATS_CHANNEL, "mean", "E2E8803")
        ctx.check(group, "Newly loaded files automatically receive previously-computed statistics",
                  isinstance(auto_mean, (int, float)) and not isinstance(auto_mean, bool),
                  f"mean={auto_mean}")
    except Exception as error:
        ctx.check(group, "Newly loaded files automatically receive previously-computed statistics",
                  False, str(error))
