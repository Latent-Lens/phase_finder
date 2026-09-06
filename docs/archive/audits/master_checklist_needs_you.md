> Archived 2026-09-05 from docs/audits/master_checklist_needs_you.md. Historical findings are reconciled in the master checklist; unchecked boxes here are not an active work queue. [Current register](../../audits/master_checklist.md).

# PhaseFinder — checklist items that need something from you

Filtered further from `docs/archive/audits/master_checklist_open.md` (38 open-box items).
Most of those 38 are unstarted or partial *engineering* work I can still attempt
solo — this file keeps only the boxes that are genuinely blocked on something
only you (or someone you designate) can supply: a resource I can't source, an
account/credential I don't have, a judgment call, or physical/manual testing I
can't perform. For each one: what's blocked, and exactly what I need from you.

**Summary — what I need from you, one or two sentences each:**

- **QC-CAL-01:** I built a synthetic, honestly-labelled calibration corpus and it surfaced two real detector-behavior findings, but it can't substitute for the real thing. I need either real acquisition data with independently-known anomaly/peak-correctness labels (or your sign-off that this stays open indefinitely), and separately, your policy call on what false-positive/detection/retention rate counts as "acceptable" — that's a threshold only you can set.
- **VALID-01:** Two separate asks. First, someone needs to actually read the scientific-validity writeup and either bless it or name who should before any "validated"/clinical language ships — I can't self-certify that. Second, I need target numbers for how much deviance, model-choice instability, and QC-mask disagreement you're willing to tolerate before calling a fit untrustworthy, since there's no external benchmark (like FlowJo) to borrow those from.
- **REL-01:** The release workflow itself is finished and fail-closed; what's left is actually running it once against a live Cloudflare Pages project. I don't have an account — either grant me temporary scoped access so I can run and record it myself, or run the `workflow_dispatch`/test-release steps yourself and tell me what came back (URL, headers, deployment ID).
- **CLEAN-02:** Three `docs/audits/*.html` files look like superseded duplicates of ones already in `docs/`, and the evidence backs that up, but deleting anything needs your go-ahead, not just my confidence. Say yes and I'll delete them, or say hold and I'll leave them alone.
- **CLEAN-04:** Three help pages (`djf-model-validation.html`, `result_validation.html`, `tool_validation.html`) are better than what's currently linked but aren't wired into navigation anywhere. Tell me to link them in or to archive them deliberately — either is a small edit, I just shouldn't guess which one you want.
- **UI-14:** Three of the four screen-reader sub-checks I can verify programmatically, but "actually run NVDA/JAWS/VoiceOver and listen to it" requires a human at the controls, which isn't something I can do. Either run the table/plot views through a screen reader yourself and tell me what breaks, or tell me to leave that one sub-item open.
- **FEAT-04:** The M8 joint-series UI is real, buildable feature work, but I'm flagging it because both real-data validation runs this session argue CLOCCS isn't identifiable enough yet to justify building UI around it. Tell me whether to keep investing in that UI now anyway, or park it until the model's identifiability improves — I'll build it either way, I just don't want to make that call by default.

**DOC-01 is resolved as of 2026-08-21** — you supplied the three primary papers directly (`docs/tmp/`), which closed the equation-number citation gap; see `master_checklist.md`'s DOC-01 entry for what came out of reading them. No longer in this file.

---

### QC-CAL-01 (blocks QC-03, QC-04, QC-06, STAT-01's threshold box, and half of PEAK-01)

**What's blocked:** Five to six QC/statistics items all calibrate against the same
missing thing — a *labelled* dataset where the ground truth is known independently
of our own detectors:
- QC-CAL-01 itself needs acquisitions covering stable runs, clogs, dropouts, timer
  rollover, backward time jumps, doublet-heavy samples, and debris-dominant samples.
- PEAK-01's calibration box needs a *different* label: a histogram set with an
  independently annotated (human- or orthogonal-instrument-derived) correct/incorrect
  peak-pair verdict per case.

Nothing in the repo or in any of the redistributable datasets I found this session
(Miltenyi, Rodighiero, Amouzgar) carries either kind of label — they have biological
truth or parser-conformance truth, not acquisition-anomaly or peak-correctness truth.

**2026-08-21 update — done since the above was written, but only partially closes this:**
Built and verified a synthetic substitute rather than leaving this at zero:
`tests/validation/validation_test_data/synthetic_fcs/generate_qc_calibration_fixtures.py`
generates 7 reproducible, honestly-labelled-as-synthetic FCS fixtures (stable, clog,
dropout, timer rollover, backward time jump, doublet-heavy, debris-dominant) with
injected, exactly-known ground truth in `qc_calibration/manifest.json`.
`verify_qc_calibration_fixtures.mjs` runs them through the REAL production
`runTimeQC`/`gateByPulseGeometry`/`gateMainBiologicalCloud` — all 7 pass. This surfaced
two real, source-confirmed calibration findings along the way, now documented and
regression-locked: `gateByPulseGeometry`'s doublet-detection recall degrades once
doublets exceed ~8-10% of events (consistent with its own documented
minority-population design assumption), and `gateMainBiologicalCloud`'s main-component
selection is purely weight-based, so past ~50% debris it selects the debris cluster as
"main" and inverts, rejecting the live cells instead. Full detail in
`master_checklist_map.md`'s 2026-08-21 QC-CAL-01 changelog entry.

**What I still need from you:** This is synthetic, not real acquisitions — it can verify
detector *behavior* against known-injected truth, but a real dataset's clogs/dropouts
don't necessarily look like my model of them, so it can't replace real-world validation.
Two things remain genuinely open: (1) point me at real acquisition data with
independently-known anomaly/peak-correctness labels, if any exists or can be captured,
or tell me to accept the "real data" half of this stays open indefinitely; and (2) your
call on what false-positive/detection/retention/boundary-rejection rates should count as
"acceptable" — a policy choice no amount of engineering can derive on its own, synthetic
data or not.

---

### VALID-01 — boxes 5 (partial) and 9

**Box 9 — domain-expert review before "validated"/clinical/diagnostic/publication language.**
This one is explicit in the checklist itself: it "cannot be performed by an AI."

**What I need from you:** Either review the scientific claims yourself (the
consolidated "Validated scope, unsupported inputs, and remaining differences"
section in `docs/scientific-result-contract.md` is the thing to read), or tell me
who should, before any of that language ships. I can't close this box myself no
matter how much more measurement I do.

**Box 5 (partial) — acceptance tolerances for deviance, model-choice stability,
and QC-mask agreement.** The peaks/fractions/means/CVs/ratio tolerances are already
set; these three aren't, because FlowJo doesn't report the equivalent numbers to
compare against.

**What I need from you:** A target — e.g. "reduced deviance should stay within X of
1.0 before we call a fit well-specified" or "model choice should agree across N%
of resamples." I can propose defaults from the UNC-01 coverage-simulation numbers
already on record, but picking the actual acceptance line is a judgment call, not
a measurement.

---

### REL-01 — Cloudflare release execution

**What's blocked:** the workflow itself is already fixed (deploys `dist`, fail-closed
behind `ENABLE_PRODUCTION_DEPLOY`, strict CSP verified by hash). What's left —
running `workflow_dispatch` against a staging Pages project, publishing an actual
test release, and recording a deployment identifier — all require an authenticated
Cloudflare Pages account. I don't have one.

**What I need from you:** Either give me (temporary, scoped) access to a staging
Cloudflare Pages project so I can run the dispatch and record the results, or run
those three steps yourself and tell me the outcome (staging URL, whether headers
came through correctly, the deployment ID) so I can write it into
`docs/release-and-privacy.md` next to the rollback procedure.

---

### CLEAN-02 — three `docs/audits/*.html` duplicates

**What's blocked:** this isn't a data or access problem, it's a "confirm before
deleting" the checklist itself asks for. The evidence (broken relative links in
the `docs/audits/` copies, `docs/` being 5–72 bytes smaller and link-clean) points
to `docs/` as canonical for `color_use`, `user_controlled_vars`, and `djf_diffs`.

**What I need from you:** A go/no-go on deleting the three `docs/audits/` copies
(same pattern as the already-resolved graph-file pair). If you'd rather I hold
off, say so and I'll leave this box open.

---

### CLEAN-04 — three orphaned help pages

**What's blocked:** `help/djf-model-validation.html`, `help/result_validation.html`,
and `help/tool_validation.html` are more detailed and newer than the validation
pages that *are* linked, but they ship nowhere and aren't copied into `dist/`. The
checklist's own wording for this box is "Decide" — it's an editorial call, not
engineering.

**What I need from you:** Wire them into the help index/sidebar nav (no restyling
needed — they already use the shared layout), or tell me to archive them
deliberately. Either is a small change once you pick; I just can't pick for you.

---

### UI-14 — screen-reader verification

**What's blocked:** three of its four sub-items are automatable (I can assert
accessibility-tree snapshots, keyboard-navigation behavior, and export-content
equivalence programmatically). But "test with... at least one screen reader"
means actually running NVDA, JAWS, or VoiceOver and listening to/reading what it
announces — that needs a human operating assistive tech, which isn't something I
can do interactively.

**What I need from you:** Either run through the table-selection/sort flow and the
plot/histogram views with a screen reader yourself (or have someone who does)
and tell me what breaks, or tell me to leave this specific sub-item open while I
finish the other three programmatically.

---

### FEAT-04 — box 3 (M8 gate), a prioritization call rather than a resource gap

**What's blocked:** this is P3 and the remaining work is a real UI feature
(series/condition selector, joint-series persistence, sidebar controls for
synchronized-metadata input) — not something I'm blocked from attempting. I'm
flagging it here because both independent real-data validations run this session
(AlphaFactor: no reference values at all, diagnostic only; Li 2026 CLOCCS:
1-of-2-replicates converged, order-of-magnitude parameter disagreement on the
other) argue against the model being ready for this gate.

**What I need from you:** A call on whether to keep investing engineering time in
the M8 UI surface now, given that the underlying model doesn't yet pass its own
validation gate, or to leave it parked at its current `unverified` status until
CLOCCS's identifiability improves. I can build the UI regardless if you want it
staged ahead of the science catching up — just want that to be a decision you
made, not one I made by default.

---

Everything else among the 38 open items in `master_checklist_open.md` — the UI bugs,
performance work, most of documentation, cleanup, and maintenance items — is
engineering I can still pick up and attempt without further input from you.
