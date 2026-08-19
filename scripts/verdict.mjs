// Parse each CLI's verdict output. The shapes differ — measured by actually calling
// them, not read from documentation:
//   codex  -o <file> writes bare JSON, no envelope
//   grok   stdout is an envelope; the verdict is at .structuredOutput, cost at .total_cost_usd
// Neither CLI documents this difference. Before changing anything here, make a real
// call and confirm the shapes have not moved.

function parseJson(text, what) {
  if (!text || !text.trim()) return { err: `${what}output was empty` };
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { err: `${what}output was not valid JSON: ${e.message}` };
  }
}

export function parseCodexOutput(text) {
  const { value, err } = parseJson(text, 'codex ');
  if (err) return { status: 'parse_error', reason: err };
  const v = validateVerdict(value);
  if (!v.ok) return { status: 'parse_error', reason: v.reason };
  return { status: 'ok', data: value, costUsd: null };
}

export function parseGrokOutput(text) {
  const { value: env, err } = parseJson(text, 'grok ');
  if (err) return { status: 'parse_error', reason: err };

  // `null` is a valid JSON document, and it is exactly what a CLI emits when it produced
  // no result — so it sails past the empty-text check and then explodes on property
  // access. This throws inside a child-process callback, where main().catch cannot reach
  // it, killing the whole round and discarding the other reviewer's paid verdict.
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { status: 'parse_error', reason: `grok output was ${env === null ? 'null' : typeof env}, not an envelope` };
  }

  let data = env.structuredOutput;
  // Fall back to .text when structuredOutput is missing — it is the same verdict in
  // string form. Do not kill a whole round over one absent field if it can be recovered.
  // `== null` on purpose: an explicit "structuredOutput": null is likelier than the key
  // being absent, and the recovery path existed precisely so one empty field would not
  // cost a whole round.
  if (data == null && typeof env.text === 'string') {
    const fallback = parseJson(env.text, 'grok .text ');
    if (!fallback.err) data = fallback.value;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    // Carry across what the envelope already told us. Measured case: stopReason
    // "cancelled", structuredOutput null, structuredOutputError "model did not produce
    // structured output", and a .text holding two concatenated JSON objects. Every one of
    // those is diagnostic, and all of it was being thrown away in favour of a message that
    // sent the reader digging through the transcript.
    const detail = [
      typeof env.structuredOutputError === 'string' ? `grok said: ${env.structuredOutputError}` : null,
      typeof env.stopReason === 'string' ? `stopReason=${env.stopReason}` : null,
    ].filter(Boolean).join('; ');
    return {
      status: 'parse_error',
      reason: `grok envelope had neither structuredOutput nor parseable text${detail ? ` (${detail})` : ''}`,
    };
  }
  const v = validateVerdict(data);
  if (!v.ok) return { status: 'parse_error', reason: v.reason };
  const costUsd = typeof env.total_cost_usd === 'number' ? env.total_cost_usd : null;
  return { status: 'ok', data, costUsd };
}

// Validate the verdict's shape AND its internal consistency before anyone counts votes.
//
// The CLIs are given a strict JSON schema, but schema enforcement can lapse — a version
// bump, a fallback path, a model that answers without really working. Measured live while
// reviewing this very extraction: one reviewer burned a single turn and returned
// {"verdict":"request_changes","blocking":[],"one_line_summary":"placeholder"}. That is
// structurally valid, so it parsed fine, and because the blocking list was empty it was
// counted as an APPROVE — a reviewer that did no work casting a vote in favour.
//
// Two rules follow:
//   - anything that does not match the schema is a parse_error, never a vote
//   - "request_changes with nothing listed" is unusable, not approval. Resolving a
//     contradiction must always move toward caution; the opposite direction (declaring
//     approve while listing blocking items) still resolves to request_changes below.
export function validateVerdict(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'verdict payload is not an object' };
  }
  const { verdict, blocking, non_blocking, one_line_summary } = data;

  if (verdict !== 'approve' && verdict !== 'request_changes') {
    return { ok: false, reason: `verdict must be "approve" or "request_changes", got ${JSON.stringify(verdict)}` };
  }
  if (!Array.isArray(blocking)) return { ok: false, reason: 'blocking is not an array' };
  if (!Array.isArray(non_blocking)) return { ok: false, reason: 'non_blocking is not an array' };
  if (typeof one_line_summary !== 'string' || !one_line_summary.trim()) {
    return { ok: false, reason: 'one_line_summary is missing or empty' };
  }

  for (const [i, b] of blocking.entries()) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      return { ok: false, reason: `blocking[${i}] is not an object` };
    }
    for (const field of ['file', 'issue', 'why_it_matters']) {
      if (typeof b[field] !== 'string' || !b[field].trim()) {
        return { ok: false, reason: `blocking[${i}] is missing "${field}"` };
      }
    }
  }

  if (verdict === 'request_changes' && blocking.length === 0) {
    return {
      ok: false,
      reason: 'declared request_changes but listed no blocking items — nothing actionable, and counting it as approval would be wrong',
    };
  }

  return { ok: true };
}

export function normalizeVerdict(data) {
  const blocking = Array.isArray(data?.blocking) ? data.blocking : [];
  const nonBlocking = Array.isArray(data?.non_blocking) ? data.non_blocking : [];

  // When the verdict field contradicts the blocking list, the list wins: models
  // occasionally fill in the wrong enum value, but they do not invent concrete entries
  // complete with file/issue/why_it_matters. Trusting the enum instead means one
  // mistyped "approve" silently waves through two real bugs.
  const effective = blocking.length > 0 ? 'request_changes' : 'approve';
  const declared = typeof data?.verdict === 'string' ? data.verdict : null;

  return {
    verdict: effective,
    declared,
    contradiction: declared !== null && declared !== effective,
    blocking,
    non_blocking: nonBlocking,
    one_line_summary: typeof data?.one_line_summary === 'string' ? data.one_line_summary : '',
  };
}
