#!/usr/bin/env python3

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "unit" / "driving_code"))
from unit_phase import UnitPhaseFailure, require_unit_result_count, unit_phase_failure


class UnitPhaseContractTests(unittest.TestCase):
    def test_broken_harness_url_is_a_setup_failure(self):
        failure = unit_phase_failure("unit_setup", ConnectionError("HTTP 404: test_harness.html"))
        self.assertEqual(failure.phase, "unit_setup")
        self.assertIn("404", str(failure))

    def test_uncaught_runner_exception_is_an_execution_failure(self):
        failure = unit_phase_failure("unit_execution", RuntimeError("injected runner crash"))
        self.assertEqual(failure.phase, "unit_execution")
        self.assertIn("injected runner crash", str(failure))

    def test_zero_and_short_discovery_are_hard_failures(self):
        for count in (0, 399):
            with self.assertRaises(UnitPhaseFailure):
                require_unit_result_count(count, 400)

    def test_timeout_remains_identifiable(self):
        failure = unit_phase_failure("unit_setup", TimeoutError("harness readiness timeout"))
        self.assertEqual(failure.phase, "unit_setup")
        self.assertIn("timeout", str(failure))


if __name__ == "__main__":
    unittest.main()
