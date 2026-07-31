# Full source regression baseline — 2026-07-30

- Command: `python tests/e2e/driving_code/drive_flow.py --limited-media`
- Environment: Chromium via Playwright 1.61.0, Python 3.12, repository source server
- Result: **827/839 passed; 12 failed**
- Local run ID: `20260730-192418-3180970`

The failures were retained as failures rather than warnings. Subsequent focused
source runs closed the non-scientific pipeline, responsive-layout, plotting,
export, session, and accessibility regressions: the final focused set is
132/132 on the current tree. The permanent `npm run test:audit` gate passed
869/869 checks on 2026-07-31 (`20260731-043254-3750491`) and records the
scientific modeling UI group as explicitly skipped. Before the later concurrent
scientific-model edits, the complete browser unit harness passed 674/674
checks. Its current result is **728/731 passed**
(`20260731-100703-4070691`): all three failures are Dean–Jett–Fox planted-wave
fit assertions in the checklist's excluded scientific-model section. The 25
repository CI contract tests, root/base-path builds and artifact checks, and
the CSP-constrained production smoke all pass on the current tree.

The verified local environment was branch `cell-cycle-report-warn`, source
commit `aefb49ba31d74d80cf6d1b4144d9a4cc1fb5c5ba`, Node 22.23.2, npm 10.9.8,
Python 3.12.13, and Playwright 1.61.0. A separate current modeling run reaches
the remaining peak/model correctness assertions; those belong to the
checklist's explicitly excluded “Scientific model correctness and result
consistency” section.

The generated HTML/video report remains an ignored local test artifact. This
tracked record preserves the command, environment, result, and classification
needed to compare later full runs without committing bulky browser output.
