#!/usr/bin/env python3
"""Browser unit coverage for the QC-01 critical-event-loss acknowledgement flow.

The result contract has always refused to report a fit when a QC stage removed
more than half the events without an acknowledgement, but nothing ever supplied
one -- the gate was a dead end, not a safeguard. These tests cover the flow that
closes it, and in particular step 4 of the checklist, which is the one that
actually matters: an acknowledgement must NOT survive a change to the QC
configuration or the file bytes, because an acknowledgement that outlives the
analysis it was given for silently re-authorizes a different one.

The design under test binds each acknowledgement to the outcome it acknowledged
(result_contract.js qc_acknowledgement_key), so invalidation is a property of
identity rather than of anyone remembering to revoke. The tests therefore assert
the *negative* cases hardest: a bare truthy value must not open the gate, and a
record carrying yesterday's key must not either.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / QC Acknowledgement"


_TESTS = r"""() => {
  const contract = window.CellCycleResultContract;
  const review = window.QcReviewUi;
  const results = [];
  const push = (name, pass, detail = '') => results.push({
    name, pass: Boolean(pass), detail: String(detail ?? ''),
  });
  const run = (name, test) => {
    try {
      const outcome = test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) {
      push(name, false, `${error.name}: ${error.message}`);
    }
  };

  // A minimal state that passes every OTHER precondition, so the only thing
  // that can block it is the critical removal we are testing. Built fresh per
  // test: these helpers mutate state.qcAcknowledgements by design.
  const makeState = (overrides = {}) => ({
    histogram: {
      counts: [10, 40, 120, 300, 120, 40, 10],
      edges: [0, 1, 2, 3, 4, 5, 6, 7],
      min: 0, max: 7, binCount: 7,
      maskRetainedCount: 5000,
      rejectedNegative: 0, rejectedNonfinite: 0, rejectedSaturated: 0,
      fingerprint: 'fp-1',
    },
    retainedEventCount: 5000,
    requiredQc: ['structural'],
    // Structural applied cleanly and removed 70% -- critical loss, but a
    // perfectly valid "applied" outcome otherwise.
    structuralQC: {
      configHash: 'cfg-A',
      evaluatedEventCount: 10000,
      rejectedEventCount: 7000,
      retainedEventCount: 3000,
    },
    modeling: { peakSelection: { reviewed: true, revision: 1, regions: null } },
    ...overrides,
  });

  const blockedOnCriticalRemoval = (state, acks) => {
    const preflight = contract.model_preflight(state, {
      qcAcknowledgements: acks ?? state.qcAcknowledgements ?? {},
    });
    return preflight.reasons.filter((r) => r.code === contract.RESULT_REASON.QC_CRITICAL_REMOVAL);
  };

  // ---- the gate itself ----------------------------------------------------

  run('QC-01: a >50% removal with no acknowledgement blocks reporting', () => {
    const blocks = blockedOnCriticalRemoval(makeState(), {});
    return {
      pass: blocks.length === 1 && blocks[0].detail?.name === 'structural',
      detail: `blocks=${blocks.length} ${JSON.stringify(blocks[0]?.detail ?? null)}`,
    };
  });

  run('QC-01: the blocking reason carries the key an acknowledgement must match', () => {
    // Without this the UI would have to re-derive the key itself, which is a
    // second implementation of the identity rule and therefore a second place
    // for it to drift.
    const blocks = blockedOnCriticalRemoval(makeState(), {});
    const key = blocks[0]?.detail?.acknowledgementKey;
    return {
      pass: typeof key === 'string' && key.length > 0 && key.startsWith('structural|'),
      detail: `acknowledgementKey=${JSON.stringify(key)}`,
    };
  });

  run('QC-01: an acknowledgement naming this outcome unblocks it', () => {
    const state = makeState();
    const key = blockedOnCriticalRemoval(state, {})[0].detail.acknowledgementKey;
    const acks = { structural: { key, acknowledgedAt: '2026-08-18T00:00:00.000Z', removedFraction: 0.7 } };
    const blocks = blockedOnCriticalRemoval(state, acks);
    return { pass: blocks.length === 0, detail: `remaining blocks=${blocks.length}` };
  });

  // ---- step 4: invalidation. The tests that matter. -----------------------

  run('QC-01: a bare truthy value does NOT open the gate', () => {
    // The pre-QC-01 contract tested `!qcAcknowledgements[name]`, so `true`, or
    // an empty object, or any leftover would have authorized the loss. An
    // acknowledgement has to be unforgeable by accident.
    const state = makeState();
    const bare = blockedOnCriticalRemoval(state, { structural: true });
    const empty = blockedOnCriticalRemoval(state, { structural: {} });
    const noKey = blockedOnCriticalRemoval(state, { structural: { acknowledgedAt: '2026-08-18T00:00:00.000Z' } });
    return {
      pass: bare.length === 1 && empty.length === 1 && noKey.length === 1,
      detail: `true=${bare.length} {}=${empty.length} no-key=${noKey.length} (each must be 1)`,
    };
  });

  run('QC-01: changing the QC CONFIG invalidates the acknowledgement', () => {
    const state = makeState();
    const key = blockedOnCriticalRemoval(state, {})[0].detail.acknowledgementKey;
    const acks = { structural: { key, acknowledgedAt: '2026-08-18T00:00:00.000Z', removedFraction: 0.7 } };
    // Sanity: it authorizes the outcome it was given for.
    const before = blockedOnCriticalRemoval(state, acks);
    // Now the user re-runs QC with a different configuration.
    state.structuralQC.configHash = 'cfg-B';
    const after = blockedOnCriticalRemoval(state, acks);
    return {
      pass: before.length === 0 && after.length === 1 && after[0].detail.staleAcknowledgement === true,
      detail: `before=${before.length} after=${after.length} stale=${after[0]?.detail?.staleAcknowledgement}`,
    };
  });

  run('QC-01: changing the FILE (different event counts) invalidates the acknowledgement', () => {
    const state = makeState();
    const key = blockedOnCriticalRemoval(state, {})[0].detail.acknowledgementKey;
    const acks = { structural: { key, acknowledgedAt: '2026-08-18T00:00:00.000Z', removedFraction: 0.7 } };
    const before = blockedOnCriticalRemoval(state, acks);
    // Same QC config, different file: the counts move.
    state.structuralQC.evaluatedEventCount = 12000;
    state.structuralQC.rejectedEventCount = 8400;
    state.structuralQC.retainedEventCount = 3600;
    const after = blockedOnCriticalRemoval(state, acks);
    return {
      pass: before.length === 0 && after.length === 1 && after[0].detail.staleAcknowledgement === true,
      detail: `before=${before.length} after=${after.length} stale=${after[0]?.detail?.staleAcknowledgement}`,
    };
  });

  run('QC-01: a stale acknowledgement says so, rather than reading as never-acknowledged', () => {
    // The two situations need different messages: "review this" versus "your
    // earlier review was of a different analysis". Collapsing them would let a
    // user believe the app forgot their acknowledgement.
    const state = makeState();
    const key = blockedOnCriticalRemoval(state, {})[0].detail.acknowledgementKey;
    state.structuralQC.configHash = 'cfg-B';
    const stale = blockedOnCriticalRemoval(state, {
      structural: { key, acknowledgedAt: '2026-08-18T00:00:00.000Z', removedFraction: 0.7 },
    })[0];
    const fresh = blockedOnCriticalRemoval(state, {})[0];
    return {
      pass: /no longer applies/i.test(stale.message) && !/no longer applies/i.test(fresh.message),
      detail: `stale="${stale.message}" fresh="${fresh.message}"`,
    };
  });

  // ---- qc_acknowledgement_key ---------------------------------------------

  run('QC-01: qc_acknowledgement_key is null for a stage that produced nothing', () => {
    // Nothing to acknowledge means nothing can be acknowledged -- a null key
    // must never be treated as a match, or an absent stage would authorize.
    const key = contract.qc_acknowledgement_key('structural', null);
    const authorizes = contract.qc_acknowledgement_authorizes(
      { key: null, acknowledgedAt: '2026-08-18T00:00:00.000Z' }, null,
    );
    return { pass: key === null && authorizes === false, detail: `key=${key} authorizes=${authorizes}` };
  });

  run('QC-01: qc_acknowledgement_key is stable for an unchanged product', () => {
    const product = { configHash: 'cfg-A', evaluatedEventCount: 10, rejectedEventCount: 7, retainedEventCount: 3 };
    const a = contract.qc_acknowledgement_key('time', product);
    const b = contract.qc_acknowledgement_key('time', { ...product });
    return { pass: a === b && typeof a === 'string', detail: `${a} === ${b}` };
  });

  run('QC-01: qc_acknowledgement_key separates stages, so one review cannot cover another', () => {
    const product = { configHash: 'cfg-A', evaluatedEventCount: 10, rejectedEventCount: 7, retainedEventCount: 3 };
    const structural = contract.qc_acknowledgement_key('structural', product);
    const time = contract.qc_acknowledgement_key('time', product);
    return { pass: structural !== time, detail: `structural=${structural} time=${time}` };
  });

  // ---- the review-flow helpers --------------------------------------------

  run('QC-01: pending_qc_acknowledgements reports the blocking stage and its removal', () => {
    const blocks = review.pending_qc_acknowledgements(makeState());
    return {
      pass: blocks.length === 1 && blocks[0].stage === 'structural'
        && Math.abs(blocks[0].percentRemoved - 70) < 1e-9 && blocks[0].label === 'Structural QC',
      detail: JSON.stringify(blocks),
    };
  });

  run('QC-01: acknowledge_qc_critical_removal records key, timestamp and fraction', () => {
    const state = makeState();
    const acknowledged = review.acknowledge_qc_critical_removal(state, new Date('2026-08-18T12:00:00Z'));
    const record = state.qcAcknowledgements.structural;
    return {
      pass: acknowledged.length === 1 && acknowledged[0] === 'structural'
        && typeof record.key === 'string'
        && record.acknowledgedAt === '2026-08-18T12:00:00.000Z'
        && Math.abs(record.removedFraction - 0.7) < 1e-9,
      detail: JSON.stringify(record),
    };
  });

  run('QC-01: acknowledging actually unblocks the same state (end-to-end)', () => {
    // The whole point: the record the UI writes must satisfy the contract that
    // refused the fit. If these two ever disagree the panel becomes a button
    // that does nothing.
    const state = makeState();
    const before = blockedOnCriticalRemoval(state, state.qcAcknowledgements ?? {});
    review.acknowledge_qc_critical_removal(state, new Date('2026-08-18T12:00:00Z'));
    const after = blockedOnCriticalRemoval(state, state.qcAcknowledgements);
    return { pass: before.length === 1 && after.length === 0, detail: `before=${before.length} after=${after.length}` };
  });

  run('QC-01: acknowledging, then re-running QC differently, blocks again', () => {
    const state = makeState();
    review.acknowledge_qc_critical_removal(state, new Date('2026-08-18T12:00:00Z'));
    state.structuralQC.configHash = 'cfg-B';
    const after = blockedOnCriticalRemoval(state, state.qcAcknowledgements);
    return {
      pass: after.length === 1 && after[0].detail.staleAcknowledgement === true,
      detail: `blocks=${after.length} stale=${after[0]?.detail?.staleAcknowledgement}`,
    };
  });

  run('QC-01: acknowledge_qc_critical_removal is a no-op when nothing is blocked', () => {
    const state = makeState();
    state.structuralQC.rejectedEventCount = 100;    // 1% removal: not critical
    state.structuralQC.retainedEventCount = 9900;
    const acknowledged = review.acknowledge_qc_critical_removal(state);
    return {
      pass: acknowledged.length === 0 && !state.qcAcknowledgements?.structural,
      detail: `acknowledged=${JSON.stringify(acknowledged)} stored=${JSON.stringify(state.qcAcknowledgements ?? {})}`,
    };
  });

  run('QC-01: prune_stale_qc_acknowledgements drops records that no longer name the outcome', () => {
    const state = makeState();
    review.acknowledge_qc_critical_removal(state, new Date('2026-08-18T12:00:00Z'));
    const keptWhenUnchanged = review.prune_stale_qc_acknowledgements(state);
    state.structuralQC.configHash = 'cfg-B';
    const droppedWhenChanged = review.prune_stale_qc_acknowledgements(state);
    return {
      pass: keptWhenUnchanged.length === 0 && droppedWhenChanged.length === 1
        && droppedWhenChanged[0] === 'structural' && !state.qcAcknowledgements.structural,
      detail: `unchanged=${JSON.stringify(keptWhenUnchanged)} changed=${JSON.stringify(droppedWhenChanged)}`,
    };
  });

  run('QC-01: an acknowledgement on one stage does not cover a critical loss on another', () => {
    const state = makeState();
    state.timeQC = {
      configHash: 'cfg-T', evaluatedEventCount: 10000,
      rejectedEventCount: 9000, retainedEventCount: 1000,
    };
    review.acknowledge_qc_critical_removal(state, new Date('2026-08-18T12:00:00Z'));
    // Both were blocking, so both should now be acknowledged...
    const bothAcked = blockedOnCriticalRemoval(state, state.qcAcknowledgements).length === 0;
    // ...but a structural-only acknowledgement must leave time blocked.
    const structuralOnly = { structural: state.qcAcknowledgements.structural };
    const timeStillBlocked = blockedOnCriticalRemoval(state, structuralOnly);
    return {
      pass: bothAcked && timeStillBlocked.length === 1 && timeStillBlocked[0].detail.name === 'time',
      detail: `bothAcked=${bothAcked} remaining=${JSON.stringify(timeStillBlocked.map((r) => r.detail.name))}`,
    };
  });

  return results;
}"""


def run_qc_acknowledgement_tests(ctx: TestContext):
    """Run the QC-01 critical-event-loss acknowledgement assertions."""

    try:
        all_results = ctx.page.evaluate(_TESTS)
    except Exception as err:
        ctx.check(GROUP, "qc acknowledgement suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
