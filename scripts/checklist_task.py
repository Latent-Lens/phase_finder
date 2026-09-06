#!/usr/bin/env python3
"""Atomically claim, complete, or release tasks in master_checklist.md.

The Markdown checklist remains the single source of truth. This tool only edits
tracking metadata inside each task and then regenerates the human-friendly HTML
tracker with scripts/build_checklist_status.py.

Typical usage:

    python3 scripts/checklist_task.py claim \
        --model "Claude Sonnet 5 High - C1" --order high

    python3 scripts/checklist_task.py complete MODEL-02 \
        --model "Claude Sonnet 5 High - C1" \
        --solution "Implemented ...; focused tests ...; caveat ..."

    python3 scripts/checklist_task.py release MODEL-02 \
        --model "Claude Sonnet 5 High - C1"

The claim operation is protected by an OS-level lock, so concurrent agents using
this script cannot successfully claim the same task.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


TASK_HEADING_RE = re.compile(
    r"^###\s+(?P<id>[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s+—\s+(?P<title>.+?)\s*$",
    re.MULTILINE,
)
PRIORITY_RE = re.compile(r"^\*\*Priority:\*\*\s*(?P<value>[^\n]+)", re.MULTILINE)
STARTED_RE = re.compile(r"^\*\*Started:\*\*\s*(?P<value>[^\n]+)\s*$", re.MULTILINE)
MODEL_RE = re.compile(r"^\*\*Model:\*\*\s*(?P<value>[^\n]+)\s*$", re.MULTILINE)
COMPLETED_RE = re.compile(r"^\*\*Completed:\*\*\s*(?P<value>[^\n]+)\s*$", re.MULTILINE)
SOLUTION_RE = re.compile(r"^\*\*Solution:\*\*\s*(?P<value>.*)$", re.MULTILINE)
CHECKBOX_RE = re.compile(r"^\s*-\s+\[(?P<state>[ xX~?])\]", re.MULTILINE)
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
PRIORITY_TOKEN_RE = re.compile(r"\bP(?P<num>\d+)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Task:
    task_id: str
    title: str
    start: int
    end: int
    body: str

    @property
    def started(self) -> str | None:
        match = STARTED_RE.search(self.body)
        return match.group("value").strip() if match else None

    @property
    def model(self) -> str | None:
        match = MODEL_RE.search(self.body)
        return match.group("value").strip() if match else None

    @property
    def completed(self) -> str | None:
        match = COMPLETED_RE.search(self.body)
        return match.group("value").strip() if match else None

    @property
    def priority(self) -> int | None:
        """Return the task's effective priority number.

        For mixed labels such as P2/P3, use the highest priority (smallest
        number), matching the checklist's HTML-filter convention.
        """
        match = PRIORITY_RE.search(self.body)
        if not match:
            return None
        values = [int(m.group("num")) for m in PRIORITY_TOKEN_RE.finditer(match.group("value"))]
        return min(values) if values else None

    @property
    def checkbox_states(self) -> list[str]:
        # The checklist explicitly says fenced examples do not count as
        # acceptance boxes, so strip fenced blocks before scanning.
        visible_lines: list[str] = []
        fence_char: str | None = None
        fence_len = 0
        for line in self.body.splitlines():
            match = FENCE_RE.match(line)
            if match:
                token = match.group(1)
                if fence_char is None:
                    fence_char = token[0]
                    fence_len = len(token)
                    continue
                if token[0] == fence_char and len(token) >= fence_len:
                    fence_char = None
                    fence_len = 0
                    continue
            if fence_char is None:
                visible_lines.append(line)
        visible = "\n".join(visible_lines)
        return [m.group("state").lower() for m in CHECKBOX_RE.finditer(visible)]

    @property
    def acceptance_complete(self) -> bool:
        states = self.checkbox_states
        return bool(states) and all(state == "x" for state in states)

    @property
    def finished(self) -> bool:
        # Completed metadata is authoritative for tracking. All-x acceptance
        # boxes are also treated as finished so a historical closed task cannot
        # be accidentally reclaimed merely because it predates Completed tags.
        return self.completed is not None or self.acceptance_complete


class ChecklistError(RuntimeError):
    pass


def repo_root_from_script() -> Path:
    # Expected installed location: <repo>/scripts/checklist_task.py
    return Path(__file__).resolve().parent.parent


def parse_tasks(text: str) -> list[Task]:
    matches = list(TASK_HEADING_RE.finditer(text))
    tasks: list[Task] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        tasks.append(
            Task(
                task_id=match.group("id"),
                title=match.group("title").strip(),
                start=start,
                end=end,
                body=text[start:end],
            )
        )
    return tasks


def task_by_id(tasks: Sequence[Task], task_id: str) -> Task:
    normalized = task_id.strip().upper()
    for task in tasks:
        if task.task_id.upper() == normalized:
            return task
    raise ChecklistError(f"Task {task_id!r} was not found in the checklist.")


def now_iso() -> str:
    # The generated tracker labels its timestamps as Eastern, so make the
    # source metadata Eastern regardless of the agent machine's local timezone.
    try:
        eastern = ZoneInfo("America/New_York")
    except ZoneInfoNotFoundError as exc:
        raise ChecklistError(
            "Timezone data for America/New_York is unavailable. Install system tzdata "
            "(or the Python tzdata package) before claiming tasks."
        ) from exc
    return dt.datetime.now(eastern).replace(microsecond=0).isoformat()


def insert_after_heading(task_body: str, lines: list[str]) -> str:
    heading_end = task_body.find("\n")
    if heading_end < 0:
        heading_end = len(task_body)
        suffix = "\n"
    else:
        heading_end += 1
        suffix = ""

    rest = task_body[heading_end:]
    # Preserve a single blank line after the heading before metadata.
    rest = rest.lstrip("\n")
    metadata = "\n".join(lines).rstrip() + "\n\n"
    return task_body[:heading_end] + "\n" + metadata + rest + suffix


def add_claim_metadata(task_body: str, *, started: str, model: str) -> str:
    if STARTED_RE.search(task_body):
        raise ChecklistError("Task already has a Started field.")
    if COMPLETED_RE.search(task_body):
        raise ChecklistError("Task already has a Completed field.")

    # A stale Model field without Started should not silently survive a new
    # claim; replace it with the claimant's exact model string.
    task_body = MODEL_RE.sub("", task_body)
    task_body = re.sub(r"\n{3,}", "\n\n", task_body, count=1)
    return insert_after_heading(
        task_body,
        [f"**Started:** {started}", f"**Model:** {model}"],
    )


def add_completion_metadata(task_body: str, *, completed: str, solution: str | None) -> str:
    if COMPLETED_RE.search(task_body):
        raise ChecklistError("Task already has a Completed field.")

    lines = [f"**Completed:** {completed}"]
    if solution is not None:
        cleaned = " ".join(solution.strip().splitlines()).strip()
        if not cleaned:
            raise ChecklistError("Solution text cannot be empty.")
        if SOLUTION_RE.search(task_body):
            task_body = SOLUTION_RE.sub(lambda _: f"**Solution:** {cleaned}", task_body, count=1)
        else:
            lines.append(f"**Solution:** {cleaned}")
    return insert_after_heading(task_body, lines)


def remove_claim_metadata(task_body: str) -> str:
    task_body = STARTED_RE.sub("", task_body, count=1)
    task_body = MODEL_RE.sub("", task_body, count=1)
    # Keep formatting tidy near the heading without aggressively rewriting the
    # rest of a long historical task section.
    heading_end = task_body.find("\n")
    if heading_end >= 0:
        prefix = task_body[: heading_end + 1]
        rest = task_body[heading_end + 1 :]
        rest = re.sub(r"^\n+", "\n", rest)
        task_body = prefix + rest
    return task_body


def replace_task(text: str, task: Task, new_body: str) -> str:
    return text[: task.start] + new_body + text[task.end :]


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ChecklistError(f"Checklist not found: {path}") from exc


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            mode = path.stat().st_mode
            os.chmod(temp_path, mode)
        except FileNotFoundError:
            pass
        os.replace(temp_path, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp_path.unlink()


@contextlib.contextmanager
def exclusive_lock(lock_path: Path, timeout: float) -> Iterator[None]:
    """Acquire a cross-platform advisory lock on a small sidecar file."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock_path, "a+b")
    deadline = time.monotonic() + timeout
    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            while True:
                try:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise ChecklistError(
                            f"Timed out waiting for checklist lock: {lock_path}"
                        )
                    time.sleep(0.05)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ChecklistError(
                            f"Timed out waiting for checklist lock: {lock_path}"
                        )
                    time.sleep(0.05)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def run_builder(builder: Path, repo_root: Path, checklist: Path) -> None:
    if not builder.exists():
        raise ChecklistError(f"Checklist HTML builder not found: {builder}")

    env = os.environ.copy()
    # The existing builder is expected to use repository-relative defaults.
    result = subprocess.run(
        [sys.executable, str(builder)],
        cwd=repo_root,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode != 0:
        output = result.stdout.strip()
        detail = f"\nBuilder output:\n{output}" if output else ""
        raise ChecklistError(
            f"HTML rebuild failed with exit code {result.returncode}.{detail}"
        )


def write_and_build_transaction(
    *,
    checklist: Path,
    original: str,
    updated: str,
    builder: Path,
    repo_root: Path,
    no_build: bool,
) -> None:
    if updated == original:
        return

    atomic_write(checklist, updated)
    if no_build:
        return

    try:
        run_builder(builder, repo_root, checklist)
    except Exception:
        # Roll back only this command's checklist edit. Any implementation work
        # already present before the command is part of `original` and survives.
        atomic_write(checklist, original)
        with contextlib.suppress(Exception):
            run_builder(builder, repo_root, checklist)
        raise


def choose_claimable(tasks: Sequence[Task], order: str) -> Task:
    candidates = [
        task
        for task in tasks
        if not task.finished and task.started is None and task.priority is not None
    ]
    if not candidates:
        raise ChecklistError("No unfinished, unclaimed tasks with a parsed priority are available.")

    # Stable secondary ordering follows document order, so equally prioritized
    # tasks remain deterministic and easy for humans to predict.
    if order == "high":
        best_priority = min(task.priority for task in candidates if task.priority is not None)
    else:
        best_priority = max(task.priority for task in candidates if task.priority is not None)

    for task in candidates:
        if task.priority == best_priority:
            return task
    raise AssertionError("Candidate selection failed unexpectedly")


def lock_path_for(checklist: Path) -> Path:
    # Keep lock artifacts out of the repository. The resolved checklist path is
    # hashed so all processes targeting the same file coordinate on one lock.
    digest = hashlib.sha256(str(checklist.resolve()).encode("utf-8")).hexdigest()[:20]
    return Path(tempfile.gettempdir()) / f"phasefinder-checklist-{digest}.lock"


def claim(args: argparse.Namespace) -> int:
    checklist: Path = args.checklist
    lock_path = lock_path_for(checklist)

    with exclusive_lock(lock_path, args.lock_timeout):
        original = read_text(checklist)
        tasks = parse_tasks(original)
        task = choose_claimable(tasks, args.order)
        started = now_iso()
        new_body = add_claim_metadata(task.body, started=started, model=args.model)
        updated = replace_task(original, task, new_body)
        write_and_build_transaction(
            checklist=checklist,
            original=original,
            updated=updated,
            builder=args.builder,
            repo_root=args.repo_root,
            no_build=args.no_build,
        )

    print(f"Claimed: {task.task_id} — {task.title}")
    print(f"Priority: P{task.priority}")
    print(f"Started: {started}")
    print(f"Model: {args.model}")
    return 0


def read_solution(args: argparse.Namespace) -> str | None:
    if args.solution is not None and args.solution_file is not None:
        raise ChecklistError("Use either --solution or --solution-file, not both.")
    if args.solution_file is not None:
        if str(args.solution_file) == "-":
            return sys.stdin.read()
        try:
            return Path(args.solution_file).read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise ChecklistError(f"Solution file not found: {args.solution_file}") from exc
    return args.solution


def complete(args: argparse.Namespace) -> int:
    checklist: Path = args.checklist
    lock_path = lock_path_for(checklist)
    solution = read_solution(args)

    with exclusive_lock(lock_path, args.lock_timeout):
        original = read_text(checklist)
        tasks = parse_tasks(original)
        task = task_by_id(tasks, args.task_id)

        if task.completed is not None:
            raise ChecklistError(f"{task.task_id} is already completed ({task.completed}).")
        if task.started is None:
            raise ChecklistError(
                f"{task.task_id} is not claimed. Claim it before completing it."
            )
        if task.model != args.model:
            raise ChecklistError(
                f"{task.task_id} is owned by {task.model!r}, not {args.model!r}."
            )
        if not task.checkbox_states:
            raise ChecklistError(
                f"{task.task_id} has no acceptance checkboxes; refusing automatic completion."
            )
        incomplete = [state for state in task.checkbox_states if state != "x"]
        if incomplete:
            raise ChecklistError(
                f"{task.task_id} still has {len(incomplete)} incomplete acceptance box(es). "
                "Mark every acceptance criterion [x] before completing it."
            )

        existing_solution = SOLUTION_RE.search(task.body)
        if solution is None and not existing_solution:
            raise ChecklistError(
                f"{task.task_id} has no **Solution:** record. Pass --solution/--solution-file "
                "or add a **Solution:** line under the task before completing it."
            )

        completed = now_iso()
        new_body = add_completion_metadata(task.body, completed=completed, solution=solution)
        updated = replace_task(original, task, new_body)
        write_and_build_transaction(
            checklist=checklist,
            original=original,
            updated=updated,
            builder=args.builder,
            repo_root=args.repo_root,
            no_build=args.no_build,
        )

    print(f"Completed: {task.task_id} — {task.title}")
    print(f"Started: {task.started}")
    print(f"Completed: {completed}")
    print(f"Model: {args.model}")
    return 0


def release(args: argparse.Namespace) -> int:
    checklist: Path = args.checklist
    lock_path = lock_path_for(checklist)

    with exclusive_lock(lock_path, args.lock_timeout):
        original = read_text(checklist)
        tasks = parse_tasks(original)
        task = task_by_id(tasks, args.task_id)

        if task.completed is not None:
            raise ChecklistError(f"{task.task_id} is already completed and cannot be released.")
        if task.started is None:
            raise ChecklistError(f"{task.task_id} is not currently claimed.")
        if task.model != args.model and not args.force:
            raise ChecklistError(
                f"{task.task_id} is owned by {task.model!r}, not {args.model!r}. "
                "Use --force only for deliberate stale-claim cleanup."
            )

        new_body = remove_claim_metadata(task.body)
        updated = replace_task(original, task, new_body)
        write_and_build_transaction(
            checklist=checklist,
            original=original,
            updated=updated,
            builder=args.builder,
            repo_root=args.repo_root,
            no_build=args.no_build,
        )

    print(f"Released: {task.task_id} — {task.title}")
    return 0


def add_common_paths(parser: argparse.ArgumentParser, defaults: dict[str, Path]) -> None:
    parser.add_argument(
        "--checklist",
        type=Path,
        default=defaults["checklist"],
        help=f"Markdown checklist (default: {defaults['checklist']})",
    )
    parser.add_argument(
        "--builder",
        type=Path,
        default=defaults["builder"],
        help=f"HTML builder script (default: {defaults['builder']})",
    )
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="Do not regenerate master_checklist_status.html (mainly for tests/debugging).",
    )
    parser.add_argument(
        "--lock-timeout",
        type=float,
        default=30.0,
        help="Seconds to wait for another agent to release the checklist lock (default: 30).",
    )


def build_parser() -> argparse.ArgumentParser:
    repo_root = repo_root_from_script()
    defaults = {
        "checklist": repo_root / "docs" / "audits" / "master_checklist.md",
        "builder": repo_root / "scripts" / "build_checklist_status.py",
    }

    parser = argparse.ArgumentParser(
        description="Atomically coordinate concurrent agents through master_checklist.md."
    )
    parser.set_defaults(repo_root=repo_root)
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_claim = subparsers.add_parser("claim", help="Atomically claim the next eligible task.")
    p_claim.add_argument("--model", required=True, help="Exact model/agent label stored in the task.")
    p_claim.add_argument(
        "--order",
        choices=("high", "low"),
        default="high",
        help="high=P0→larger numbers; low=largest P-number→P0 (default: high).",
    )
    add_common_paths(p_claim, defaults)
    p_claim.set_defaults(func=claim)

    p_complete = subparsers.add_parser(
        "complete",
        help="Complete a claimed task after every acceptance box is [x].",
    )
    p_complete.add_argument("task_id", help="Task ID, e.g. MODEL-02.")
    p_complete.add_argument("--model", required=True, help="Must exactly match the claim owner.")
    solution_group = p_complete.add_mutually_exclusive_group()
    solution_group.add_argument(
        "--solution",
        help="Completion/fix summary. Stored as **Solution:** in the task.",
    )
    solution_group.add_argument(
        "--solution-file",
        help="Read solution text from a UTF-8 file; use '-' to read stdin.",
    )
    add_common_paths(p_complete, defaults)
    p_complete.set_defaults(func=complete)

    p_release = subparsers.add_parser(
        "release",
        help="Release an unfinished claim so another agent may take the task.",
    )
    p_release.add_argument("task_id", help="Task ID, e.g. MODEL-02.")
    p_release.add_argument("--model", required=True, help="Must exactly match the claim owner.")
    p_release.add_argument(
        "--force",
        action="store_true",
        help="Release a task owned by another model (stale-claim cleanup only).",
    )
    add_common_paths(p_release, defaults)
    p_release.set_defaults(func=release)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # Resolve relative overrides against the caller's working directory while
    # defaults are already absolute repo-root paths.
    args.checklist = args.checklist.resolve()
    args.builder = args.builder.resolve()

    try:
        return int(args.func(args))
    except ChecklistError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("ERROR: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
