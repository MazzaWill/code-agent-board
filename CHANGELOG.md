# Changelog

## 0.1.0 — first public release

Initial release, extracted from the author's private skills repository.

### Included

- `code` and `plan` review modes, English and Chinese prompts (`--lang`)
- Two reviewers (codex, grok) running in parallel under hard read-only sandboxes
- Convergence protocol: blocking / non_blocking split, reasoned refusal, three-round
  escalation, and failure never counting as approval
- 116 offline tests, zero third-party dependencies
- `board-doctor` environment check

### Fixed while extracting for release

- Untracked, non-gitignored files whose names look like secrets (`.env`, `*.pem`, …) had
  their full contents attached to the brief and sent to two vendors. They are now skipped
  visibly.
- The doctor kept a hand-written copy of each CLI's invocation, so it probed the CLI's
  *default* model rather than the pinned one. An account without access to the pinned
  model got a green "all ready" and failed on the first meeting. The probe is now derived
  from `config/reviewers.json`, with a model-parity assertion that refuses to run if it
  cannot prove it is probing the right model.
- A reviewer id the doctor did not recognise printed a warning but did not count as a
  failure, so the run still reported "all ready" and exited 0.
- The summary table hardcoded `{codex,grok}.md` for transcript paths, and its cost line
  summed only the reviewers that report cost while presenting the result as the round's
  total. Both are now derived from the actual results, and the cost line names who
  reported it.
- A reviewer that failed to spawn left no transcript, so the summary pointed at a file
  that was never written.
- SKILL.md hardcoded `~/.claude/skills/board/` in three commands, defeating the scripts'
  own relocatability. Replaced with a candidate-path probe plus `BOARD_HOME`.
- `--intent` / `--contested` pointing inside the repository under review is now rejected;
  such a file becomes untracked and ends up inside its own brief.

### Fixed after board reviewed itself

Before release, board was run on the extraction — and then on each round's fixes. Every
round found real defects in the previous round's repairs. Fourteen in total across four rounds, all fixed here.
DESIGN §13 carries the reasoning; the ones that would have bitten users:

**Silent passes.** A structurally valid but empty verdict counted as an approve vote —
demonstrated live in the round that reported it, when a reviewer spent one turn and
returned `{"verdict":"request_changes","blocking":[],"one_line_summary":"placeholder"}`.
And a single verdict counted as approval, so a one-reviewer configuration reported every
round as `approved`: one model's opinion presented as though two vendors had agreed.
Verdicts are now validated for shape and internal consistency, contradictions always
resolve toward caution, and a round needs at least two independent verdicts to pass.

**Inputs the validators themselves did not validate.** `advanceState` did not know the
outcome added alongside it and fell through to "open another round", turning "this roster
can never work" into a retry loop. Vendor values were compared without normalization, so
`openai` and `OpenAI` counted as two vendors. And reviewer ids — which become artifact
filenames — were only checked for exact duplicates: `../../../package` resolves out of the
artifact directory, and codex writes its verdict there via `-o`, so it would have
overwritten `package.json` in the repository under review.

**Rosters that were not really cross-vendor.** "At least two reviewers" was enforced as an
array length, so two identically-configured codex entries passed — one model reviewing
twice. Duplicate ids also overwrote each other's verdict and transcript, since both are
filed by id. Now validated in one shared place, before anything is spawned.

**A diagnostic tool that silently succeeded.** `board-doctor` did nothing and exited 0 when
reached through a symlink — that is, for everyone who installed with `install.sh`. The
install-name check then took three attempts to get right; the first two both warned users
who had followed the README exactly.

**Silent fallbacks.** Unknown flags were ignored, so `--mdoe plan` reviewed a plan with the
code prompt and very likely approved it. A malformed `--round` bypassed the requirement to
supply `--contested`.

**Secrets.** The secret-filename pattern missed `.envrc`, `secrets.env` and `secrets.txt`
while SECURITY.md promised `.env*`. And SECURITY.md claimed excluded files "are not sent",
which was too strong — the reviewers are agents with the repository as their working
directory and prompts that encourage reading files, so a file board declines to attach can
still be opened by a reviewer. Now documented honestly in both languages.

**Honesty in the output.** The summary hardcoded `{codex,grok}.md` for transcript paths and
presented one CLI's cost as the round's total. Both derive from the actual results now, and
the cost line names who reported it.

### Known limitations

- macOS and Linux only; Windows needs WSL
- The round loop is driven by the host agent following SKILL.md. `advanceState` in
  `tally.mjs` is the tested reference implementation of those rules but is not yet wired in.
- codex does not report cost, so the reported figure is always partial
- **A reviewer can degrade rather than fail, and no transport-level check catches it.**
  Measured across three rounds of reviewing this repository: one reviewer produced a real
  review once, and twice returned an answer it had not arrived at — first an empty verdict
  (now rejected by validation), then "I need to read more context first" filed as a blocking
  item, complete with file, issue and why_it_matters. That second form is structurally
  indistinguishable from a finding and schema validation cannot reach it. The tells are
  cost and elapsed time: $0.0054 and $0.0138 against $0.2047 for the round it worked.
  Elapsed time is now recorded in every transcript header. This is why SKILL.md's iron rule
  is that a human verifies before acting on any blocking item.
- Reviewing a large diff is slow: 3,468 lines took one reviewer 13m49s, 71 seconds short of
  the default 900-second timeout. Raise `timeoutMs` if you routinely review changes that big.
