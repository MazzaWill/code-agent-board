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

  const ids = reviewers.map((r) => r?.id);
  const missing = ids.findIndex((id) => typeof id !== 'string' || !id.trim());
  if (missing !== -1) {
    return { ok: false, reason: `reviewer at index ${missing} has no id` };
  }

  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) {
    return {
      ok: false,
      reason: `duplicate reviewer id "${duplicate}" — verdicts and transcripts are written to files named by id, so duplicates would overwrite each other`,
    };
  }

  const vendors = new Set(reviewers.map((r) => r.vendor ?? r.bin));
  if (vendors.size < 2) {
    return {
      ok: false,
      reason: `every reviewer uses the same vendor (${[...vendors].join(', ')}) — cross-vendor disagreement is the signal board exists to produce; the same model reviewing twice is not cross-verification`,
    };
  }

  return { ok: true };
}
