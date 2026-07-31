#!/usr/bin/env python3

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e" / "driving_code"))
from phase_status import PhaseFailure, PhaseTracker


class PhaseStatusTests(unittest.TestCase):
    def test_failure_is_nonzero_capable_and_names_its_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "phase-status.json"
            tracker = PhaseTracker(path)
            tracker.run("e2e_setup", lambda: None)
            with self.assertRaisesRegex(PhaseFailure, "unit_execution"):
                tracker.run("unit_execution", lambda: (_ for _ in ()).throw(RuntimeError("boom")))

            evidence = json.loads(path.read_text(encoding="utf-8"))["phases"]
            self.assertEqual(evidence["e2e_setup"]["status"], "passed")
            self.assertEqual(evidence["unit_execution"]["status"], "failed")
            self.assertIn("boom", evidence["unit_execution"]["detail"])
            self.assertTrue(tracker.failed)

    def test_skipped_phase_is_explicit_but_not_a_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = PhaseTracker(Path(directory) / "phase-status.json")
            tracker.skip("unit_execution", "unit setup failed")
            self.assertFalse(tracker.failed)


if __name__ == "__main__":
    unittest.main()
