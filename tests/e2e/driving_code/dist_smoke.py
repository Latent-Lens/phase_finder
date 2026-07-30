#!/usr/bin/env python3
"""Production artifact smoke: serve only dist/ and reject broken built paths."""

import json
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))

from test_server import start_test_server  # noqa: E402


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

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context()
            page = context.new_page()
            watch(page)
            page.goto(base, wait_until="networkidle")
            page.wait_for_selector("#drop_zone")

            for selector in ("#sidebar_toggle", "#metadata_panel_toggle", "#plot_panel_toggle"):
                page.click(selector)
                page.click(selector)
            page.wait_for_function("[...document.images].every(img => img.complete && img.naturalWidth > 0)")

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
            chooser.value.set_files(str(ROOT / "tests/validation/validation_test_data/synthetic_fcs/files/parser_i16_little_endian.fcs"))
            page.wait_for_function("document.querySelectorAll('.file_table tbody .row_select').length === 1")

            help_page = context.new_page()
            watch(help_page)
            help_href = page.get_attribute("#status_bar a", "href")
            if not help_href:
                failures.append("Help link is missing")
                help_href = "help.html"
            help_page.goto(urljoin(page.url, help_href), wait_until="networkidle")
            if "PhaseFinder Help" not in help_page.title():
                failures.append("Help page title is missing")

            source_requests = [url for url in requested_urls if urlparse(url).path.startswith("/js/")]
            if source_requests:
                failures.append(f"source-only module requested: {source_requests[0]}")
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    if failures:
        raise SystemExit("Production dist smoke failed:\n- " + "\n- ".join(failures))
    print("Production dist smoke passed: built app, icons, manifest, FCS worker, and Help.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
