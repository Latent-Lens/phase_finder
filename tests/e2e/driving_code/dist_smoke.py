#!/usr/bin/env python3
"""Production artifact smoke: serve only dist/ and reject broken built paths."""

import json
import re
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urljoin, urlparse

from playwright.sync_api import expect, sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))

from test_server import start_test_server  # noqa: E402
from helpers import (  # noqa: E402
    confirm_time_qc_method,
    dismiss_metadata_wizard_if_open,
    enter_modeling_mode,
    write_synthetic_fcs,
)


def main():
    dist = ROOT / "dist"
    if not (dist / "index.html").exists():
        raise SystemExit("dist/ is missing; run npm run build first")

    port, server = start_test_server(dist)
    base = f"http://127.0.0.1:{port}/"
    failures = []
    requested_urls = []

    def watch(page):
        page.on("request", lambda request: requested_urls.append(request.url))
        page.on("pageerror", lambda error: failures.append(f"page error: {error}"))
        page.on("requestfailed", lambda request: failures.append(f"request failed: {request.url}"))
        page.on("response", lambda response: failures.append(
            f"HTTP {response.status}: {response.url}"
        ) if response.status >= 400 and urlparse(response.url).path != "/sessions/phasefinder_local.json" else None)

    fixture_context = TemporaryDirectory()
    try:
        fixture_dir = Path(fixture_context.name)
        fcs_path = write_synthetic_fcs(fixture_dir, seed=901, strain="dist", timepoint=0, events=20_000)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context()
            page = context.new_page()
            watch(page)
            page.goto(f"{base}?test=1", wait_until="networkidle")
            page.wait_for_selector("#drop_zone")

            for selector in ("#sidebar_toggle", "#metadata_panel_toggle"):
                page.click(selector)
                page.click(selector)
            for image in page.locator("img").all():
                if not image.evaluate("img => img.complete && img.naturalWidth > 0"):
                    failures.append(f"broken built image: {image.get_attribute('src')}")

            manifest_response = context.request.get(urljoin(base, "assets/img/favicon/site.webmanifest"))
            if not manifest_response.ok:
                failures.append(f"manifest HTTP {manifest_response.status}")
            else:
                manifest_url = manifest_response.url
                for icon in json.loads(manifest_response.text()).get("icons", []):
                    response = context.request.get(urljoin(manifest_url, icon["src"]))
                    if not response.ok:
                        failures.append(f"manifest icon HTTP {response.status}: {response.url}")

            with page.expect_file_chooser() as chooser:
                page.click("#drop_zone")
            chooser.value.set_files(str(fcs_path))
            expect(page.locator(".file_table tbody .row_select")).to_have_count(1, timeout=30000)
            dismiss_metadata_wizard_if_open(page)
            expect(page.locator("#progress_overlay")).to_be_hidden(timeout=30000)

            page.select_option("#channel_select", "GFP/FITC-A")
            page.click("#start_analysis_button")
            expect(page.locator("#plot_area svg path[stroke^='hsl']")).to_have_count(1, timeout=120000)
            page.click("#plot_panel_toggle")
            page.click("#plot_panel_toggle")

            enter_modeling_mode(page)
            for stage, selector in enumerate(("#qc_structural", "#qc_time", "#qc_cellgate", "#qc_singlet")):
                if page.get_attribute(selector, "aria-pressed") != "true":
                    page.click(selector)
                    if stage == 0:
                        page.click("#structural_qc_apply")
                    if stage == 1:
                        confirm_time_qc_method(page)
                    expect(page.locator(selector)).to_be_enabled(timeout=30000)
                    if page.locator("#djf_scatter_modal").is_visible():
                        page.click("#djf_scatter_modal_close")
            page.click("#detect_peaks_button")
            expect(page.locator("#peak_regions_accept_button")).to_be_enabled(timeout=30000)
            page.click("#peak_regions_accept_button")
            page.select_option("#cell_cycle_model_select", "watson_pragmatic")
            page.click("#cell_cycle_fit_current_button")
            expect(page.locator("#progress_overlay")).to_be_hidden(timeout=30000)
            expect(page.locator("#cell_cycle_fit_result")).to_be_visible(timeout=30000)
            expect(page.locator(".cell_cycle_fit_result_header")).to_contain_text("Watson Pragmatic")

            page.click("#plot_tool_camera")
            page.check("input[name='plot_export_format'][value='svg']")
            with page.expect_download(timeout=25000) as export_info:
                page.click("#plot_export_download")
            exported_plot = fixture_dir / "dist-smoke.svg"
            export_info.value.save_as(exported_plot)
            exported_svg = exported_plot.read_text(encoding="utf-8")
            if not exported_svg.startswith("<?xml"):
                failures.append("built plot export did not produce SVG")
            if ('id="phasefinder-analysis-provenance"' not in exported_svg
                    or '"applicationVersion":"0.8.0"' not in exported_svg
                    or "phasefinder_export_provenance" not in exported_svg):
                failures.append("built plot export omitted versioned analysis provenance")

            with page.expect_download(timeout=30000) as session_info:
                page.once("dialog", lambda dialog: dialog.accept("dist-smoke.toml"))
                page.click("#save_session_button")
            saved_session = fixture_dir / "dist-smoke.toml"
            session_info.value.save_as(saved_session)
            with page.expect_file_chooser() as chooser:
                page.click("#load_session_button")
            chooser.value.set_files(str(saved_session))
            expect(page.locator("#status_bar_message")).to_contain_text(
                re.compile(r"Session (?:loaded|restored)"), timeout=30000
            )

            for worker in ("data_worker", "copy_worker", "fit_worker"):
                if any(worker in urlparse(url).path for url in requested_urls):
                    continue
                assets = list((dist / "assets").glob(f"{worker}-*.js"))
                response = context.request.get(urljoin(base, f"assets/{assets[0].name}")) if len(assets) == 1 else None
                if response is None or not response.ok:
                    failures.append(f"built {worker} bundle URL failed")

            help_page = context.new_page()
            watch(help_page)
            help_href = page.get_attribute("#status_bar a", "href")
            if not help_href:
                failures.append("Help link is missing")
                help_href = "help/index.html"
            help_page.goto(urljoin(page.url, help_href), wait_until="networkidle")
            if "PhaseFinder Help" not in help_page.title():
                failures.append("Help page title is missing")

            source_requests = [url for url in requested_urls if urlparse(url).path.startswith("/js/")]
            if source_requests:
                failures.append(f"source-only module requested: {source_requests[0]}")
            browser.close()
    finally:
        fixture_context.cleanup()
        server.shutdown()
        server.server_close()

    if failures:
        raise SystemExit("Production dist smoke failed:\n- " + "\n- ".join(failures))
    print("Production dist smoke passed: built app, Help, manifest, workers, D3 plot, model fit, export, and session import.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
