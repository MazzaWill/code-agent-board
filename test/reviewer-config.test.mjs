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

// —— Found by board in round 4: the roster validator's own inputs were unvalidated.

test('an id that is not a safe filename segment is rejected', () => {
  // ids become filenames — join(dir, `${id}.json`) for the verdict and `${id}.md` for the
  // transcript. `../../../package` resolves clean out of the artifact directory, and
  // since codex writes its verdict through -o, it would overwrite package.json in the
  // repository under review.
  for (const bad of ['../../../package', 'a/b', 'a\\b', '.hidden', '.', '..', 'has space', '']) {
    const r = validateReviewerConfig([rv(bad, 'codex'), rv('grok', 'grok')]);
    assert.equal(r.ok, false, `id ${JSON.stringify(bad)} must be rejected`);
  }
});

test('ordinary ids are still accepted', () => {
  for (const good of ['codex', 'grok-4', 'claude_cli', 'x.y', 'a1']) {
    assert.equal(validateReviewerConfig([rv(good, 'a'), rv('other', 'b')]).ok, true, good);
  }
});

test('ids differing only in case are duplicates', () => {
  // On macOS and Windows they are the same file, so one would silently overwrite the other.
  const r = validateReviewerConfig([rv('codex', 'a'), rv('CODEX', 'b')]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate/);
});

test('vendors are normalized before being compared', () => {
  // Without normalization "openai" and "OpenAI" count as two vendors and the check does
  // nothing — two identical reviewers would be reported as cross-vendor agreement.
  const r = validateReviewerConfig([
    rv('a', 'x', { vendor: 'openai' }),
    rv('b', 'y', { vendor: '  OpenAI  ' }),
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /same vendor/);
});

test('an empty vendor is rejected rather than counted as a distinct one', () => {
  const r = validateReviewerConfig([rv('a', '', { vendor: '' }), rv('b', 'codex')]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no vendor/);
});

test('the vendor rule applies to the roster as a whole, not to each pair', () => {
  // A third entry from a vendor already on the roster is fine — what must not happen is a
  // roster that spans only one vendor. Pinned because the README describes this rule and
  // the wording is easy to read the other way.
  assert.equal(
    validateReviewerConfig([rv('codex', 'codex'), rv('grok', 'grok'), rv('codex2', 'codex')]).ok,
    true,
    'two vendors across three entries is a valid roster',
  );
  assert.equal(
    validateReviewerConfig([rv('a', 'codex'), rv('b', 'codex'), rv('c', 'codex')]).ok,
    false,
    'three entries from one vendor is still one model reviewing three times',
  );
});
