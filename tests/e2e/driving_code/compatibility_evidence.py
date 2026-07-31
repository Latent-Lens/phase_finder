"""Record and aggregate exact browser compatibility evidence."""

import argparse
import importlib.metadata
import json
import os
import platform
import time
from pathlib import Path

ENGINES = {
    "chromium": "Chromium",
    "edge": "Chromium",
    "brave": "Chromium",
    "firefox": "Gecko",
    "webkit": "WebKit",
}


def write_compatibility_evidence(path, browser, browser_version, status):
    evidence = {
        "browser": browser,
        "browser_version": browser_version,
        "engine": ENGINES[browser],
        "os": platform.platform(),
        "python": platform.python_version(),
        "playwright": importlib.metadata.version("playwright"),
        "status": status,
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "run_id": os.environ.get("GITHUB_RUN_ID", "local"),
    }
    Path(path).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    return evidence


def aggregate(root, output, expected):
    records = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in Path(root).rglob("compatibility.json")
    ]
    by_browser = {record["browser"]: record for record in records}
    missing = sorted(set(expected) - set(by_browser))
    rows = [
        "# Browser compatibility evidence",
        "",
        "| Browser | Engine | Browser version | OS | Python | Playwright | Result | Date |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for browser in expected:
        record = by_browser.get(browser)
        if not record:
            rows.append(f"| {browser} | — | — | — | — | — | MISSING | — |")
            continue
        values = (
            browser,
            record["engine"],
            record["browser_version"],
            record["os"],
            record["python"],
            record["playwright"],
            record["status"].upper(),
            record["date"],
        )
        rows.append("| " + " | ".join(str(value).replace("|", "\\|") for value in values) + " |")
    Path(output).write_text("\n".join(rows) + "\n", encoding="utf-8")
    failed = [record["browser"] for record in records if record["status"] != "passed"]
    if missing or failed:
        raise SystemExit(f"Compatibility evidence incomplete: missing={missing}, failed={sorted(failed)}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("output")
    parser.add_argument("expected", nargs="+")
    args = parser.parse_args()
    aggregate(args.root, args.output, args.expected)


if __name__ == "__main__":
    main()
