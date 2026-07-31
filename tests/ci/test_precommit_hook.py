#!/usr/bin/env python3

import os
import stat
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

HOOK = Path(__file__).resolve().parents[2] / ".githooks/pre-commit"


class PreCommitHookTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        base = Path(self.temporary.name)
        self.repo = base / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "PhaseFinder CI"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "ci@example.invalid"], cwd=self.repo, check=True)
        self.tracked = self.repo / "tracked.txt"
        self.tracked.write_text("baseline\n", encoding="utf-8")
        subprocess.run(["git", "add", "tracked.txt"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-qm", "baseline"], cwd=self.repo, check=True)

        self.log = base / "python.log"
        self.fake_python = base / "fake-python"
        self.fake_python.write_text(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOOK_LOG\"\nexit \"${FAKE_PYTHON_EXIT:-0}\"\n",
            encoding="utf-8",
        )
        self.fake_python.chmod(self.fake_python.stat().st_mode | stat.S_IXUSR)

    def tearDown(self):
        self.temporary.cleanup()

    def run_hook(self, *, exit_code=0, python=None):
        env = os.environ.copy()
        env.update({
            "HOOK_LOG": str(self.log),
            "FAKE_PYTHON_EXIT": str(exit_code),
            "PHASEFINDER_TEST_PYTHON": str(self.fake_python if python is None else python),
        })
        return subprocess.run(
            ["bash", str(HOOK)],
            cwd=self.repo,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_clean_staged_and_unstaged_worktrees_follow_documented_policy(self):
        clean = self.run_hook()
        self.assertEqual(clean.returncode, 0)
        self.assertNotIn("Warning: tests run against", clean.stderr)

        self.tracked.write_text("staged\n", encoding="utf-8")
        subprocess.run(["git", "add", "tracked.txt"], cwd=self.repo, check=True)
        staged = self.run_hook()
        self.assertEqual(staged.returncode, 0)
        self.assertNotIn("Warning: tests run against", staged.stderr)

        self.tracked.write_text("unstaged\n", encoding="utf-8")
        unstaged = self.run_hook()
        self.assertEqual(unstaged.returncode, 0)
        self.assertIn("Warning: tests run against", unstaged.stderr)

    def test_missing_dependency_and_failed_check_block_commit(self):
        missing = self.run_hook(python=Path(self.temporary.name) / "missing-python")
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("Commit blocked", missing.stderr)

        failed = self.run_hook(exit_code=7)
        self.assertEqual(failed.returncode, 7)
        self.assertIn("-m unittest discover", self.log.read_text(encoding="utf-8"))

    def test_passing_checks_run_unit_and_supply_chain_commands(self):
        passed = self.run_hook()
        commands = self.log.read_text(encoding="utf-8")
        self.assertEqual(passed.returncode, 0)
        self.assertIn("-m unittest discover -s tests/ci", commands)
        self.assertIn("scripts/check_supply_chain.py --static", commands)


if __name__ == "__main__":
    unittest.main()
