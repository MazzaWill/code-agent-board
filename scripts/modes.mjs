// Review modes: reviewing code vs reviewing a plan.
//
// The two ask fundamentally different questions. Code review asks "will this break?".
// Plan review asks "will the first step already fail, what cases are missing, is there
// a simpler way?". Feeding a plan to the code prompt makes reviewers hunt for "bugs in
// this markdown" — measured once, it did find something, but only because that plan's
// flaws happened to fall in the security/data-loss bucket the code criteria cover.
//
// Language is a second dimension: the prompt's language determines the language the
// reviewers answer in. English is the default; the Chinese prompts are the originals.

export const MODES = {
  code: { promptBase: 'prompts/code-reviewer', label: 'code review' },
  plan: { promptBase: 'prompts/plan-reviewer', label: 'plan review' },
};

export const LANGS = ['en', 'zh-CN'];

export const DEFAULT_MODE = 'code';
export const DEFAULT_LANG = 'en';

// Both unknown mode and unknown language fail hard rather than falling back.
// A silent fallback is the dangerous failure here: review a plan with the code prompt
// and the reviewers will approve it (the markdown really has no bugs), leaving you
// convinced the plan passed review.
export function resolveMode(mode, lang) {
  const key = mode ?? DEFAULT_MODE;
  const found = MODES[key];
  if (!found) {
    return { ok: false, reason: `Unknown --mode "${key}". Valid values: ${Object.keys(MODES).join(' | ')}` };
  }

  const lkey = lang ?? DEFAULT_LANG;
  if (!LANGS.includes(lkey)) {
    return { ok: false, reason: `Unknown --lang "${lkey}". Valid values: ${LANGS.join(' | ')}` };
  }

  const prompt = lkey === DEFAULT_LANG ? `${found.promptBase}.md` : `${found.promptBase}.${lkey}.md`;
  return { ok: true, mode: key, lang: lkey, prompt, label: found.label };
}
