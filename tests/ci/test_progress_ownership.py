import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class ProgressOwnershipTests(unittest.TestCase):
    def test_every_progress_caller_keeps_and_reuses_its_operation_id(self):
        failures = []
        for path in (ROOT / "js").rglob("*.js"):
            if path.name == "status_channels.js":
                continue
            text = path.read_text()
            for number, line in enumerate(text.splitlines(), 1):
                if re.search(r"\bshow_progress\(", line) and not re.search(r"\b\w+\s*=\s*show_progress\(", line):
                    failures.append(f"{path.relative_to(ROOT)}:{number}: show_progress result is discarded")
            for match in re.finditer(r"hide_progress\(\s*[^,()]+\s*\)", text):
                number = text.count("\n", 0, match.start()) + 1
                failures.append(f"{path.relative_to(ROOT)}:{number}: hide_progress has no operation ID")
        self.assertEqual([], failures, "\n".join(failures))

    def test_long_parse_and_bulk_fit_expose_their_existing_abort_signals(self):
        channel_load = (ROOT / "js/analysis/start.js").read_text()
        bulk_fit = (ROOT / "js/analysis/cell_cycle/modeling_ui.js").read_text()
        self.assertIn("show_progress_cancel(() => controller.abort())", channel_load)
        self.assertIn("show_progress_cancel(() => controller.abort())", bulk_fit)
        self.assertIn("fit_cell_cycle_model(row, modelId, { signal: controller.signal })", bulk_fit)


if __name__ == "__main__":
    unittest.main()
