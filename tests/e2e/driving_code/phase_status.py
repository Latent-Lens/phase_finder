"""Atomic phase evidence for the combined browser test runner."""

import json
import os
import time
from pathlib import Path


class PhaseFailure(RuntimeError):
    def __init__(self, phase, error):
        self.phase = phase
        super().__init__(f"{phase}: {type(error).__name__}: {error}")


class PhaseTracker:
    def __init__(self, path):
        self.path = Path(path)
        self.phases = {}

    def record(self, name, status, detail=""):
        self.phases[name] = {
            "status": status,
            "detail": str(detail),
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f"{self.path.suffix}.{os.getpid()}.tmp")
        temporary.write_text(
            json.dumps({"phases": self.phases}, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)

    def run(self, name, operation):
        try:
            result = operation()
        except Exception as error:
            self.record(name, "failed", f"{type(error).__name__}: {error}")
            raise PhaseFailure(name, error) from error
        self.record(name, "passed")
        return result

    def skip(self, name, detail):
        self.record(name, "skipped", detail)

    @property
    def failed(self):
        return any(phase["status"] == "failed" for phase in self.phases.values())
