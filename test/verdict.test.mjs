// The two CLIs emit different shapes (codex bare JSON, grok an envelope) — confirmed by
// calling them for real. Getting the parsing wrong does not raise an error; it just
// reads request_changes as approve. Silently waving a change through is the most
// dangerous way this mechanism can fail, so every malformed input gets an assertion.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeVerdict, parseCodexOutput, parseGrokOutput } from '../scripts/verdict.mjs';

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
