"""PRIV-03: check path policy without reading or copying private payloads."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class PrivatePayloadPaths(unittest.TestCase):
    def test_private_paths_and_reviewed_metadata(self):
        base = "tests/validation/validation_test_data/external_fcs/"
        with tempfile.TemporaryDirectory() as directory:
            for path, rejected in [
                ("docs/tmp/reference.pdf", True),
                *[(base + folder + "/sample.fcs", True) for folder in ("datasets", "files", "results")],
                (base + "manifest.json", False), (base + "LICENSE", False),
                ("tests/validation/validation_test_data/synthetic_fcs/files/truth.fcs", False),
            ]:
                with self.subTest(path=path):
                    result = subprocess.run(["node", "scripts/check-privacy.cjs"], input=path + "\0",
                        text=True, capture_output=True, cwd=ROOT,
                        env={**os.environ, "DIST_DIR": directory})
                    self.assertEqual(result.returncode != 0, rejected, result.stderr)
                    if rejected:
                        ignored = subprocess.run(["git", "check-ignore", "--no-index", path], cwd=ROOT, capture_output=True)
                        self.assertEqual(ignored.returncode, 0)
