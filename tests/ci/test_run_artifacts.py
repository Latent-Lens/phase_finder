#!/usr/bin/env python3

import os
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e/driving_code"))
from run_artifacts import cleanup_runs, publish_latest


class RunArtifactTests(unittest.TestCase):
    def test_parallel_publish_only_points_to_a_complete_report(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / "results"
            runs = []
            for pid in (100, 101):
                run = root / f"20260730-120000-{pid}"
                run.mkdir(parents=True)
                report = run / "report.html"
                report.write_text("complete", encoding="utf-8")
                runs.append((run, report))
            threads = [threading.Thread(target=publish_latest, args=(root, run, report)) for run, report in runs]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            target = (root / "latest.txt").read_text(encoding="utf-8").strip()
            self.assertIn(target, {"20260730-120000-100/report.html", "20260730-120000-101/report.html"})
            self.assertEqual((root / target).read_text(encoding="utf-8"), "complete")
            self.assertFalse(list(root.glob(".latest-*.tmp")))

    def test_interrupted_run_is_not_published_and_cleanup_is_explicitly_bounded(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / "results"
            complete = root / "20260730-120000-100"
            interrupted = root / "20260730-120000-101"
            unrelated = root / "notes"
            for path in (complete, interrupted, unrelated):
                path.mkdir(parents=True)
            report = complete / "report.html"
            report.write_text("complete", encoding="utf-8")
            publish_latest(root, complete, report)
            old = 1_700_000_000
            os.utime(complete, (old, old))
            os.utime(interrupted, (old, old))
            removed = cleanup_runs(root, keep=1, max_age_days=1, now=old + 172800)
            self.assertEqual(removed, [interrupted.name])
            self.assertTrue(complete.is_dir())
            self.assertTrue(unrelated.is_dir())

    def test_refuses_an_arbitrary_cleanup_directory(self):
        with TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                cleanup_runs(Path(directory), keep=1, max_age_days=1)


if __name__ == "__main__":
    unittest.main()
