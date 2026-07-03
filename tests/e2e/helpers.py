#!/usr/bin/env python3
"""Shared test infrastructure for the PhaseFinder test suite.

Provides TestContext, TestResult, all DOM/action helpers, synthetic FCS
generation, video-clip extraction, and combined HTML+Markdown report writers.
"""

import base64
import glob
import html
import os
import random
import shutil
import struct
import subprocess
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from playwright.sync_api import Page

STATUS_PASS = "PASS"
STATUS_FAIL = "FAIL"
STATUS_WARN = "WARN"

DEFAULT_DATA = "/fast/mike/latentlens/projects/flow_plotter/flow_data"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class TestResult:
    number: int
    group: str
    name: str
    status: str
    detail: str = ""
    screenshot: str = ""
    video_clip: str = ""
    video_start_sec: float = 0.0
    video_end_sec: float = 0.0
    duration_ms: int = 0


@dataclass
class TestContext:
    page: Page
    results_dir: Path
    report_stem: str
    results: List[TestResult] = field(default_factory=list)
    page_errors: List[str] = field(default_factory=list)
    video_record_start: float = 0.0
    number_offset: int = 0

    def __post_init__(self):
        self._last_test_end = self.video_record_start

    def record(self, group: str, name: str, status: str, detail: str = "", screenshot: bool = True):
        now = time.monotonic()
        start_sec = self._last_test_end - self.video_record_start
        end_sec = now - self.video_record_start
        self._last_test_end = now

        number = len(self.results) + 1 + self.number_offset
        shot_rel = ""

        # Always screenshot on FAIL; respect caller flag for PASS/WARN
        if screenshot or status == STATUS_FAIL:
            img_dir, _ = results_asset_dirs(self.results_dir)
            img_dir.mkdir(parents=True, exist_ok=True)
            shot_name = f"{self.report_stem}_{number:03d}.png"
            shot_path = img_dir / shot_name
            try:
                self.page.screenshot(path=str(shot_path), full_page=False)
                shot_rel = f"assets/img/{shot_name}"
            except Exception as error:
                if status == STATUS_PASS:
                    status = STATUS_WARN
                detail = join_detail(detail, f"screenshot failed: {error}")

        result = TestResult(
            number=number,
            group=group,
            name=name,
            status=status,
            detail=detail,
            screenshot=shot_rel,
            video_start_sec=start_sec,
            video_end_sec=end_sec,
            duration_ms=int((end_sec - start_sec) * 1000),
        )
        self.results.append(result)
        return result

    def check(self, group: str, name: str, ok: bool, detail: str = "", screenshot: bool = True):
        self.record(group, name, STATUS_PASS if ok else STATUS_FAIL, detail, screenshot)

    def warn(self, group: str, name: str, detail: str, screenshot: bool = True):
        self.record(group, name, STATUS_WARN, detail, screenshot)


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------

def join_detail(*parts):
    return " | ".join(str(p) for p in parts if p)


def wait_briefly(seconds=0.25):
    time.sleep(seconds)


def strip_fcs(path):
    return Path(path).name.replace(".fcs", "")


def results_asset_dirs(results_dir: Path):
    assets_dir = results_dir / "assets"
    return assets_dir / "img", assets_dir / "vid"


def prepare_results_dir(results_dir: Path):
    """Create result asset directories and clear generated media/reports."""
    results_dir.mkdir(parents=True, exist_ok=True)
    img_dir, vid_dir = results_asset_dirs(results_dir)

    for asset_dir in (img_dir, vid_dir):
        asset_dir.mkdir(parents=True, exist_ok=True)
        for path in asset_dir.iterdir():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()

    for pattern in ("*.html", "*.md", "*.png", "flow_e2e_*.webm", "page@*.webm"):
        for path in results_dir.glob(pattern):
            if path.is_file() or path.is_symlink():
                path.unlink()

    for pattern in ("flow_e2e_*_fixtures", "flow_e2e_*_synthetic_pool"):
        for path in results_dir.glob(pattern):
            if path.is_dir():
                shutil.rmtree(path)

    return img_dir, vid_dir


@contextmanager
def suspended_local_autoload_config(repo_root: Path):
    """Temporarily move phasefinder_local.json out of the way for a test run.

    phasefinder_local.json is a personal, uncommitted dev-convenience file
    (see phasefinder_local.example.json) that can point session.js's startup
    auto-load at an arbitrary session file + data directory on every page
    load. When the local test server serves the app root, the app under
    test picks it up exactly like a real user's browser would — silently
    loading extra files that desync every row-count assertion in this suite.
    Move it aside before the run and restore it (unmodified) afterward.
    """
    config_path = repo_root / "phasefinder_local.json"
    backup_path = repo_root / "phasefinder_local.json.e2e_suspended"
    moved = False
    if config_path.exists():
        config_path.rename(backup_path)
        moved = True
    try:
        yield
    finally:
        if moved:
            backup_path.rename(config_path)


def prepare_test_data_dir(test_data_dir: Path):
    """Create the synthetic test data directory and clear prior generated files."""
    test_data_dir.mkdir(parents=True, exist_ok=True)
    for path in test_data_dir.iterdir():
        if path.name == ".gitkeep":
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    return test_data_dir


# ---------------------------------------------------------------------------
# FCS file helpers
# ---------------------------------------------------------------------------

def fcs_files(data_dir, count):
    files = sorted(glob.glob(os.path.join(data_dir, "*.fcs")))
    if len(files) < count:
        raise RuntimeError(f"Need at least {count} .fcs files under {data_dir}; found {len(files)}")
    return files[:count]


SYNTHETIC_ANNOTATION_CYCLE = (
    ("a", "N"),
    ("b", "Y"),
    ("c", "N"),
    ("a", "Y"),
    ("b", "N"),
    ("c", "Y"),
)


def synthetic_annotation(seed):
    return SYNTHETIC_ANNOTATION_CYCLE[(seed - 1) % len(SYNTHETIC_ANNOTATION_CYCLE)]


def write_synthetic_fcs(path, seed, strain, timepoint, events=6000, replicate=None, nocodazole_arrest=None):
    if replicate is None or nocodazole_arrest is None:
        default_replicate, default_arrest = synthetic_annotation(seed)
        replicate = replicate or default_replicate
        nocodazole_arrest = nocodazole_arrest or default_arrest

    rng = random.Random(seed)
    rows = []
    for index in range(events):
        if index % 10 == 0:
            area = rng.gauss(64000, 4500)
        elif index % 10 in (1, 2):
            area = rng.gauss(128000, 7000)
        else:
            area = rng.uniform(68000, 122000)
        area = max(1000, area)
        height = max(500, area / rng.uniform(1.8, 2.2))
        width = max(100, rng.gauss(2.0, 0.12))
        secondary_area = max(1000, area * rng.uniform(0.55, 0.85) + rng.gauss(0, 3500))
        secondary_height = max(500, secondary_area / rng.uniform(1.8, 2.2))
        secondary_width = max(100, rng.gauss(2.0, 0.12))
        rows.append((area, height, width, secondary_area, secondary_height, secondary_width))

    data = b"".join(struct.pack("<ffffff", *row) for row in rows)
    text_begin = 58
    data_begin = 0
    data_end = 0

    pairs = [
        "$BEGINANALYSIS", "0", "$ENDANALYSIS", "0",
        "$BYTEORD", "1,2,3,4", "$DATATYPE", "F", "$MODE", "L", "$NEXTDATA", "0",
        "$PAR", "6", "$TOT", str(events),
        "$P1B", "32", "$P1E", "0,0", "$P1N", "GFP/FITC-A", "$P1R", "262144", "$P1S", "GFP/FITC-A",
        "$P2B", "32", "$P2E", "0,0", "$P2N", "GFP/FITC-H", "$P2R", "262144", "$P2S", "GFP/FITC-H",
        "$P3B", "32", "$P3E", "0,0", "$P3N", "GFP/FITC-W", "$P3R", "262144", "$P3S", "GFP/FITC-W",
        "$P4B", "32", "$P4E", "0,0", "$P4N", "mCherry/PE-A", "$P4R", "262144", "$P4S", "mCherry/PE-A",
        "$P5B", "32", "$P5E", "0,0", "$P5N", "mCherry/PE-H", "$P5R", "262144", "$P5S", "mCherry/PE-H",
        "$P6B", "32", "$P6E", "0,0", "$P6N", "mCherry/PE-W", "$P6R", "262144", "$P6S", "mCherry/PE-W",
    ]

    while True:
        dynamic = ["$BEGINDATA", str(data_begin), "$ENDDATA", str(data_end)]
        tokens = pairs + dynamic
        text = "|" + "|".join(tokens) + "|"
        text_bytes = text.encode("ascii")
        text_end = text_begin + len(text_bytes) - 1
        next_data_begin = text_end + 1
        next_data_end = next_data_begin + len(data) - 1
        if next_data_begin == data_begin and next_data_end == data_end:
            break
        data_begin = next_data_begin
        data_end = next_data_end

    header = f"FCS3.1    {text_begin:>8}{text_end:>8}{data_begin:>8}{data_end:>8}{0:>8}{0:>8}".encode("ascii")
    if len(header) != 58:
        raise RuntimeError(f"Invalid synthetic FCS header length: {len(header)}")

    filename = f"EDS2026-03-06_{strain}{replicate}{nocodazole_arrest} t{timepoint}__E2E{seed}.0001.fcs"
    out = path / filename
    out.write_bytes(header + text_bytes + data)
    return str(out)


def make_drag_drop_fixtures(results_dir, report_stem, count=2):
    fixture_dir = results_dir / f"{report_stem}_fixtures"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    return [
        write_synthetic_fcs(fixture_dir, seed=idx + 1, strain=900 + idx, timepoint=35 + idx * 10)
        for idx in range(count)
    ]


def make_synthetic_fcs_pool(results_dir, report_stem, count):
    fixture_dir = results_dir / f"{report_stem}_synthetic_pool"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    return [
        write_synthetic_fcs(
            fixture_dir,
            seed=idx + 101,
            strain=800 + idx,
            timepoint=20 + idx * 5,
        )
        for idx in range(count)
    ]


# ---------------------------------------------------------------------------
# DOM query helpers
# ---------------------------------------------------------------------------

def density_curve_count(page):
    return page.eval_on_selector_all(
        "#plot_area svg path",
        "els => els.filter(p => (p.getAttribute('stroke')||'').startsWith('hsl')).length",
    )


def fit_curve_count(page):
    return page.eval_on_selector_all(
        "#plot_area svg path",
        "els => els.filter(p => p.getAttribute('stroke') === '#111827' && p.getAttribute('stroke-width') === '2').length",
    )


def table_row_count(page):
    return page.eval_on_selector_all(".file_table tbody tr", "rows => rows.length")


def selected_row_count(page):
    return page.eval_on_selector_all(".file_table tbody .row_select", "els => els.filter(e => e.checked).length")


def status_bar_text(page):
    return page.eval_on_selector("#status_bar_message", "e => e.textContent.trim()")


def progress_visible(page):
    return page.eval_on_selector("#progress_overlay", "e => !e.hidden")


def progress_label(page):
    return page.eval_on_selector("#progress_label", "e => e.textContent.trim()")


def plot_title(page):
    return page.eval_on_selector("#plot_title", "e => e.textContent.trim()")


def table_values(page, column_index):
    """Return one value per visible table row for the given column index (1-based).
    Prefers the <input> value if the cell contains an input, otherwise uses textContent."""
    return page.eval_on_selector_all(
        ".file_table tbody tr",
        f"""rows => rows.map(r => {{
            const inp = r.querySelector('td:nth-child({column_index}) input');
            if (inp) return inp.value;
            const td = r.querySelector('td:nth-child({column_index})');
            return td ? td.textContent.trim() : '';
        }}
        )""",
    )


# ---------------------------------------------------------------------------
# Wait helpers
# ---------------------------------------------------------------------------

def wait_for_rows(page, count, timeout=60000):
    page.wait_for_function(
        "(count) => document.querySelectorAll('.file_table tbody .row_select').length === count",
        arg=count,
        timeout=timeout,
    )


def wait_for_curves(page, count, timeout=120000):
    page.wait_for_function(
        """(count) => [...document.querySelectorAll('#plot_area svg path')]
          .filter(p => (p.getAttribute('stroke')||'').startsWith('hsl')).length === count""",
        arg=count,
        timeout=timeout,
    )


def dismiss_metadata_wizard_if_open(page, timeout_ms=1500):
    """Close the filename metadata wizard if it auto-opened after a file load.

    The wizard opens ~750ms after the *first* successful file load in a
    session (see schedule_metadata_wizard_after_file_load in ui_controls.js)
    and never again afterward. Left open, its modal backdrop blocks clicks on
    everything behind it, so callers should invoke this once, right after the
    very first file load of a run, before doing anything else.
    """
    try:
        page.wait_for_selector("#metadata_wizard_modal:not([hidden])", timeout=timeout_ms)
    except Exception:
        return False
    page.click("#metadata_wizard_cancel")
    wait_briefly(0.2)
    return True


def configure_default_metadata_wizard_columns(page, timeout_ms=3000):
    """Configure and apply the filename metadata wizard's default Strain /
    Replicate / Nocodazole Arrest / Timepoint columns, matching the naming
    convention used by write_synthetic_fcs() (and the app's own sample
    session): "<strain digits><replicate letter><arrest letter> t<timepoint>".

    Annotation guessing from filenames is no longer automatic (that logic is
    dead code in ui_controls.js) — the wizard is now the only way these
    columns get populated. Downstream tests (sorting/filtering by
    strain/replicate/timepoint, coloring plots by strain, per-sample
    annotations in the DJF fit table) all depend on these columns existing,
    so this is called once, right after the very first file load of a run.

    Returns True if the wizard was found and configured, False if it never
    auto-opened (callers should treat that as a soft failure).
    """
    try:
        page.wait_for_selector("#metadata_wizard_modal:not([hidden])", timeout=timeout_ms)
    except Exception:
        return False

    # Step 0 (pre-existing default delimiter "_" step): the date-ish prefix.
    page.fill('.metadata_split_step[data-step-index="0"] .metadata_step_column_name', "Date")
    page.check('.metadata_split_step[data-step-index="0"] .metadata_step_hide')

    regex_steps = [
        (r"^(\d+)", "Strain"),
        (r"^([A-Za-z])", "Replicate"),
        (r"^([A-Za-z])", "Nocodazole Arrest"),
        (r"t(\d+)", "Timepoint"),
    ]
    for offset, (pattern, label) in enumerate(regex_steps, start=1):
        page.click("#metadata_add_split_step")
        row = f'.metadata_split_step[data-step-index="{offset}"]'
        page.select_option(f"{row} .metadata_split_type", "regex")
        page.fill(f"{row} .metadata_step_regex", pattern)
        page.fill(f"{row} .metadata_step_column_name", label)

    # Remainder (whatever text is left after all steps): hide it.
    page.fill("#metadata_column_editor .metadata_column_name", "Well")
    page.check("#metadata_column_editor .metadata_leaf_hide input")

    page.click("#metadata_wizard_apply")
    wait_briefly(0.3)
    return True


def try_catch_progress(page, timeout_ms=8000):
    """Return True if the progress overlay was observed as visible within timeout_ms."""
    try:
        page.wait_for_selector("#progress_overlay:not([hidden])", timeout=timeout_ms)
        return True
    except Exception:
        return False


def wait_for_overlay_hidden(page, timeout_ms=20000):
    """Block until the progress overlay is hidden (state='hidden' — not visible in the DOM)."""
    try:
        # state="hidden" waits until the element is not visible (display:none / [hidden] attr)
        page.wait_for_selector("#progress_overlay", state="hidden", timeout=timeout_ms)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Action helpers
# ---------------------------------------------------------------------------

def set_files_via_file_browser(page, click_selector, files):
    with page.expect_file_chooser() as chooser_info:
        page.click(click_selector)
    chooser_info.value.set_files(files)


def set_files_via_drag_drop(page, target_selector, files):
    payload = []
    for path in files:
        data = Path(path).read_bytes()
        payload.append({
            "name": Path(path).name,
            "mime": "application/octet-stream",
            "b64": base64.b64encode(data).decode("ascii"),
        })

    page.evaluate(
        """async ({ selector, files }) => {
          const target = document.querySelector(selector);
          const transfer = new DataTransfer();
          for (const file of files) {
            const binary = atob(file.b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            transfer.items.add(new File([bytes], file.name, { type: file.mime }));
          }
          for (const eventName of ['dragenter', 'dragover', 'drop']) {
            target.dispatchEvent(new DragEvent(eventName, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }));
          }
        }""",
        {"selector": target_selector, "files": payload},
    )


def select_channel(page, channel):
    page.select_option("#channel_select", channel)
    wait_briefly(0.2)


def click_plot_events(page):
    page.click("#start_analysis_button")
    page.wait_for_selector("#plot_area svg", timeout=120000)
    wait_briefly(0.4)


def select_all_visible_rows(page):
    if page.query_selector("#select_all_files") is None:
        return
    if not page.eval_on_selector("#select_all_files", "e => e.checked && !e.indeterminate"):
        page.click("#select_all_files")
        wait_briefly(0.3)


def ensure_channel_option(page, preferred="GFP/FITC-A"):
    options = page.eval_on_selector_all("#channel_select option", "els => els.map(e => e.value).filter(Boolean)")
    if preferred in options:
        return preferred, None
    if options:
        return options[0], f"{preferred} unavailable; used {options[0]}"
    raise RuntimeError("No channel options were populated")


def another_channel(page, current):
    options = page.eval_on_selector_all("#channel_select option", "els => els.map(e => e.value).filter(Boolean)")
    for option in options:
        if option != current:
            return option
    return None


def open_filter(page, header_label):
    headers = page.query_selector_all(".file_table thead th")
    for header in headers:
        if header_label in header.inner_text():
            header.query_selector(".th_filter_toggle").click()
            return
    raise RuntimeError(f"Could not find filter header: {header_label!r}")


def set_filter_option(page, field, value, checked):
    page.evaluate(
        """({ field, value, checked }) => {
          const selector = `.th_filter_option[data-filter-field="${field}"]`;
          const input = [...document.querySelectorAll(selector)].find(el => el.value === value);
          if (!input) throw new Error(`Filter option not found: ${field}=${value}`);
          input.checked = checked;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        {"field": field, "value": value, "checked": checked},
    )


def close_filter(page):
    """Close any open filter menu by pressing Escape then clicking away."""
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    try:
        # Dispatch a neutral click that bubbles to document, closing the filter
        # dropdown without hitting any interactive element (logo, buttons, etc.).
        page.evaluate(
            "document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))"
        )
    except Exception:
        pass
    wait_briefly(0.2)


# ---------------------------------------------------------------------------
# Video clip extraction
# ---------------------------------------------------------------------------

def extract_video_clips(ctx: TestContext, full_video_path: str, results_dir: Path, stem: str):
    """Use ffmpeg to trim per-test video clips from the full session recording."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return

    for result in ctx.results:
        start = max(0.0, result.video_start_sec - 0.3)
        duration = max(0.5, (result.video_end_sec - result.video_start_sec) + 0.6)
        clip_name = f"{stem}_{result.number:03d}.webm"
        _, vid_dir = results_asset_dirs(results_dir)
        vid_dir.mkdir(parents=True, exist_ok=True)
        clip_path = vid_dir / clip_name
        try:
            subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-ss", f"{start:.3f}",
                    "-t", f"{duration:.3f}",
                    "-i", full_video_path,
                    "-filter:v", "setpts=2.0*PTS",
                    "-r", "12.5",
                    "-avoid_negative_ts", "make_zero",
                    str(clip_path),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )
            result.video_clip = f"assets/vid/{clip_name}"
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Result tallying
# ---------------------------------------------------------------------------

def result_counts(results):
    groups = []
    for r in results:
        if r.group not in groups:
            groups.append(r.group)
    counts = {g: {STATUS_PASS: 0, STATUS_WARN: 0, STATUS_FAIL: 0} for g in groups}
    for r in results:
        counts[r.group][r.status] += 1
    return groups, counts


# ---------------------------------------------------------------------------
# Combined report writers
# ---------------------------------------------------------------------------

def _badge_html(status):
    return f"<span class='badge {status.lower()}'>{status}</span>"


def _test_card_html(result: TestResult):
    media = ""
    if result.video_clip:
        fallback = f"<img src='{html.escape(result.screenshot)}' />" if result.screenshot else ""
        media = (
            f"<div class='video-wrap'>"
            f"<video src='{html.escape(result.video_clip)}' controls preload='metadata'>"
            f"{fallback}"
            f"</video></div>"
        )
    elif result.screenshot:
        media = f"<img src='{html.escape(result.screenshot)}' alt='screenshot' />"

    detail_html = f"<p class='detail'>{html.escape(result.detail)}</p>" if result.detail else ""

    return (
        f"<div class='test-card'>"
        f"<div class='test-header'>"
        f"<span class='test-label'>{result.number}. {html.escape(result.name)}</span>"
        f"{_badge_html(result.status)}"
        f"</div>"
        f"{detail_html}"
        f"{media}"
        f"</div><hr />"
    )


def _summary_table_html(groups, counts):
    header = "<tr><th>Group</th><th>PASS</th><th>WARN</th><th>FAIL</th></tr>"
    rows = "\n".join(
        f"<tr><td>{html.escape(g)}</td>"
        f"<td>{counts[g][STATUS_PASS]}</td>"
        f"<td>{counts[g][STATUS_WARN]}</td>"
        f"<td>{counts[g][STATUS_FAIL]}</td></tr>"
        for g in groups
    )
    return f"<table>{header}\n{rows}</table>"


def write_combined_report(
    e2e_ctx: TestContext,
    unit_ctx: Optional["TestContext"],
    results_dir: Path,
    stem: str,
):
    """Write combined HTML and Markdown reports covering e2e and unit test results."""
    all_results = list(e2e_ctx.results) + (list(unit_ctx.results) if unit_ctx else [])
    total = len(all_results)
    passed = sum(1 for r in all_results if r.status == STATUS_PASS)
    warned = sum(1 for r in all_results if r.status == STATUS_WARN)
    failed = sum(1 for r in all_results if r.status == STATUS_FAIL)

    e2e_groups, e2e_counts = result_counts(e2e_ctx.results)
    unit_groups, unit_counts = result_counts(unit_ctx.results) if unit_ctx else ([], {})

    _write_html_report(
        e2e_ctx, unit_ctx, e2e_groups, e2e_counts, unit_groups, unit_counts,
        total, passed, warned, failed, results_dir, stem,
    )
    _write_md_report(
        e2e_ctx, unit_ctx, e2e_groups, e2e_counts, unit_groups, unit_counts,
        total, passed, warned, failed, results_dir, stem,
    )
    return results_dir / f"{stem}.md", results_dir / f"{stem}.html"


def _write_html_report(
    e2e_ctx, unit_ctx, e2e_groups, e2e_counts, unit_groups, unit_counts,
    total, passed, warned, failed, results_dir, stem,
):
    ts = datetime.now().isoformat(timespec="seconds")

    e2e_summary = _summary_table_html(e2e_groups, e2e_counts) if e2e_groups else ""
    unit_summary = _summary_table_html(unit_groups, unit_counts) if unit_groups else ""

    def sections_html(ctx, groups):
        out = []
        for g in groups:
            cards = "".join(
                _test_card_html(r) for r in ctx.results if r.group == g
            )
            out.append(f"<h3>{html.escape(g)}</h3>{cards}")
        return "".join(out)

    e2e_sections = sections_html(e2e_ctx, e2e_groups)
    unit_sections = sections_html(unit_ctx, unit_groups) if unit_ctx else ""

    html_out = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PhaseFinder Test Report</title>
  <style>
    body {{ font-family: system-ui, sans-serif; margin: 32px; color: #172033; max-width: 1200px; margin: 32px auto; }}
    h1, h2 {{ color: #072c67; }}
    h3 {{ color: #1a3a6b; border-bottom: 1px solid #d7deea; padding-bottom: 4px; margin-top: 28px; }}
    table {{ border-collapse: collapse; width: 100%; margin: 12px 0 20px; }}
    th, td {{ border: 1px solid #d7deea; padding: 8px 10px; text-align: right; }}
    th:first-child, td:first-child {{ text-align: left; }}
    th {{ background: #eef1f8; }}
    hr {{ border: 0; border-top: 1px solid #d7deea; margin: 20px 0; }}
    .test_card {{ margin: 12px 0 4px; }}
    .test_header {{ display: flex; justify-content: space-between; align-items: center; gap: 16px;
                    font-size: 1.05rem; font-weight: 600; padding: 6px 0; }}
    .test_label {{ flex: 1; }}
    .badge {{ border-radius: 4px; color: white; font-weight: 800; padding: 4px 12px;
              min-width: 60px; text-align: center; flex-shrink: 0; }}
    .pass {{ background: #16803c; }}
    .fail {{ background: #c81e1e; }}
    .warn {{ background: #b7791f; }}
    .detail {{ color: #444; font-size: 0.9rem; margin: 4px 0 8px; white-space: pre-wrap; }}
    img {{ max-width: 100%; border: 1px solid #d7deea; display: block; margin: 8px auto; }}
    .video_wrap {{ display: flex; justify-content: center; margin: 12px 0; }}
    .video_wrap video {{ width: 960px; max-width: 100%; border: 1px solid #d7deea; }}
    .overall {{ background: #f4f6fb; border: 1px solid #d7deea; border-radius: 6px; padding: 12px 16px; margin: 16px 0; }}
    .overall span {{ margin-right: 20px; font-weight: 600; }}
    .overall .p {{ color: #16803c; }}
    .overall .w {{ color: #b7791f; }}
    .overall .f {{ color: #c81e1e; }}
  </style>
</head>
<body>
  <h1>PhaseFinder Test Report</h1>
  <p>Generated: {html.escape(ts)}</p>
  <div class='overall'>
    <span>Total: {total}</span>
    <span class='p'>&#10003; PASS: {passed}</span>
    <span class='w'>&#9888; WARN: {warned}</span>
    <span class='f'>&#10007; FAIL: {failed}</span>
  </div>

  <h2>E2E Test Summary</h2>
  {e2e_summary}

  {"<h2>Unit Test Summary</h2>" + unit_summary if unit_summary else ""}

  <hr />

  <h2>E2E Tests</h2>
  {e2e_sections}

  {"<h2>Unit Tests</h2>" + unit_sections if unit_sections else ""}
</body>
</html>
"""
    (results_dir / f"{stem}.html").write_text(html_out, encoding="utf-8")


def _md_badge(status):
    colors = {STATUS_PASS: "green", STATUS_FAIL: "red", STATUS_WARN: "goldenrod"}
    return f"<span style='float:right;color:{colors[status]};font-weight:bold'>{status}</span>"


def _write_md_report(
    e2e_ctx, unit_ctx, e2e_groups, e2e_counts, unit_groups, unit_counts,
    total, passed, warned, failed, results_dir, stem,
):
    ts = datetime.now().isoformat(timespec="seconds")
    lines = [
        "# PhaseFinder Test Report",
        "",
        f"Generated: {ts}",
        "",
        f"**Total: {total}** &nbsp; ✓ PASS: {passed} &nbsp; ⚠ WARN: {warned} &nbsp; ✗ FAIL: {failed}",
        "",
        "## E2E Test Summary",
        "",
        "| Group | PASS | WARN | FAIL |",
        "|---|---:|---:|---:|",
    ]
    for g in e2e_groups:
        lines.append(f"| {g} | {e2e_counts[g][STATUS_PASS]} | {e2e_counts[g][STATUS_WARN]} | {e2e_counts[g][STATUS_FAIL]} |")

    if unit_groups:
        lines += [
            "",
            "## Unit Test Summary",
            "",
            "| Group | PASS | WARN | FAIL |",
            "|---|---:|---:|---:|",
        ]
        for g in unit_groups:
            lines.append(f"| {g} | {unit_counts[g][STATUS_PASS]} | {unit_counts[g][STATUS_WARN]} | {unit_counts[g][STATUS_FAIL]} |")

    lines += ["", "---", "", "## E2E Tests"]

    for g in e2e_groups:
        lines += ["", f"### {html.escape(g)}", ""]
        for r in [x for x in e2e_ctx.results if x.group == g]:
            lines.append(
                f"**{r.number}. {html.escape(r.name)}** {_md_badge(r.status)}"
            )
            if r.detail:
                lines += ["", html.escape(r.detail)]
            if r.video_clip:
                lines += ["", f"<video src='{r.video_clip}' controls width='960' style='display:block;margin:8px auto'></video>"]
            elif r.screenshot:
                lines += ["", f"![{r.number}. {r.name}]({r.screenshot})"]
            lines += ["", "---", ""]

    if unit_ctx and unit_groups:
        lines += ["## Unit Tests"]
        for g in unit_groups:
            lines += ["", f"### {html.escape(g)}", ""]
            for r in [x for x in unit_ctx.results if x.group == g]:
                lines.append(
                    f"**{r.number}. {html.escape(r.name)}** {_md_badge(r.status)}"
                )
                if r.detail:
                    lines += ["", html.escape(r.detail)]
                if r.screenshot:
                    lines += ["", f"![{r.number}. {r.name}]({r.screenshot})"]
                lines += ["", "---", ""]

    (results_dir / f"{stem}.md").write_text("\n".join(lines), encoding="utf-8")
