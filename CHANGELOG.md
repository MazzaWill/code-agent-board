# Changelog

## 0.1.0 — first public release

Initial release, extracted from the author's private skills repository.

### Included

- `code` and `plan` review modes, English and Chinese prompts (`--lang`)
- Two reviewers (codex, grok) running in parallel under hard read-only sandboxes
- Convergence protocol: blocking / non_blocking split, reasoned refusal, three-round
  escalation, and failure never counting as approval
- 75 offline tests, zero third-party dependencies
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

### Known limitations

- macOS and Linux only; Windows needs WSL
- The round loop is driven by the host agent following SKILL.md. `advanceState` in
  `tally.mjs` is the tested reference implementation of those rules but is not yet wired in.
- codex does not report cost, so the reported figure is always partial
