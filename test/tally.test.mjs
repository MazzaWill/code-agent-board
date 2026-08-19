// Get one counting rule wrong and the whole mechanism becomes a placebo. The two most
// dangerous ways to write it:
//   1. treat a failure as an abstention and let the surviving approve decide — one
//      missing vote means there was no cross-verification at all
//   2. let inconclusive consume the round budget — two blips and the 3 rounds reserved
//      for debate are gone
// Each gets its own assertion below.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { advanceState, tallyRound } from '../scripts/tally.mjs';

const ok = (id, verdict, blocking = []) => ({
  id, status: 'ok', verdict, blocking, non_blocking: [], one_line_summary: '', contradiction: false,
});
const dead = (id, status) => ({ id, status, reason: 'boom' });
const BLK = { file: 'a.ts', line: 3, issue: 'x', why_it_matters: 'y', suggested_fix: null };

test('everyone approves → approved', () => {
  const t = tallyRound([ok('codex', 'approve'), ok('grok', 'approve')]);
  assert.equal(t.outcome, 'approved');
  assert.equal(t.approve, 2);
  assert.equal(t.blocking.length, 0);
});

test('someone requests changes → changes_requested, blocking merged and attributed', () => {
  const t = tallyRound([ok('codex', 'request_changes', [BLK]), ok('grok', 'approve')]);
  assert.equal(t.outcome, 'changes_requested');
  assert.equal(t.requestChanges, 1);
  assert.equal(t.blocking.length, 1);
  assert.equal(t.blocking[0].reviewer, 'codex');
});

test('one failure plus one approve → inconclusive, never a pass', () => {
  const t = tallyRound([ok('codex', 'approve'), dead('grok', 'timeout')]);
  assert.equal(t.outcome, 'inconclusive');
  assert.equal(t.failed, 1);
});

test('one failure plus one request_changes → still inconclusive', () => {
  const t = tallyRound([ok('codex', 'request_changes', [BLK]), dead('grok', 'unavailable')]);
  assert.equal(t.outcome, 'inconclusive');
  assert.equal(t.blocking.length, 1, 'an inconclusive round must still surface the blocking items it did get');
});

test('everyone failed → all_failed', () => {
  const t = tallyRound([dead('codex', 'unavailable'), dead('grok', 'parse_error')]);
  assert.equal(t.outcome, 'all_failed');
  assert.equal(t.failed, 2);
});

test('approved → adjourn', () => {
  const s = advanceState({ round: 1, consecutiveInconclusive: 0 }, 'approved');
  assert.equal(s.action, 'adjourn');
  assert.equal(s.status, 'passed');
});

test('changes_requested → next round, counter advances', () => {
  const s = advanceState({ round: 1, consecutiveInconclusive: 0 }, 'changes_requested');
  assert.equal(s.action, 'next_round');
  assert.equal(s.round, 2);
});

test('still changes_requested at round 3 → escalate to the user, no round 4', () => {
  const s = advanceState({ round: 3, consecutiveInconclusive: 0 }, 'changes_requested');
  assert.equal(s.action, 'escalate');
  assert.equal(s.status, 'escalated');
});

test('inconclusive does not consume the round budget', () => {
  const s = advanceState({ round: 2, consecutiveInconclusive: 0 }, 'inconclusive');
  assert.equal(s.action, 'retry');
  assert.equal(s.round, 2, 'the round counter must not move');
  assert.equal(s.consecutiveInconclusive, 1);
});

test('two inconclusive rounds in a row → abort rather than retry forever', () => {
  const s = advanceState({ round: 2, consecutiveInconclusive: 1 }, 'inconclusive');
  assert.equal(s.action, 'abort');
  assert.equal(s.status, 'aborted');
});

test('a successful round resets the inconclusive counter', () => {
  const s = advanceState({ round: 1, consecutiveInconclusive: 1 }, 'changes_requested');
  assert.equal(s.consecutiveInconclusive, 0);
});

test('all_failed → abort immediately', () => {
  const s = advanceState({ round: 1, consecutiveInconclusive: 0 }, 'all_failed');
  assert.equal(s.action, 'abort');
});

test('a single verdict is never approval, even with nobody failing', () => {
  // Configure one reviewer and every round used to read "approved" — one model's opinion
  // presented as though two vendors had agreed. No reviewer fails in this scenario, so
  // the existing failure paths never caught it. Found by board reviewing its own fixes.
  const one = [ok('codex', 'approve')];
  const t = tallyRound(one);
  assert.equal(t.outcome, 'inconclusive');
  assert.equal(t.failed, 0, 'nothing failed — the round is inconclusive because it was never cross-verified');
});

test('a single request_changes verdict is also inconclusive, not changes_requested', () => {
  const t = tallyRound([ok('codex', 'request_changes', [BLK])]);
  assert.equal(t.outcome, 'inconclusive');
  assert.equal(t.blocking.length, 1, 'the finding is still surfaced');
});

test('two verdicts remain the normal path', () => {
  assert.equal(tallyRound([ok('codex', 'approve'), ok('grok', 'approve')]).outcome, 'approved');
});
