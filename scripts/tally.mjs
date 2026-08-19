// Vote counting and round semantics.
//
// The most important rule: if ANY reviewer fails, the whole round is inconclusive —
// even if the other one approved. In a two-reviewer setup, one missing vote means there
// was no cross-verification, and cross-verification is the only reason this mechanism
// exists. Treating a failure as an abstention and letting the surviving vote decide
// produces "looks reviewed but wasn't", which is more dangerous than no review at all.
//
// Second rule: inconclusive does not consume the round budget. A reviewer going down is
// an infrastructure problem and should not eat into the 3 rounds reserved for debate.
// But two in a row aborts, so an outage cannot burn time in an infinite retry loop.

export function tallyRound(results) {
  const okResults = results.filter((r) => r.status === 'ok');
  const failed = results.length - okResults.length;

  const blocking = okResults.flatMap((r) =>
    (r.blocking ?? []).map((b) => ({ ...b, reviewer: r.id })),
  );
  const approve = okResults.filter((r) => r.verdict === 'approve').length;
  const requestChanges = okResults.length - approve;

  // Cross-verification needs at least two independent verdicts. This is a DIFFERENT
  // outcome from inconclusive: inconclusive means a reviewer failed and retrying may help,
  // whereas this means the configuration cannot produce a cross-checked result at all, so
  // retrying is pure waste. Reporting it as inconclusive also produced a self-contradicting
  // summary — "0 failed" beside "a reviewer failed". board-round now rejects such a config
  // before spawning anything; this path remains as defence in depth.
  // Cross-verification needs at least two independent verdicts. With fewer, a single
  // model's approval would be presented as though two vendors had agreed — which is the
  // one thing this whole mechanism exists to prevent. This can happen without any
  // reviewer failing: configure one reviewer and every round would have read "approved".
  // Found by board reviewing its own fixes.
  const MIN_VERDICTS = 2;

  let outcome;
  if (okResults.length === 0) outcome = 'all_failed';
  else if (failed > 0) outcome = 'inconclusive';
  else if (okResults.length < MIN_VERDICTS) outcome = 'insufficient_verdicts';
  else if (requestChanges > 0) outcome = 'changes_requested';
  else outcome = 'approved';

  return { outcome, approve, requestChanges, failed, blocking };
}

// Reference implementation of the round state machine.
//
// NOTE: the loop is currently driven by the host agent following the protocol in
// SKILL.md; nothing in scripts/ calls this yet. It is kept (and tested) as the
// executable specification of those rules, and is the natural seam for moving the loop
// into code — which is where it belongs, per this project's own lesson that any step
// relying on an agent remembering will eventually be skipped.
export function advanceState(state, outcome, opts = {}) {
  const { maxRounds = 3, maxInconclusive = 2 } = opts;
  const { round, consecutiveInconclusive } = state;

  if (outcome === 'approved') {
    return { round, consecutiveInconclusive, status: 'passed', action: 'adjourn' };
  }
  if (outcome === 'all_failed') {
    return {
      round, consecutiveInconclusive, status: 'aborted', action: 'abort',
      reason: 'every reviewer failed this round',
    };
  }
  if (outcome === 'inconclusive') {
    const c = consecutiveInconclusive + 1;
    if (c >= maxInconclusive) {
      return {
        round, consecutiveInconclusive: c, status: 'aborted', action: 'abort',
        reason: `a reviewer failed ${c} rounds in a row; giving up rather than retrying forever`,
      };
    }
    return { round, consecutiveInconclusive: c, status: 'running', action: 'retry' };
  }

  // changes_requested
  if (round >= maxRounds) {
    return { round, consecutiveInconclusive: 0, status: 'escalated', action: 'escalate' };
  }
  return { round: round + 1, consecutiveInconclusive: 0, status: 'running', action: 'next_round' };
}
