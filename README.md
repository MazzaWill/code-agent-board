# code-agent-board

**Two rival AI CLIs read your uncommitted diff, argue about it across multiple rounds, and
the meeting only adjourns when neither has a blocking objection.**

A skill for [Claude Code](https://claude.com/claude-code). One model reviewing its own
work shares its own blind spots — this makes two models from *different vendors* review
independently and then debate, with you as the chair.

[![CI](https://github.com/MazzaWill/code-agent-board/actions/workflows/ci.yml/badge.svg)](https://github.com/MazzaWill/code-agent-board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

[中文文档 →](README.zh-CN.md)

## What you get

One table, on stdout, per round:

```
[code review] Round 1 — 1 approve / 1 request_changes / 0 failed
Outcome: changes_requested (blocking objections raised)
────────────────────────────────────────────────────────────
codex   request_changes  webhook does not downgrade on expiry   (2 blocking, 1 non-blocking)
grok    approve          nothing blocking                       (0 blocking, 3 non-blocking)

BLOCKING:
[codex] src/payment/webhook.ts:88
  Issue: throws when the subscription has expired, without falling back to free
  Why it matters: the caller only catches StripeError, so a TypeError escapes as a 500
  Suggested fix: return a free-tier permission object on the expiry branch

Transcripts: .claude/board/round-1/codex.md, .claude/board/round-1/grok.md
Cost reported by grok: $0.0133 — codex does not report cost
```

You act on the blocking items — accepting or declining each **with a reason** — and
convene the next round. Full transcripts land on disk; only this table goes into context.

## Why two vendors, not two prompts

A model reviewing its own output brings the same blind spots to the review that it brought
to the work. Running the same model twice with different prompts mostly produces the same
findings in different words.

Two models from different vendors disagree in ways that are *informative*. When both flag
the same line, it is almost certainly real. When one flags something the other missed,
that is exactly the case a single-model review would have dropped.

The disagreement is the product. Everything in this repo exists to turn that disagreement
into a decision instead of noise.

## Does it actually work?

When the implementation was finished, board was pointed at its own diff. Three rounds
found **11 real defects** — 9 raised by the reviewers, 2 by manual smoke testing — each
independently verified by hand before being fixed. Two of them mattered a great deal:

| # | defect | class |
|---|---|---|
| 5 | the brief omitted untracked new files, so a reviewer was judging a mutilated diff | **review invalidated** |
| 7 | untracked symlinks were followed, sending files from outside the repo to external CLIs | **security** |

Defect 5 is the instructive one. One reviewer *refused to judge* because it could not see
the module being imported. Had it been less careful, it would have returned an approve on
an incomplete diff and we would have believed the change was reviewed.

Extracting this repository for release turned up four more, including a doctor that
reported "all ready" while probing a different model than a real round would use.

**Then board was pointed at the extraction itself — four rounds, each reviewing the
previous round's fixes. It found 14 more, and every single round turned up real defects in
the repairs made after the last one.** 29 in total across everything, each verified by hand
before being accepted.

One of them proved itself during the very round that reported it: a reviewer spent a single
turn and returned a structurally valid but empty verdict —

```json
{"verdict":"request_changes","blocking":[],"one_line_summary":"placeholder"}
```

— which parsed cleanly and, because the blocking list was empty, was counted as an
**approve**. A reviewer that did no work had cast a vote in favour. The other reviewer
caught exactly this class of bug in the same round, in code it was reading rather than
running.

The fix generalises a rule that was already right in one direction: resolving a
contradiction must always move *toward caution*. "Declared approve but listed blocking
items" resolves to request_changes; "declared request_changes but listed nothing" is now a
parse_error rather than a pass.

Round 4 found that reviewer ids — which become artifact filenames — were never validated:
`../../../package` resolves clean out of the artifact directory, and codex writes its
verdict there via `-o`, so it would have overwritten `package.json` in the repository under
review.

The two reviewers turned out complementary in a way one model cannot be. One kept finding
real defects through every round, including in its own previous fixes. The other, in the
final round, correctly judged which leftovers were drift rather than bugs — which is what
let the process stop somewhere defensible instead of running forever.

The full list, with the reasoning behind each fix, is in [DESIGN.md](DESIGN.md) §13.

### Reviewing a plan beats reviewing code

The same flawed plan, measured under both prompts:

| | code mode | plan mode |
|---|---|---|
| codex blocking | 2 | **3** |
| grok blocking | 2 | 2 |
| extra finding | — | "the auth module returns a hardcoded free tier; the plan has no source of truth for subscription state" |
| cost | $0.0148 | $0.0390 |

The extra finding is not a bug — it is **a hole in the plan**. Code-review criteria (bug,
security, data loss) structurally cannot reach that class of problem. Being told the first
step will not work, before you build anything, saves the whole rewrite.

## Install

| Requirement | Notes |
|---|---|
| Node ≥ 20 | `node --test` and zero third-party dependencies |
| git | board builds its brief with git |
| [Claude Code](https://claude.com/claude-code) | this is a skill for it |
| [codex CLI](https://developers.openai.com/codex/cli) | reviewer 1 — install and log in |
| [grok CLI](https://grok.com) | reviewer 2 — install and log in |

```bash
git clone https://github.com/MazzaWill/code-agent-board.git
cd code-agent-board
sh install.sh          # symlinks this checkout to ~/.claude/skills/board
npm run doctor         # both reviewers must report ready
```

> **The skill directory must be named `board`,** even though the repository is
> `code-agent-board`. Both the `/board` command and the skill's frontmatter depend on that
> name. `install.sh` handles it; if you link it by hand, link it as `board`. The doctor
> warns you if you got this wrong.

Then **restart your Claude Code session** — an already-open session will not pick up a
newly installed skill.

Both CLIs have to end up on your `PATH`. grok installs to `~/.grok/bin` by default, which
not every shell picks up; if `npm run doctor` reports one as "not installed" while you are
sure it is there, that is a `PATH` problem, not a missing binary.

Budget about ten minutes, most of it logging into the two CLIs.

## Usage

```
/board
```

or just tell Claude "cross-review my changes", "get a second opinion on this from another
model", "review this plan before I build it".

A round takes **5–8 minutes** at `xhigh` reasoning effort for an ordinary change, with no
output until both reviewers finish. Large diffs take considerably longer — measured on
this repository's own 3,468-line extraction, codex needed **13m49s**, which is only 71
seconds short of the default 900-second timeout. Above ~2,000 lines board asks before
convening; if you regularly review changes that big, raise `timeoutMs` in the config.

Cost is roughly **$0.01–0.04 per round** as reported by grok; codex does not report cost,
so the real figure is higher.

This is worth it for substantial changes and real plans. It does not pay for typo fixes.

## Two modes

| Mode | Reviews | Flag |
|---|---|---|
| `code` (default) | uncommitted code changes | `--mode code`, or omit |
| `plan` | a technical plan / design document | `--mode plan` |

Plan mode needs the plan **written to a file** first — planning that lives only in a chat
session leaves nothing on disk for board to read.

A misspelled `--mode` exits with an error. It never falls back, because falling back fails
silently: reviewers handed a plan under the code prompt go looking for bugs in the
markdown, find none, approve — and you believe your plan passed review.

## How a meeting converges

Findings are split into `blocking` and `non_blocking`, and **only `blocking` counts as a
vote against**. This split is the entire convergence mechanism: without it, a reviewer
keen to look useful keeps picking at naming and formatting, and three rounds never produce
unanimous approval.

| Outcome | Meaning |
|---|---|
| `approved` | unanimous; the meeting adjourns |
| `changes_requested` | work the blocking items, then convene the next round |
| `inconclusive` | a reviewer failed — this round does not count and does not consume the budget |
| `all_failed` | every reviewer failed; stop and report |

**You are allowed to decline a blocking item, with a reason — and that permission is a
necessary condition for termination.** If every item had to be accepted, two reviewers
could deadlock you with contradictory demands (one says "extract a function", the other
says "inlining is clearer") and you would oscillate between them forever. Your reasons go
into the next round's brief, so the reviewers judge whether the problem was actually
resolved rather than repeating themselves.

Three rounds without agreement escalates: board writes up both sides' full reasoning
chains and hands the decision to you.

## It never silently passes

`unavailable`, `timeout` and `parse_error` never count as an approve vote. If one reviewer
dies, the round is `inconclusive` even if the other approved — in a two-reviewer setup one
missing vote means there was no cross-verification, which was the whole point.

This is the property most likely to be quietly wrong in a tool like this, so it is
asserted directly in the test suite rather than just documented.

## Reviewers hallucinate — verify before you act

Measured in practice: one reviewer cited a `user_models` table, a `storage_path` column and
an `/api/user` route. The repository contained four files. None of those existed.

The reasoning direction was right; the specifics were invented. Both prompts now require
that any identifier cited must be one the reviewer actually read — after which every
citation in the next measured run held up. **But do not assume compliance.** Verify any
blocking item's file, function or column before acting on it.

### And sometimes a reviewer does not review at all

Across three rounds of board reviewing this repository, one reviewer produced a real review
once and twice returned an answer it had not arrived at. Neither time did it fail: no
timeout, no error, no refusal.

- Round 1: `{"verdict":"request_changes","blocking":[],"one_line_summary":"placeholder"}` —
  schema-valid, and with an empty blocking list it was counted as an **approve**. Now
  rejected by verdict validation.
- Round 3: `"Need full context before judging. Reading the complete prompt now."` filed as
  a blocking item, complete with `file` and `why_it_matters`. **Structurally
  indistinguishable from a real finding**; no schema check can reach it.

The tells are cost and elapsed time: **$0.0054 and $0.0138 against $0.2047** for the round
it actually worked — a factor of 15 to 40. Neither number appears in the verdict, so board
now records elapsed time in every transcript header.

This is the concrete reason for the rule above: a human verifies before acting. It is also
why a failed reviewer never counts as an approve vote — but note that a *degraded* reviewer
is not a failed one, and nothing but your own judgement separates them.

## What leaves your machine

Your diff, plus the full contents of untracked files that are not gitignored, go to
OpenAI and xAI.

board does not put these into the brief: gitignored files, the targets of symlinks (never
followed), binaries, and files whose names look like secrets (`.env*`, key and keystore
extensions, ssh key names, anything containing `credentials` — the exact pattern lives in
[`scripts/brief.mjs`](scripts/brief.mjs) and [SECURITY.md](SECURITY.md) explains it).
Skipped files are listed as skipped rather than silently dropped, so the reviewers know
something is there.

**But "not in the brief" is not "unreachable".** The reviewers are agents with the
repository as their working directory, and the prompts encourage them to read files for
context. A file board declined to attach can still be opened by a reviewer itself. The
read-only sandbox prevents writes; it is not a confidentiality boundary. If a repository
holds credentials you cannot expose to these vendors, do not run board on it — see
[SECURITY.md](SECURITY.md).

Both reviewers run in their CLI's hard read-only sandbox and receive no credentials.
Their output is treated as data, never as instructions.

## Configuration

Everything lives in [`config/reviewers.json`](config/reviewers.json):

- **models** — `gpt-5.6-sol` and `grok-4.6` are pinned. If your account cannot use one,
  change it here; the doctor will tell you, by name, when this is the problem.
- **reasoning effort** — `xhigh`. If you lower it, lower `timeoutMs` with it (the note in
  the file explains why).
- **adding a third reviewer** — add an entry with its `args` and a `probe` block. The
  roster is validated before anything is spawned, so a bad one costs you nothing:
  - ids must be distinct (compared case-insensitively) and usable as a filename — they
    name the artifacts, and `../../../package` would resolve out of the artifact directory
  - the roster must span at least two **vendors**. A roster where every entry reaches the
    same provider is one model reviewing twice, not cross-verification. (A third entry
    from a vendor already present is fine — the check is on the roster as a whole.) Vendor
    defaults to the binary name, so set an explicit `vendor` field when two entries share
    a binary but reach different providers.
  - a CLI whose output shape differs from the two supported ones (bare JSON, or an
    envelope with `structuredOutput`) also needs a parser in `scripts/verdict.mjs`

`BOARD_HOME` tells the skill protocol where board is installed, for locations the probe in
SKILL.md would not find. It does **not** redirect which config a script reads — every
script resolves its own directory from `import.meta.url`. `--lang zh-CN` gets you reviews
in Chinese.

## Artifacts

Everything a round produced lands in `<your repo>/.claude/board/round-N/` — brief, prompt,
each reviewer's raw transcript, the parsed verdicts, and the summary.

board adds `.claude/board/` to `.git/info/exclude`, which is local-only. **Your project's
`.gitignore` is never modified.**

## What we measured about the two CLIs

These were found by calling the CLIs, not by reading their docs:

- **codex** writes a bare JSON object with `-o <file>`; **grok** writes an envelope to
  stdout with the verdict at `.structuredOutput`
- grok reports `total_cost_usd`; codex reports no cost at all
- grok's `-p` and `--prompt-file` are mutually exclusive
- codex's `--output-schema` enforces OpenAI strict validation — every object level needs
  `additionalProperties: false` and a complete `required` list. grok accepts that same
  strict schema, so both share one file.
- both CLIs auto-load the repository's `CLAUDE.md` / `AGENTS.md`, so your project
  conventions reach the reviewers for free

## Platform support

macOS and Linux are first-class and covered by CI (Node 20/22/24).

Windows is not supported yet: the doctor's PATH lookup is fixed, but SKILL.md's temp-file
handling and three tests still assume POSIX behaviour (symlinks, file modes). Use WSL.

## Development

```bash
npm test        # 116 tests, no npm install needed
npm run doctor
```

Zero third-party dependencies is a hard rule — that is why `npm test` works on a fresh
clone with no install step. The parsing, tallying and formatting logic is pure functions
precisely so it can be tested without ever calling a CLI; the suite costs nothing to run
and needs no API key.

Design reasoning: [DESIGN.md](DESIGN.md) · Security: [SECURITY.md](SECURITY.md) ·
Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) ·
Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Credits

The idea came from 刘小排's article《一个篱笆三个桩 一个AI五个帮》. The article supplied the
idea only — the protocol, configuration, convergence rules and every design decision here
were built from scratch.

## License

MIT
