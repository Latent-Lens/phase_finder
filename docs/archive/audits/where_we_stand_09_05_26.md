> Archived 2026-09-05 from docs/audits/where_we_stand_09_05_26.md. Historical findings are reconciled in the master checklist; unchecked boxes here are not an active work queue. [Current register](../../audits/master_checklist.md).

# Where we stand — 2026-09-05

Point-in-time status snapshot of PhaseFinder. Written against a live inspection of
the working tree, a full test run, and the current state of
[`master_checklist.md`](../../audits/master_checklist.md) — not against memory or `git log`.

This is a **snapshot, not a register**. The checklist remains the single source of
truth for what is open; nothing here should be worked from once it goes stale.

---

## The headline

The 23-commit series landed on 2026-08-17 is now buried under 14 further commits, and
**a second body of uncommitted work has accumulated on top of it**. The last commit is
dated 2026-08-17; this snapshot is 2026-09-05. Nineteen days of work is sitting in the
working tree again.

The branch has **never been pushed**. `cell-cycle-report-warn` is **62 commits ahead of
`main`** and has no upstream — `main` is the only branch tracking `origin`
(`https://github.com/Latent-Lens/PhaseFinder.git`).

---

## Verification

Run 2026-09-05 against the working tree.

| Check | Result |
|---|---|
| Unit suite (`npm run test:unit`) | **865/865** passed (was 756 on 2026-08-17) |
| `npm run test:ci` | **41/41** OK (was 25) |
| `lint:js` | PASS |
| `check:dom` | PASS |
| `check:docs` | PASS |
| `check:imports` | PASS |
| `check:privacy` | PASS |

Not run for this snapshot: `test:e2e`, `build` + `check:dist`, `check:base`,
`check:fixtures`. A source-only pass does not establish that the deployed site works —
see the checklist preamble.

---

## Uncommitted work

**45 modified tracked files, +3,173 / −1,344. 61 untracked files.**

Six coherent themes, all substantial:

| Theme | Evidence |
|---|---|
| **Uncertainty and identifiability (UNC-01)** | [`resampling.js`](../../../js/analysis/cell_cycle/resampling.js) (859 lines), [`uncertainty.js`](../../../js/analysis/cell_cycle/uncertainty.js) (628), with 1,336 lines of tests behind them |
| **QC matrix and review UI (QC-01/QC-02)** | [`qc_matrix.js`](../../../js/analysis/pipeline/qc_matrix.js) (354), [`qc_review_ui.js`](../../../js/analysis/cell_cycle/qc_review_ui.js) (234), 629 lines of tests |
| **The `render.js` split (AUDIT-008)** | [`render.js`](../../../js/plotting/render.js) drops 883 lines into [`histogram_prep.js`](../../../js/plotting/histogram_prep.js), [`plot_accessibility.js`](../../../js/plotting/plot_accessibility.js), [`ridge_review.js`](../../../js/plotting/ridge_review.js) |
| **Peak estimator work (MODEL-01…05)** | every model file, plus [`lm_solver.js`](../../../js/analysis/math/lm_solver.js), [`gaussian_bin_mass.js`](../../../js/analysis/math/gaussian_bin_mass.js), [`peak_regions.js`](../../../js/analysis/cell_cycle/peak_regions.js) |
| **QC calibration fixtures** | 7 synthetic FCS files with injected ground truth (1.1 MB), plus a verifier that runs them through the real production `runTimeQC` / `gateByPulseGeometry` / `gateMainBiologicalCloud` |
| **The 18-persona agency audit** | 452 KB in [`agency/`](agency/), plus [`evidence/`](../../audits/evidence/) and [`build_checklist_status.py`](../../../scripts/build_checklist_status.py) |

---

## The scientific result worth knowing about

**MODEL-01 — the G2 placement bias — has been redignosed, and roughly half of it is not
a bug.**

The 2026-08-17 handoff flagged this as "the highest-value single change available": G2's
mean below the FlowJo reference on 30/30 samples, median −3.2%. The error has since been
decomposed:

```
g1_mean error   -1.61%   ← ours
ratio error     -1.55%   ← probably correct science
     sum        -3.15%   ← matches the observed -3.19%
```

The ratio half is chromatin condensation in G2/M restricting DNA accessibility to
intercalating dyes, so G2/M cells fluoresce slightly less than twice G1 — a documented
effect, and our free-fitted ratio of ~1.977 is about what it predicts. FlowJo's median
sits essentially on the theoretical 2.0, and FlowJo supports constraining the mean-peak
ratio.

The checklist now carries an explicit **"do not tune `g2_mean` toward the FlowJo
reference"** decision, recorded in
[`docs/scientific-result-contract.md`](../../scientific-result-contract.md) and in
[`help/help-cell-cycle-accuracy.html`](../../../help/help-cell-cycle-accuracy.html) §6 as a
user-facing statement, so it is not re-attempted.

The remaining half — the −1.6% G1 offset — turned out to be a **width** disagreement
rather than a location error: the fit-free histogram mode carries the whole offset, and
pinning FlowJo's CV onto our own histogram closes 74% of it. See MODEL-02.

---

## Checklist movement

| | At `HEAD` (`fd74f10`) | Working tree |
|---|---|---|
| Done `[x]` | 16 | **113** |
| Open `[ ]` | 208 | **103** |
| Partial `[~]` | 4 | 13 |
| Needs evidence `[?]` | 0 | 0 |

Ninety-seven boxes ticked, across 38 headings.

### What remains, by priority

| Priority | Open boxes | Headings |
|---|---|---|
| **P0** | 7 | REL-01 (3), VALID-01 (2), MODEL-02 (1), SCI-03 (1) |
| **P1** | 28 | STAT-01, QC-CAL-01, QC-04, REL-04 (4 each); UI-02, UI-05 (3); DOMAIN-01, TEST-01 (2); AMBIG-01, QC-03 (1) |
| **P2** | 30 | PERF-01 (7), UI-12, UI-13 (5), UI-14, DOC-02 (4), MODEL-07, CLEAN-03 (2), UI-08/09/10, MAINT-01, CLEAN-01 (1) |
| **P3** | 20 | MAINT-02 (5), FUTURE-01 (4), PERF-02, FEAT-03 (3), CLEAN-02, CLEAN-04 (2), FEAT-04 (1) |

Fourteen further open boxes sit under un-prioritized summary headings (Build and
deployment, Scientific correctness, Documentation and sign-off, Data safety and
accessibility).

[`master_checklist_needs_you.md`](master_checklist_needs_you.md) lists the seven items
genuinely blocked on the project owner rather than on engineering: real labelled QC data
(QC-CAL-01), tolerance thresholds only a human can set (VALID-01), a Cloudflare account
(REL-01), screen-reader testing (UI-14), two delete/keep judgment calls (CLEAN-02,
CLEAN-04), and whether to keep investing in CLOCCS UI (FEAT-04).

---

## Flags

### 1. `docs/tmp/` holds three copyrighted papers, neither tracked nor ignored

Dean & Jett 1974, Fox 1980, and Watson 1987 sit in `docs/tmp/` (2.1 MB). The directory
is **not** in `.gitignore` and the files are **not** tracked, so they show as untracked
and nothing prevents a `git add -A` from committing them to a GitHub repository.

`check:privacy` will not catch this: it scans `git ls-files`, i.e. tracked files only,
so the guard only fires *after* the files are already committed.

**Fix:** add `docs/tmp/` to `.gitignore`. One line.

### 2. Commits between `07543c9` and `fd74f10` carry no issue IDs

None of those 11 commits carry an issue ID, which breaks the checklist's own rule at
[`master_checklist.md:26`](../../audits/master_checklist.md#L26)
(`fix(MODEL-02): deconvolve the smoothing kernel`). The reconciliation table in
[`checklist_reconciliation.json`](checklist_reconciliation.json) exists precisely
because that mapping had to be rebuilt by reading source rather than history.

Tagging future commits with their issue ID is what stops that table from being needed.

---

## Recommended next steps

1. **Gitignore `docs/tmp/`.** One line; closes the copyright exposure above.
2. **Commit and push.** The working tree is comparable in size to the one grouped into
   23 commits on 2026-08-17, and the same hunk-level grouping exercise applies. Pushing
   also gets 62 commits of unbacked work off a single disk.
3. **Then pick from the P0 four.** REL-01 and VALID-01 both need something from the
   project owner; MODEL-02's last box and SCI-03 can be worked solo.

---

*Snapshot taken 2026-09-05 on branch `cell-cycle-report-warn` at `fd74f10` + uncommitted
working tree. Regenerate rather than update — this file records one moment.*
