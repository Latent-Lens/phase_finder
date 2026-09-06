> Archived 2026-09-05 from docs/plans/working_tree_commit_plan.md. Historical findings are reconciled in the master checklist; unchecked boxes here are not an active work queue. [Current register](../../audits/master_checklist.md).

# Working Tree Commit Plan

This plan divides the changes made since commit `2af7969` into small,
reviewable commits. Shared files must be staged at hunk level so each commit
contains only the behavior named in its message.

No proposed commit should be created until its ID has been approved.

## Repository and data

| ID | Proposed commit message |
| --- | --- |
| R1 | `chore(repo): stop tracking local Codex configuration` |
| R2 | `chore(session): stop tracking personal session files` |
| R3 | `chore(repo): ignore local, generated, and test artifacts` |
| D1 | `fix(fcs): validate headers, offsets, and TEXT segments` |
| D2 | `fix(fcs): support numeric encodings and byte-order variants` |
| D3 | `fix(data): normalize channel names and DNA eligibility` |
| D4 | `fix(metadata): validate imported metadata and exported values` |

## Quality control

| ID | Proposed commit message |
| --- | --- |
| Q1 | `fix(qc): harden structural event filtering` |
| Q2 | `feat(qc): add configurable structural QC settings` |
| Q3 | `fix(qc): improve acquisition-time segmentation and scoring` |
| Q4 | `feat(qc): add peak-tracking time QC` |
| Q5 | `feat(qc): add time QC settings and diagnostic plot` |
| Q6 | `feat(qc): persist QC configuration in sessions` |

## Cell-cycle modeling

| ID | Proposed commit message |
| --- | --- |
| M1 | `fix(math): harden statistical and optimization primitives` |
| M2 | `feat(modeling): define the scientific fit result contract` |
| M3 | `fix(modeling): validate inputs before fitting` |
| M4 | `fix(modeling): improve Dean-Jett model constraints` |
| M5 | `fix(modeling): improve Dean-Jett-Fox model constraints` |
| M6 | `fix(modeling): improve Watson Pragmatic fitting` |
| M7 | `feat(modeling): add Watson Classic fitting` |
| M8 | `fix(modeling): improve automatic model selection` |
| M9 | `fix(modeling): strengthen peak detection and review` |
| M10 | `feat(cloccs): add CLOCCS model and optimizer` |
| M11 | `feat(cloccs): run CLOCCS fits in a worker` |
| M12 | `feat(cloccs): integrate time-series fitting into the UI` |

## Sessions

| ID | Proposed commit message |
| --- | --- |
| S1 | `fix(session): validate imported session structure` |
| S2 | `fix(session): safely encode hostile TOML strings` |
| S3 | `feat(session): verify cached files with content digests` |
| S4 | `feat(session): manage cached files and storage usage` |
| S5 | `fix(session): restore sessions transactionally` |
| S6 | `fix(session): improve missing-file reconnection` |

## Plot and desktop UI

| ID | Proposed commit message |
| --- | --- |
| P1 | `style(plot): unify plot toolbar icon design` |
| P2 | `feat(plot): improve viewport navigation and autoscaling` |
| P3 | `fix(plot): improve rendering and overlay consistency` |
| P4 | `fix(export): harden image and spreadsheet exports` |
| U1 | `fix(a11y): manage modal focus and background isolation` |
| U2 | `feat(ui): make desktop dialogs draggable` |
| U3 | `fix(ui): improve desktop panel resizing and layout` |
| U4 | `fix(table): improve headers, columns, and status feedback` |
| U5 | `feat(ui): report unsupported browser capabilities` |

## Tests and validation

| ID | Proposed commit message |
| --- | --- |
| T1 | `chore(test): relocate unit test drivers` |
| T2 | `chore(test): relocate browser test drivers` |
| T3 | `test(ci): isolate local test servers` |
| T4 | `test(browser): add production-distribution smoke tests` |
| V1 | `test(fcs): add synthetic parser compatibility fixtures` |
| V2 | `test(validation): add synthetic modeling and QC references` |
| V3 | `test(validation): document external dataset and phase-call provenance` |

`V3` commits only the external manifest, license notices, and verification or
reconstruction scripts. Downloaded datasets, published-result images, and
third-party phase-call files remain local and are excluded by `.gitignore`.

## Build, CI, and documentation

| ID | Proposed commit message |
| --- | --- |
| B1 | `build: pin the supported Node and npm versions` |
| B2 | `build: emit complete root and subpath artifacts` |
| B3 | `build: verify artifact contents and size budgets` |
| B4 | `build: generate release provenance and checksums` |
| B5 | `security: add privacy and supply-chain checks` |
| B6 | `docs(legal): add license and third-party notices` |
| C1 | `ci(browser): test supported browser engines and channels` |
| C2 | `ci(security): add dependency and security scanning` |
| C3 | `ci(release): verify artifacts before deployment` |
| C4 | `ci(release): make production deployment opt-in` |

The former A1–A4 documentation and audit groups are intentionally skipped and
must not be staged or committed as part of this plan.

## Deletions requiring explicit approval

| ID | Proposed commit message |
| --- | --- |
| X1 | `chore: remove obsolete generated previews and unused images` |
| X2 | `chore(docs): remove workflow diagram source documents` |

`X2` should remain denied for now. The generated diagram pages still identify
those Markdown documents as their sources.

## Files excluded from the plan

- `~$code_audit_checkbox_counts_by_code.xlsx` is a temporary Excel lock file
  and must not be committed.
- `todo.md`, `needs_be_fixed_frontend_dev.md`, and
  `needs_to_be_fixed_ux.md` — **superseded 2026-08-15.** Merged into
  `docs/audits/master_checklist.md` and moved to `docs/archive/audits/archive/`.
  `needs_to_be_fixed_ux.md` was tracked and was moved with `git mv`; the other
  two were untracked and the archive holds the only copies.
- Documentation guidance, audit reports, audit baselines, the remediation
  checklist, and the checkbox-count workbook formerly assigned to A1–A4 are
  intentionally excluded from this commit series.
- All external validation datasets, reference images, and third-party
  phase-call files remain local. Their source locations, licenses, hashes, and
  phase-call provenance are recorded in the tracked external manifest.
- Generated validation results must remain untracked.

## Approval format

Approve or deny commits by ID or range, for example:

```text
approve R1-R3, D1-D4, P1; deny X1-X2
```

Each approved commit will be staged and checked separately before it is
created.
