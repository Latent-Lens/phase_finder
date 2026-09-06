> Archived 2026-09-05 from docs/audits/archive/todo.md. Historical findings are reconciled in the master checklist; unchecked boxes here are not an active work queue. [Current register](../../../audits/master_checklist.md).

# Do this first
- [ ] Can you prevent panning or zooming to show space below 0 on the y-axis?

- [ ] Auto-Fit All, I'm not sure if this actually fits the model for all
      samples, but if it does it definitely doesn't add the values for each sample to the table.

- [ ] Also is there a way to load all the files in the order required to load 
      all the pictures and all the js load in the order it would be likely used?

- [ ] Are the values that show up when clicking on each Time QC method the 
      best default values or are users supposed to know what values to use?

- [ ] If we have implemented the CLOCCS model can you verify it follows in the 
	same way as what's documented in: CLOCCS_modeling.md? If we haven't implemented it can you use this other agent's Pseudocode to implement it, CLOCCS_modeling.md? It's possible several sections already overlap with what we already have since the agent that wrote all of this as an entire pipeline

- [ ] Make sure we have implemented everything in cell_cycle_modeling_plan.md?

- [ ] Also make sure we have implemented everything correctly as presented 
      here unless it conflicts with some other info used to build a model, dean_jett_fox_implementation.md.

- [ ] Can you implement the fixes that another agent found in the repo's code, 
      codex_audit_of_full_project_remediation_checklist.md?

# Cell-cycle modeling sidebar — outstanding work

- [ ] **Phase 2 **: the spec's acquisition-order
      diagnostic plot (events at low opacity + tracked peak positions +
      rejected-bin shading + segment boundaries, with a channel picker). The
      spec itself stages this as Phase 2. All the data it needs is already in
      the Stage 1 result (`segmentResults[].peakColumns` / `peakMetadata` /
      `rejectionReasons`, plus `rejectedRegions`); only the rendering is missing.

- [ ] Broader M6 plan items not requested this session (residual panel, session
  persistence of model config/results, versioned JSON/CSV export — see
  `docs/plans/cell_cycle_modeling_plan.md` §M6) are not included here. Say
  the word if you want them folded in.

- [ ] The two untracked root-level audit docs (`needs_be_fixed_frontend_dev.md`,
  `needs_to_be_fixed_ux.md`) are a separate, pre-existing review effort, not
  part of this feature list.

