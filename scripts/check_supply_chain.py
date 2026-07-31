#!/usr/bin/env python3
"""Fail CI on unpinned dependencies, unpinned Actions, or missing licenses."""

import importlib.metadata
import json
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
errors = []
static_only = sys.argv[1:] == ["--static"]

lock = json.loads((root / "package-lock.json").read_text())
for path, package in lock.get("packages", {}).items():
    if path and not package.get("license"):
        errors.append(f"npm package has no declared license: {path}")
    if path and package.get("resolved", "").startswith("git+"):
        errors.append(f"npm package resolves from Git instead of the registry: {path}")

requirements = []
requirement_files = sorted({*root.glob("requirements*.txt"), *root.glob("tests/**/requirements*.txt")})
for requirement_file in requirement_files:
    for line in requirement_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "==" not in line:
            errors.append(f"Python dependency is not exactly pinned: {requirement_file.relative_to(root)}: {line}")
            continue
        requirements.append(line.split("==", 1)[0])

for name in [] if static_only else requirements:
    try:
        metadata = importlib.metadata.metadata(name)
    except importlib.metadata.PackageNotFoundError:
        errors.append(f"Python dependency is not installed: {name}")
        continue
    classifiers = metadata.get_all("Classifier") or []
    if not metadata.get("License") and not metadata.get("License-Expression") and not any("License ::" in item for item in classifiers):
        errors.append(f"Python package has no declared license: {name}")

action_ref = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)")
for workflow in (root / ".github/workflows").glob("*.yml"):
    for number, line in enumerate(workflow.read_text().splitlines(), 1):
        match = action_ref.match(line)
        if not match or match.group(1).startswith("./"):
            continue
        ref = match.group(1).rsplit("@", 1)[-1]
        if not re.fullmatch(r"[0-9a-f]{40}", ref):
            errors.append(f"GitHub Action is not commit-pinned: {workflow.name}:{number}")

secret_patterns = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
}
text_suffixes = {".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".py", ".sh", ".toml", ".txt", ".webmanifest", ".yaml", ".yml"}
tracked = subprocess.run(
    ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True,
).stdout.decode().split("\0")
for relative in tracked:
    path = root / relative
    if not relative or path.suffix.lower() not in text_suffixes or not path.is_file():
        continue
    text = path.read_text(encoding="utf-8", errors="replace")
    for label, pattern in secret_patterns.items():
        if pattern.search(text):
            errors.append(f"possible {label} in tracked file: {relative}")

if errors:
    raise SystemExit("\n".join(errors))
print(f"Supply-chain policy passed: {len(lock.get('packages', {})) - 1} npm and {len(requirements)} Python packages; Actions commit-pinned; tracked text secret-scanned.")
