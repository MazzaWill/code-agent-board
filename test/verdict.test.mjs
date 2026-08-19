// The two CLIs emit different shapes (codex bare JSON, grok an envelope) — confirmed by
// calling them for real. Getting the parsing wrong does not raise an error; it just
// reads request_changes as approve. Silently waving a change through is the most
// dangerous way this mechanism can fail, so every malformed input gets an assertion.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeVerdict, parseCodexOutput, parseGrokOutput, validateVerdict } from '../scripts/verdict.mjs';

const OBJ = { verdict: 'approve', blocking: [], non_blocking: [], one_line_summary: 'ok' };

test('codex: bare JSON parses directly', () => {
  const r = parseCodexOutput(JSON.stringify(OBJ));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, OBJ);
  assert.equal(r.costUsd, null);
});

test('codex: empty output is a parse_error, never treated as a pass', () => {
  assert.equal(parseCodexOutput('').status, 'parse_error');
  assert.equal(parseCodexOutput('   ').status, 'parse_error');
});

test('codex: malformed JSON is a parse_error', () => {
  assert.equal(parseCodexOutput('{oops').status, 'parse_error');
});

test('grok: verdict comes from the envelope structuredOutput, along with the cost', () => {
  const env = { text: JSON.stringify(OBJ), structuredOutput: OBJ, total_cost_usd: 0.0133 };
  const r = parseGrokOutput(JSON.stringify(env));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, OBJ);
  assert.equal(r.costUsd, 0.0133);
});

test('grok: falls back to parsing .text when structuredOutput is missing', () => {
  const env = { text: JSON.stringify(OBJ), total_cost_usd: 0.01 };
  const r = parseGrokOutput(JSON.stringify(env));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, OBJ);
});

test('grok: envelope present but both fields missing → parse_error', () => {
  const r = parseGrokOutput(JSON.stringify({ stopReason: 'end_turn' }));
  assert.equal(r.status, 'parse_error');
});

test('grok: empty output is a parse_error', () => {
  assert.equal(parseGrokOutput('').status, 'parse_error');
});

test('normalize: a non-empty blocking list means request_changes', () => {
  const v = normalizeVerdict({
    verdict: 'request_changes',
    blocking: [{ file: 'a.ts', line: 1, issue: 'x', why_it_matters: 'y', suggested_fix: null }],
    non_blocking: [],
    one_line_summary: 's',
  });
  assert.equal(v.verdict, 'request_changes');
  assert.equal(v.contradiction, false);
  assert.equal(v.blocking.length, 1);
});

test('normalize: declared approve but raised blocking → the list wins, flagged as contradictory', () => {
  const v = normalizeVerdict({
    verdict: 'approve',
    blocking: [{ file: 'a.ts', line: null, issue: 'x', why_it_matters: 'y', suggested_fix: null }],
    non_blocking: [],
    one_line_summary: 's',
  });
  assert.equal(v.verdict, 'request_changes');
  assert.equal(v.declared, 'approve');
  assert.equal(v.contradiction, true);
});

test('normalize: declared request_changes with an empty blocking list → treated as approve, flagged', () => {
  const v = normalizeVerdict({
    verdict: 'request_changes', blocking: [], non_blocking: [], one_line_summary: 's',
  });
  assert.equal(v.verdict, 'approve');
  assert.equal(v.contradiction, true);
});

test('normalize: missing or wrongly-typed fields degrade to empty arrays instead of throwing', () => {
  const v = normalizeVerdict({});
  assert.deepEqual(v.blocking, []);
  assert.deepEqual(v.non_blocking, []);
  assert.equal(v.one_line_summary, '');
  assert.equal(v.verdict, 'approve');
});

// —— Shape and consistency validation. Added after board, reviewing its own extraction,
// —— pointed out that a malformed-but-parseable payload became an approve vote — and
// —— then demonstrated it live in the same round.

const PLACEHOLDER = { verdict: 'request_changes', blocking: [], non_blocking: [], one_line_summary: 'placeholder' };

test('validate: request_changes with an empty blocking list is unusable, not approval', () => {
  // Measured live: a reviewer spent one turn and returned exactly this. It is
  // structurally valid, so it parsed — and with no blocking items it was counted as an
  // APPROVE from a reviewer that had done no work.
  const v = validateVerdict(PLACEHOLDER);
  assert.equal(v.ok, false);
  assert.match(v.reason, /nothing actionable/);
});

test('validate: that payload is now a parse_error from both parsers', () => {
  assert.equal(parseGrokOutput(JSON.stringify({ structuredOutput: PLACEHOLDER })).status, 'parse_error');
  assert.equal(parseCodexOutput(JSON.stringify(PLACEHOLDER)).status, 'parse_error');
});

test('validate: an unknown verdict value is rejected', () => {
  const v = validateVerdict({ ...OBJ, verdict: 'lgtm' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /lgtm/);
});

test('validate: a blocking entry missing why_it_matters is rejected', () => {
  // why_it_matters is what makes a finding actionable; without it there is nothing to
  // verify and nothing to weigh against declining.
  const v = validateVerdict({
    ...OBJ, verdict: 'request_changes',
    blocking: [{ file: 'a.ts', issue: 'x' }],
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /why_it_matters/);
});

test('validate: wrong types and empty summaries are rejected', () => {
  assert.equal(validateVerdict({ ...OBJ, blocking: 'nope' }).ok, false);
  assert.equal(validateVerdict({ ...OBJ, non_blocking: null }).ok, false);
  assert.equal(validateVerdict({ ...OBJ, one_line_summary: '  ' }).ok, false);
  assert.equal(validateVerdict({}).ok, false);
  assert.equal(validateVerdict(null).ok, false);
});

test('validate: a well-formed verdict still passes', () => {
  assert.equal(validateVerdict(OBJ).ok, true);
  assert.equal(validateVerdict({
    verdict: 'request_changes',
    blocking: [{ file: 'a.ts', line: 3, issue: 'x', why_it_matters: 'y', suggested_fix: null }],
    non_blocking: [], one_line_summary: 's',
  }).ok, true);
});

test('the contradiction that resolves toward caution is still allowed through', () => {
  // declared approve + blocking items → request_changes. That direction is safe, so it
  // must keep working; only the permissive direction is now refused.
  const declaredApprove = {
    verdict: 'approve',
    blocking: [{ file: 'a.ts', issue: 'x', why_it_matters: 'y' }],
    non_blocking: [], one_line_summary: 's',
  };
  assert.equal(validateVerdict(declaredApprove).ok, true);
  const n = normalizeVerdict(declaredApprove);
  assert.equal(n.verdict, 'request_changes');
  assert.equal(n.contradiction, true);
});

test('a literal null document is a parse_error, not a crash', () => {
  // `null` is valid JSON and is what a CLI emits when it produced no result, so it sails
  // past the empty-text check and then throws on property access — inside a child-process
  // callback, where main().catch cannot reach it. That killed the entire round and took
  // the other reviewer's paid verdict with it.
  for (const raw of ['null', 'null\n', '123', '"a string"', '[]']) {
    const r = parseGrokOutput(raw);
    assert.equal(r.status, 'parse_error', `${raw} should be a parse_error`);
  }
});

test('an explicit "structuredOutput": null still recovers from .text', () => {
  // The fallback was gated on `undefined`, so a CLI that emits null for a field it could
  // not fill — the likelier of the two — lost a verdict that was sitting right there in
  // .text, and cost a full-price rerun.
  const verdict = { verdict: 'approve', blocking: [], non_blocking: [], one_line_summary: 'recovered' };
  const r = parseGrokOutput(JSON.stringify({ structuredOutput: null, text: JSON.stringify(verdict), total_cost_usd: 0.12 }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, verdict);
  assert.equal(r.costUsd, 0.12);
});
