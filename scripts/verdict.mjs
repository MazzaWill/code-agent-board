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
  return { status: 'ok', data: value, costUsd: null };
}

export function parseGrokOutput(text) {
  const { value: env, err } = parseJson(text, 'grok ');
  if (err) return { status: 'parse_error', reason: err };

  let data = env.structuredOutput;
  // Fall back to .text when structuredOutput is missing — it is the same verdict in
  // string form. Do not kill a whole round over one absent field if it can be recovered.
  if (data === undefined && typeof env.text === 'string') {
    const fallback = parseJson(env.text, 'grok .text ');
    if (!fallback.err) data = fallback.value;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'parse_error', reason: 'grok envelope had neither structuredOutput nor parseable text' };
  }
  const costUsd = typeof env.total_cost_usd === 'number' ? env.total_cost_usd : null;
  return { status: 'ok', data, costUsd };
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
