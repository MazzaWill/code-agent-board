// Choosing the wrong mode fails silently: review a plan with the code prompt and the
// reviewers go hunting for "bugs in this markdown", then very likely approve — because
// the markdown genuinely has no bugs. The user walks away believing the plan passed
// review. So a mistyped --mode must fail immediately and never fall back to the default.
//
// The same applies to --lang: falling back to a language the user did not ask for would
// silently change what the reviewers are asked to do.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { DEFAULT_LANG, DEFAULT_MODE, LANGS, MODES, resolveMode } from '../scripts/modes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every prompt, in every language, must carry the same two invariants. Keeping the
// phrases in a per-language table means adding a language cannot quietly ship a prompt
// that drops one of them.
const PHRASES = {
  en: {
    restraint: /empty `blocking` list is a perfectly good answer/i,
    truthful: /must be one you actually read/i,
  },
  'zh-CN': {
    restraint: /宁可 blocking 为空/,
    truthful: /必须是你真实读到的/,
  },
};

// The full (mode × lang) matrix, so a new mode or a new language is covered by every
// invariant below without anyone remembering to extend a list.
const MATRIX = Object.keys(MODES).flatMap((mode) => LANGS.map((lang) => ({ mode, lang })));

test('defaults to code review in English when nothing is passed', () => {
  const r = resolveMode(null, null);
  assert.equal(r.ok, true);
  assert.equal(r.mode, DEFAULT_MODE);
  assert.equal(r.mode, 'code');
  assert.equal(r.lang, DEFAULT_LANG);
  assert.equal(r.prompt, 'prompts/code-reviewer.md');
});

test('plan mode resolves to the plan prompt', () => {
  const r = resolveMode('plan', null);
  assert.equal(r.ok, true);
  assert.equal(r.prompt, 'prompts/plan-reviewer.md');
  assert.equal(r.label, 'plan review');
});

test('a non-default language resolves to the suffixed prompt', () => {
  const r = resolveMode('plan', 'zh-CN');
  assert.equal(r.ok, true);
  assert.equal(r.prompt, 'prompts/plan-reviewer.zh-CN.md');
});

test('an unknown mode fails and never falls back to the default', () => {
  const r = resolveMode('paln', null); // typo
  assert.equal(r.ok, false);
  assert.match(r.reason, /paln/);
  assert.match(r.reason, /code \| plan/, 'the error must list the valid values');
  assert.equal(r.prompt, undefined, 'a failed resolution must not hand back a usable prompt path');
});

test('an unknown language fails and never falls back to the default', () => {
  const r = resolveMode('code', 'fr');
  assert.equal(r.ok, false);
  assert.match(r.reason, /fr/);
  assert.match(r.reason, /en \| zh-CN/);
  assert.equal(r.prompt, undefined);
});

test('every (mode, language) pair resolves to a prompt file that exists', () => {
  for (const { mode, lang } of MATRIX) {
    const r = resolveMode(mode, lang);
    assert.equal(r.ok, true, `${mode}/${lang} did not resolve`);
    assert.ok(existsSync(join(ROOT, r.prompt)), `missing prompt file for ${mode}/${lang}: ${r.prompt}`);
  }
});

test('every prompt carries the {{BRIEF}} placeholder', () => {
  // Without the placeholder the brief never reaches the prompt: the reviewers see no
  // change at all and still return a verdict.
  for (const { mode, lang } of MATRIX) {
    const { prompt } = resolveMode(mode, lang);
    const text = readFileSync(join(ROOT, prompt), 'utf8');
    assert.ok(text.includes('{{BRIEF}}'), `${prompt} is missing {{BRIEF}}`);
  }
});

test('every prompt keeps the blocking-restraint rule', () => {
  // This rule is what makes the debate converge. No mode and no language may drop it.
  for (const { mode, lang } of MATRIX) {
    const { prompt } = resolveMode(mode, lang);
    const text = readFileSync(join(ROOT, prompt), 'utf8');
    assert.match(text, /non_blocking/, `${prompt} lacks the non_blocking tier`);
    assert.match(text, PHRASES[lang].restraint, `${prompt} lacks the restraint instruction`);
  }
});

test('every prompt requires citations to be real', () => {
  // Measured in practice: a reviewer cited a `user_models` table, a `storage_path`
  // column and an `/api/user` route in a four-file repository. None existed. The
  // reasoning was sound; the specifics were invented, and verifying them cost real time.
  for (const { mode, lang } of MATRIX) {
    const { prompt } = resolveMode(mode, lang);
    const text = readFileSync(join(ROOT, prompt), 'utf8');
    assert.match(text, PHRASES[lang].truthful, `${prompt} lacks the no-fabrication constraint`);
  }
});

test('the plan prompt tells reviewers that existing code is context, not the change', () => {
  const text = readFileSync(join(ROOT, resolveMode('plan', 'en').prompt), 'utf8');
  assert.match(text, /current state, not part of this change/i);
});
