# Archived audits and issue lists

**Archived:** 2026-08-15

Everything in this directory has been **merged into [`docs/audits/master_checklist.md`](../master_checklist.md)**. It is kept for provenance — to show where a finding came from and what was already tried — not as a work queue.

> **Do not add items here, and do not work from these files.** Open work lives in the master checklist. Design and architecture live in [`docs/plans/phasefinder_design.md`](../../plans/phasefinder_design.md).

## What is here and what happened to it

| File | Was | Where it went |
|---|---|---|
| `codex_audit_of_full_project_remediation_checklist.md` | 789 items, 139 open across 43 IDs. **Supplied the format template** for the master checklist. | All 39 IDs carrying open items were verified as carried over. Its section structure survives as Sections 1–11. |
| `current_status_of_project.md` | Status report + WP-1…WP-7 work packages with implementation code. | Issue content → master checklist. Architecture and model description → design document. |
| `ui_ux_audit_2026-08.md` | Screenshot-backed visual audit (54 images, in `ui_screenshots/`). Produced by a UI-designer subagent, then spot-verified against source. | Findings → checklist Section 4. Dark-theme palette and residual-panel design → design document §9. |
| `ui_issues_report.md` | Code-verified UI audit; consolidated both UI documents into one priority list. | Merged into checklist Section 4. |
| `needs_be_fixed_frontend_dev.md` | 35 FE items from 2026-07-17. | **31 verified resolved** (evidence in checklist Appendix A). 4 survivors → PERF-01, UI-03/04, UI-05, UI-08. |
| `needs_to_be_fixed_ux.md` | 9 UX items from 2026-07-17. | **6 verified resolved.** 3 survivors → UI-07 (UX-06), UI-12 (UX-09), UI-04 (UI-19). |
| `todo.md` | Loose task list. | 2 items verified already done (y-axis zero clamp, Phase 2 diagnostic plot); the rest folded in. |
| `djf-pipeline_report.md` | Code review of `js/analysis/djf/`. | **Reviews dead code.** That directory has zero external imports and is scheduled for deletion (CLEAN-01). The review is accurate about code nobody runs. |

## Still live, deliberately not archived

- **[`../cell_cycle_model_investigation_handoff.md`](../cell_cycle_model_investigation_handoff.md)** — a research log, not a task list. It records five model changes that were attempted and measured, four of which made results worse, and *why*. It is the reason the joint estimator will not be re-attempted by accident. **Keep it current.**
- `../codex_audit_of_full_project.html` — the original HTML audit that the archived checklist was derived from. Left in place as the primary source; archive it too if the checklist reconciliation (CLEAN-03) is completed and the source is no longer needed.
- `../baselines/` — recorded test and numeric baselines, still referenced.

## Recovering something

The two tracked files (`codex_audit_…checklist.md`, `needs_to_be_fixed_ux.md`) were moved with `git mv`, so their full history is intact. The remaining six were untracked and are preserved here as the only copies — which is why they were archived rather than deleted.
