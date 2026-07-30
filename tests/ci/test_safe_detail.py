#!/usr/bin/env python3

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e/driving_code"))
from safe_detail import MAX_DETAIL_BYTES, safe_detail


class SafeDetailTests(unittest.TestCase):
    def test_huge_mask_is_bounded_and_diagnostic(self):
        detail = safe_detail(json.dumps([0, 1] * 100_000))
        self.assertLessEqual(len(detail.encode()), MAX_DETAIL_BYTES)
        self.assertIn('"length":200000', detail)
        self.assertIn('"sha256":', detail)
        self.assertIn('"numeric":', detail)
        self.assertIn('"head":', detail)
        self.assertIn('"tail":', detail)


if __name__ == "__main__":
    unittest.main()
