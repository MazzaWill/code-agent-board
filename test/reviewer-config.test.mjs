// "At least two reviewers" turned out to be three claims, and a length check satisfied
// none of them properly. Found by board reviewing the fix that introduced the length
// check — the second time in this project that a roster problem slipped through.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { validateReviewerConfig } from '../scripts/reviewer-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shipped = createRequire(import.meta.url)(join(ROOT, 'config/reviewers.json')).reviewers;

const rv = (id, bin, extra = {}) => ({ id, bin, label: id, args: [], ...extra });

test('the shipped configuration is valid', () => {
  assert.equal(validateReviewerConfig(shipped).ok, true);
});

test('fewer than two reviewers is rejected', () => {
  for (const roster of [[], [rv('codex', 'codex')], null, undefined]) {
    const r = validateReviewerConfig(roster);
    assert.equal(r.ok, false);
    assert.match(r.reason, /at least 2/);
  }
});

test('duplicate ids are rejected — they would overwrite each other mid-round', () => {
  // outFile(id) and transcript(id) are both named by id, so two entries sharing one id
  // silently clobber each other's verdict and transcript.
  const r = validateReviewerConfig([rv('codex', 'codex'), rv('codex', 'grok')]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate reviewer id "codex"/);
});

test('two entries from the same vendor are rejected', () => {
  // The failing case that a length check and a uniqueness check both wave through: two
  // differently-named codex entries. That is one model reviewing twice, and reporting it
  // as agreement between vendors is the single thing this project must never do.
  const r = validateReviewerConfig([rv('codex-a', 'codex'), rv('codex-b', 'codex')]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /same vendor/);
});

test('an explicit vendor field can distinguish entries sharing a binary', () => {
  const r = validateReviewerConfig([
    rv('a', 'llm-cli', { vendor: 'anthropic' }),
    rv('b', 'llm-cli', { vendor: 'openai' }),
  ]);
  assert.equal(r.ok, true);
});

test('a reviewer without an id is rejected', () => {
  const r = validateReviewerConfig([rv('codex', 'codex'), { bin: 'grok', args: [] }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no id/);
});
