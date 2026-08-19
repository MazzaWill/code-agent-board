# Changelog

## 0.1.0 — first public release

Initial release, extracted from the author's private skills repository.

### Included

- `code` and `plan` review modes, English and Chinese prompts (`--lang`)
- Two reviewers (codex, grok) running in parallel under hard read-only sandboxes
- Convergence protocol: blocking / non_blocking split, reasoned refusal, three-round
  escalation, and failure never counting as approval
- 102 offline tests, zero third-party dependencies
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

### Fixed after board reviewed the extraction itself

Before release, board was run on the extraction diff. It raised 7 blocking items; 6 were
real and are fixed here (the seventh was an artifact of the dogfood setup).

- **A structurally valid but empty verdict counted as an approve vote.** Demonstrated live
  in the same round: a reviewer spent one turn and returned
  `{"verdict":"request_changes","blocking":[],"one_line_summary":"placeholder"}`, which
  parsed cleanly and — with an empty blocking list — resolved to approve. Verdicts are now
  validated for shape and internal consistency; a contradiction is always resolved toward
  caution, so "request_changes with nothing listed" is a parse_error.
- **`board-doctor.mjs` did nothing and exited 0 when reached through a symlink** — that
  is, for every user who installed with `install.sh`. It compared `process.argv[1]` with
  `import.meta.url` without resolving symlinks. Both sides are now realpath'd, and there
  is a test that invokes the doctor through a symlinked install.
- **Unknown flags were ignored**, so `--mdoe plan` silently reviewed a plan with the code
  prompt; a malformed `--round` also bypassed the requirement to supply `--contested`.
  Parsing is now strict about unknown, repeated and value-less flags, and validates round.
- **The secret-filename pattern did not match `.envrc`, `secrets.env` or `secrets.txt`**
  while SECURITY.md promised `.env*`.
- **SECURITY.md claimed excluded files "are not sent".** That was too strong: the
  reviewers are agents with the repository as their working directory and prompts that
  encourage reading files, so a file board declines to attach can still be opened by a
  reviewer. Documented honestly, in both languages.
- **SKILL.md relied on `$TMP` surviving between commands** — two paragraphs after telling
  the agent not to rely on shell state — and used fixed filenames, so concurrent meetings
  could overwrite each other's context.

### Known limitations

- macOS and Linux only; Windows needs WSL
- The round loop is driven by the host agent following SKILL.md. `advanceState` in
  `tally.mjs` is the tested reference implementation of those rules but is not yet wired in.
- codex does not report cost, so the reported figure is always partial
