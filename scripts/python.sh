#!/bin/sh
# Resolve the project Python and exec it with the given arguments.
#
# The resolution order is identical to .githooks/pre-commit:
#   1. $PHASEFINDER_TEST_PYTHON  — explicit override
#   2. ./.venv/bin/python        — project environment (often a symlink)
#   3. python3                   — whatever is on PATH
#
# npm scripts call this instead of bare `python3` so that the test suites and
# the pre-commit hook always agree about which interpreter runs. A bare
# `python3` can easily be a shim without playwright installed.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

if [ -n "${PHASEFINDER_TEST_PYTHON:-}" ]; then
  PYTHON="$PHASEFINDER_TEST_PYTHON"
elif [ -x "$ROOT/.venv/bin/python" ]; then
  PYTHON="$ROOT/.venv/bin/python"
else
  PYTHON="$(command -v python3 || true)"
fi

if [ -z "$PYTHON" ] || [ ! -x "$PYTHON" ]; then
  echo "No usable Python found: set PHASEFINDER_TEST_PYTHON, create .venv, or install python3." >&2
  exit 1
fi

exec "$PYTHON" "$@"
