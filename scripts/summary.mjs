// The summary table is the only thing the host session reads in full (transcripts are
// consulted on demand), so "a reviewer died" and "this verdict contradicts itself" MUST
// appear here — omitting either means the host decides on incomplete information.

const OUTCOME_LABEL = {
  approved: 'approved (unanimous)',
  changes_requested: 'changes_requested (blocking objections raised)',
  inconclusive: 'inconclusive (a reviewer failed — this round does not count)',
  all_failed: 'all_failed (every reviewer failed)',
};

function line(ch = '─', n = 60) {
  return ch.repeat(n);
}

export function formatSummary({ round, results, tally, artifactDir, modeLabel }) {
  const out = [];

  // Tag the mode: code review and plan review use different blocking criteria, and
  // conflating them when re-reading old minutes leads to misreading the conclusion.
  const tag = modeLabel ? `[${modeLabel}] ` : '';
  out.push(
    `${tag}Round ${round} — ${tally.approve} approve / ${tally.requestChanges} request_changes / ${tally.failed} failed`,
  );
  out.push(`Outcome: ${OUTCOME_LABEL[tally.outcome] ?? tally.outcome}`);
  out.push(line());

  for (const r of results) {
    const name = (r.label ?? r.id).padEnd(20);
    if (r.status !== 'ok') {
      out.push(`${name} ${r.status.padEnd(16)} ${r.reason ?? ''}`);
      continue;
    }
    const counts = `(${r.blocking.length} blocking, ${r.non_blocking.length} non-blocking)`;
    const flag = r.contradiction
      ? `  ⚠ CONTRADICTION: declared ${r.declared} but raised ${r.blocking.length} blocking item(s)`
      : '';
    out.push(`${name} ${r.verdict.padEnd(16)} ${r.one_line_summary} ${counts}${flag}`);
  }

  if (tally.blocking.length > 0) {
    out.push('');
    out.push('BLOCKING:');
    for (const b of tally.blocking) {
      const loc = b.line == null ? b.file : `${b.file}:${b.line}`;
      out.push(`[${b.reviewer}] ${loc}`);
      out.push(`  Issue: ${b.issue}`);
      out.push(`  Why it matters: ${b.why_it_matters}`);
      if (b.suggested_fix) out.push(`  Suggested fix: ${b.suggested_fix}`);
    }
  }

  out.push('');

  // Derive transcript paths from the actual results. Hardcoding the reviewer ids here
  // made the table print paths that do not exist as soon as anyone added a third
  // reviewer — while the README claimed adding one was config-only.
  if (results.length > 0) {
    out.push(`Transcripts: ${results.map((r) => `${artifactDir}/${r.id}.md`).join(', ')}`);
  }

  // Cost honesty: not every CLI reports cost (codex does not). Summing only the ones
  // that do and calling the result "this round's cost" understates it silently — which
  // is exactly the kind of quiet untruth this tool exists to prevent elsewhere.
  const reporting = results.filter((r) => typeof r.costUsd === 'number');
  if (reporting.length > 0) {
    const total = reporting.reduce((a, r) => a + r.costUsd, 0);
    const who = reporting.map((r) => r.id).join(', ');
    const silent = results.filter((r) => typeof r.costUsd !== 'number').map((r) => r.id);
    const caveat = silent.length > 0 ? ` — ${silent.join(', ')} do${silent.length === 1 ? 'es' : ''} not report cost` : '';
    out.push(`Cost reported by ${who}: $${total.toFixed(4)}${caveat}`);
  }

  return out.join('\n');
}
