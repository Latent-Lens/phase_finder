#!/usr/bin/env python3

import json
import html
import sys
import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e/driving_code"))
from safe_detail import MAX_DETAIL_BYTES, safe_detail, write_full_failure_detail


class SafeDetailTests(unittest.TestCase):
    def test_huge_mask_is_bounded_and_diagnostic(self):
        detail = safe_detail(json.dumps([0, 1] * 100_000))
        self.assertLessEqual(len(detail.encode()), MAX_DETAIL_BYTES)
        self.assertIn('"length":200000', detail)
        self.assertIn('"sha256":', detail)
        self.assertIn('"numeric":', detail)
        self.assertIn('"head":', detail)
        self.assertIn('"tail":', detail)

    def test_huge_details_stay_bounded_in_every_text_surface(self):
        for value in ({"mask": [index % 2 == 0 for index in range(1_000_000)]}, "x" * 1_000_000):
            detail = safe_detail(value)
            self.assertLessEqual(len(f"- {detail}\n".encode()), MAX_DETAIL_BYTES + 3)
            self.assertLessEqual(len(f"[PASS] huge detail — {detail}\n".encode()), MAX_DETAIL_BYTES + 32)
            self.assertLessEqual(
                len(f"<p class='detail'>{html.escape(detail)}</p>".encode()),
                MAX_DETAIL_BYTES * 6 + 32,
            )

    def test_full_failure_detail_requires_opt_in_and_stays_out_of_normal_detail(self):
        with TemporaryDirectory() as directory:
            huge = {"mask": [0, 1] * 10_000}
            self.assertEqual(write_full_failure_detail(directory, 1, "failure", huge), "")
            relative = write_full_failure_detail(directory, 1, "failure", huge, enabled=True)
            payload = (Path(directory) / relative).read_text(encoding="utf-8")
            self.assertGreater(len(payload), MAX_DETAIL_BYTES)
            self.assertNotIn(payload, safe_detail(huge))


if __name__ == "__main__":
    unittest.main()
