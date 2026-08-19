// One validator for the reviewer roster, used by both board-doctor and board-round.
//
// It exists because "at least two reviewers" turned out to be three separate claims, and
// checking only the array length satisfied none of them properly:
//
//   - two entries              — or a single model's opinion is presented as agreement
//   - distinct ids             — verdict and transcript files are named by id, so two
//                                entries sharing one id silently overwrite each other's
//                                output mid-round
//   - at least two vendors     — two identically-configured codex entries pass a length
//                                check and a uniqueness check, and still give you one
//                                model reviewing twice. Cross-VENDOR disagreement is the
//                                entire signal; same-vendor duplication is not review.
//
// Vendor defaults to the binary name, which is right for the shipped config. Set an
// explicit `vendor` when two entries share a binary but reach different providers.
export function validateReviewerConfig(reviewers) {
  if (!Array.isArray(reviewers) || reviewers.length < 2) {
    const n = Array.isArray(reviewers) ? reviewers.length : 0;
    return {
      ok: false,
      reason: `only ${n} reviewer(s) configured — board needs at least 2, from different vendors, or there is no cross-verification to be had`,
    };
  }

  // An id is not just a label: it becomes a filename, via join(dir, `${id}.json`) and
  // join(dir, `${id}.md`). A value containing a path separator lands in a directory that
  // does not exist and takes the whole round down with it; `../../../package` resolves
  // clean out of the artifact directory, and since codex writes its verdict there through
  // -o, it would overwrite package.json in the repository under review. So: one portable
  // filename segment, nothing else.
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  for (const [i, r] of reviewers.entries()) {
    const id = r?.id;
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, reason: `reviewer at index ${i} has no id` };
    }
    if (!SAFE_ID.test(id)) {
      return {
        ok: false,
        reason: `reviewer id ${JSON.stringify(id)} is not a safe filename segment — ids become artifact filenames, so they must match ${SAFE_ID} (no path separators, no leading dot)`,
      };
    }
  }

  // Compare ids case-insensitively: on macOS and Windows "codex" and "CODEX" are the same
  // file, so a case-only difference silently overwrites rather than producing two records.
  const folded = reviewers.map((r) => r.id.toLowerCase());
  const duplicate = folded.find((id, i) => folded.indexOf(id) !== i);
  if (duplicate) {
    return {
      ok: false,
      reason: `duplicate reviewer id "${duplicate}" (ids are compared case-insensitively) — verdicts and transcripts are written to files named by id, so duplicates would overwrite each other`,
    };
  }

  // Normalize before comparing, or "openai" and "OpenAI" count as two vendors and the
  // check it exists to perform is skipped. An empty vendor is rejected outright rather
  // than treated as a distinct one.
  const vendorOf = (r) => String(r.vendor ?? r.bin ?? '').trim().toLowerCase();
  for (const [i, r] of reviewers.entries()) {
    if (!vendorOf(r)) {
      return { ok: false, reason: `reviewer "${r.id}" (index ${i}) has no vendor and no bin to infer one from` };
    }
  }

  const vendors = new Set(reviewers.map(vendorOf));
  if (vendors.size < 2) {
    return {
      ok: false,
      reason: `every reviewer uses the same vendor (${[...vendors].join(', ')}) — cross-vendor disagreement is the signal board exists to produce; the same model reviewing twice is not cross-verification`,
    };
  }

  return { ok: true };
}
