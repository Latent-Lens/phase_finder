# Modeling reference

Methodology and citation material extracted from the LatentLens
`cell-cycle-modeling-handoff` archive (formerly
`assets/misc/cell-cycle-modeling-handoff(2).zip`, deleted once these documents
were unpacked here). This is LatentLens-authored internal work and is covered
by the repository's PolyForm Noncommercial License 1.0.0 — see [`../../LICENSE`](../../LICENSE).

| Document | What it covers | Cited from |
| --- | --- | --- |
| [`AUTOMATIC_PEAK_DETECTION.md`](AUTOMATIC_PEAK_DETECTION.md) | Multi-scale G1/G2 peak-pair detection: smoothing scales, prominence/width/area evidence, persistence clustering, pair scoring, failure boundaries. | [`js/analysis/cell_cycle/peak_detection.js`](../../js/analysis/cell_cycle/peak_detection.js) |
| [`PEAK_REGION_HANDLES.md`](PEAK_REGION_HANDLES.md) | Immutable peak-region semantics: the four G1/G2 limits identify peaks, they are not phase gates, and the optimizer may never move them. | [`js/analysis/cell_cycle/peak_regions.js`](../../js/analysis/cell_cycle/peak_regions.js) |
| [`REFERENCES.md`](REFERENCES.md) | Evidence map tying each model and component to its primary literature. | Citation keys in [`../plans/cell_cycle_modeling_plan.md`](../plans/cell_cycle_modeling_plan.md) §5 |
| [`references.bib`](references.bib) | BibTeX for the above (Dean & Jett, Fox, Watson, Orlando, Marquardt, Nelder & Mead, Akaike, Schwarz, Wersto, Nicoletti, Dolbeare, Salic). | `REFERENCES.md` |

The archive's `MODEL_REFERENCE.md` was merged into
[`../plans/cell_cycle_modeling_plan.md`](../plans/cell_cycle_modeling_plan.md)
§5 on 2026-08-17 rather than kept here. Its mathematics duplicated §5, its
PhaseFinder-facing decisions were already superseded there (normalized
quadratic instead of softplus, wave *fraction* instead of `waveAmplitude`,
transformed Levenberg–Marquardt instead of Nelder–Mead), and every JavaScript
example in it addressed the archive's own `src/` module tree, which this
repository does not have. The equations it carried that §5 lacked — residual
and information criteria, the M7 component densities, contaminant reporting,
bootstrap uncertainty, and the marker-assisted extension — are now §5.8–§5.13.
The two documents above stay separate because code headers cite them by
section.

The archive's remaining files were process artifacts of a handoff that has
already happened (`AGENT_HANDOFF.md`, `UI_WORKFLOW.md`, `README.md`,
`CHANGELOG.md`) or reference JavaScript long since ported into
[`js/analysis/cell_cycle/`](../../js/analysis/cell_cycle/), and were not retained.
