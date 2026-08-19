// The summary table is the only thing the host session reads in full. Drop "someone
// died" or drop a contradiction flag, and the host decides whether to change code on
// incomplete information.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatSummary } from '../scripts/summary.mjs';
import { tallyRound } from '../scripts/tally.mjs';

const ok = (id, verdict, blocking = [], extra = {}) => ({
  id, label: id, status: 'ok', verdict, blocking, non_blocking: [],
  one_line_summary: `${id} said something`, contradiction: false, ...extra,
});
const BLK = {
  file: 'src/payment/webhook.ts', line: 88, issue: 'throws when the subscription has expired',
  why_it_matters: 'the caller only catches StripeError, so this escapes as a 500',
  suggested_fix: 'fall back to free-tier permissions',
};

function render(results, round = 1) {
  return formatSummary({
    round, results, tally: tallyRound(results),
    artifactDir: '.claude/board/round-1',
  });
}

test('the header carries the round number and the vote counts', () => {
  const out = render([ok('codex', 'approve'), ok('grok', 'approve')]);
  assert.match(out, /Round 1/);
  assert.match(out, /2 approve/);
});

test('blocking entries expand in full: file, line, reasoning, suggested fix', () => {
  const out = render([ok('codex', 'request_changes', [BLK]), ok('grok', 'approve')]);
  assert.match(out, /src\/payment\/webhook\.ts:88/);
  assert.match(out, /throws when the subscription has expired/);
  assert.match(out, /only catches StripeError/);
  assert.match(out, /fall back to free-tier permissions/);
  assert.match(out, /\[codex\]/);
});

test('a failed reviewer must appear in the table with the reason stated', () => {
  const out = render([ok('codex', 'approve'), { id: 'grok', label: 'grok', status: 'timeout', reason: 'exceeded 300s' }]);
  assert.match(out, /grok/);
  assert.match(out, /timeout/);
  assert.match(out, /exceeded 300s/);
  assert.match(out, /inconclusive/i, 'the round outcome must read inconclusive, not just "1 approve"');
});

test('a self-contradicting verdict is flagged', () => {
  const out = render([
    ok('codex', 'request_changes', [BLK], { contradiction: true, declared: 'approve' }),
    ok('grok', 'approve'),
  ]);
  assert.match(out, /CONTRADICTION/);
});

test('transcript paths are derived from the actual reviewers, not hardcoded', () => {
  // Hardcoding "{codex,grok}.md" made the table advertise paths that do not exist as
  // soon as anyone added a third reviewer — while the docs said adding one was
  // config-only.
  const out = render([ok('codex', 'approve'), ok('grok', 'approve'), ok('gemini', 'approve')]);
  assert.match(out, /\.claude\/board\/round-1\/codex\.md/);
  assert.match(out, /\.claude\/board\/round-1\/grok\.md/);
  assert.match(out, /\.claude\/board\/round-1\/gemini\.md/, 'a third reviewer must get its transcript listed too');
  assert.doesNotMatch(out, /\{codex,grok\}/, 'the brace-expansion literal must be gone');
});

test('the cost line names who reported it, and who did not', () => {
  // codex does not report cost. Summing only the reviewers that do and calling the
  // result "this round's cost" understates it silently.
  const out = render([ok('codex', 'approve'), ok('grok', 'approve', [], { costUsd: 0.0133 })]);
  assert.match(out, /0\.0133/);
  assert.match(out, /reported by grok/i);
  assert.match(out, /codex does not report cost/i, 'the table must say the number is partial');
});

test('no cost line at all when nobody reported a number', () => {
  const out = render([ok('codex', 'approve')]);
  assert.doesNotMatch(out, /NaN/);
  assert.doesNotMatch(out, /Cost reported/i);
});
