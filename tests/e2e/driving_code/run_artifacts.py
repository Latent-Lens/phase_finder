#!/usr/bin/env python3
"""Publish completed test runs and clean old isolated runs safely."""

import argparse
import os
import re
import shutil
import time
from pathlib import Path

RUN_NAME = re.compile(r"^\d{8}-\d{6}-\d+$")


def _validated_root(root):
    root = Path(root).resolve()
    if root.name != "results" or root.is_symlink():
        raise ValueError("results root must be a real directory named 'results'")
    root.mkdir(parents=True, exist_ok=True)
    return root


def publish_latest(root, run_dir, report_path):
    root = _validated_root(root)
    run_dir = Path(run_dir).resolve()
    report_path = Path(report_path).resolve()
    if run_dir.parent != root or not RUN_NAME.fullmatch(run_dir.name):
        raise ValueError("run directory is not an isolated PhaseFinder result directory")
    if report_path.parent != run_dir or not report_path.is_file():
        raise ValueError("latest can only reference a completed report in its run directory")
    temporary = root / f".latest-{os.getpid()}-{time.time_ns()}.tmp"
    temporary.write_text(f"{run_dir.name}/{report_path.name}\n", encoding="utf-8")
    os.replace(temporary, root / "latest.txt")


def cleanup_runs(root, keep=20, max_age_days=30, now=None):
    root = _validated_root(root)
    now = time.time() if now is None else now
    latest = (root / "latest.txt").read_text(encoding="utf-8").strip().split("/", 1)[0] if (root / "latest.txt").is_file() else ""
    runs = sorted(
        (path for path in root.iterdir() if path.is_dir() and not path.is_symlink() and RUN_NAME.fullmatch(path.name)),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    removed = []
    for index, path in enumerate(runs):
        expired = now - path.stat().st_mtime > max_age_days * 86400
        if path.name != latest and index >= keep and expired:
            shutil.rmtree(path)
            removed.append(path.name)
    return removed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--keep", type=int, default=20)
    parser.add_argument("--max-age-days", type=int, default=30)
    args = parser.parse_args()
    if args.keep < 1 or args.max_age_days < 1:
        parser.error("--keep and --max-age-days must be positive")
    for name in cleanup_runs(args.root, args.keep, args.max_age_days):
        print(name)


if __name__ == "__main__":
    main()
