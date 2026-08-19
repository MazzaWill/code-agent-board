# board — design notes for the multi-model cross-review "meeting"

Status: implemented. This document records the reasoning behind the implementation and
the potholes hit along the way. (中文版：`DESIGN.zh-CN.md`)

## 1. The problem

After a complex coding task, a single model reviewing its own work misses things. Hand
the change to frontier models from **different vendors**, let them pick at each other's
findings for a few rounds until nobody has a blocking objection, and the odds of rework
drop.

The idea came from an article by 刘小排,《一个篱笆三个桩 一个AI五个帮》. The article gave
the idea only — no implementation. The configuration, the commands and the convergence
rules here were all designed from scratch.

### Goals

- Manually convene a "meeting" that hands the current uncommitted change to codex and grok
- Multi-round debate: reviewers can see the previous round's disputes and your responses
- An explicit convergence rule: unanimous approval adjourns; three rounds without
  agreement escalates to the user
- Portable across machines: a standalone repository, symlinked into your skills directory

### Non-goals (deliberately not doing these)

- **No automatic triggering.** Manual by choice. The path to adding it is mapped out
  (§11), but this version does not.
- **Reviewers never edit code.** They are read-only; every change is made by the host session.
- **Not chasing reviewer count.** Two (codex + grok). Two different vendors is enough to
  produce the disagreement signal.

## 2. How it is triggered

The user types `/board`. Nothing automatic, no hooks.

## 3. Architecture

```
user types /board
   ↓
SKILL.md (the host protocol, which Claude reads and executes)
   ↓ writes only two temp files OUTSIDE the repo: intent, contested
   ↓
scripts/board-round.mjs (the meeting secretary)
   ↓ ① ensureIgnored — before anything is written
   ↓ ② buildBrief — git diff + full contents of untracked files + intent + contested
   ├─ spawn in parallel ─→ codex exec  (read-only sandbox, --output-schema)
   └─ spawn in parallel ─→ grok        (read-only sandbox, --prompt-file, --json-schema)
   ↓ collect two verdict JSONs + two full transcripts
   ↓ tally the votes, print one summary table to stdout
   ↓
Claude reads the table → changes code / declines with a reason → next round or adjourn
```

**Division of labour**: the scripts do the deterministic grunt work — round everyone up,
collect the minutes, count the votes. Judging *which objection is right* stays with
Claude; the script has no authority to decide what gets changed.

**The host never touches the repository.** Brief generation and the git ignore rule both
happen in code; the host supplies only `intent` and `contested`, two text files living
outside the repo. The reason is §13: any step that relies on an agent remembering will
eventually be skipped, and that was demonstrated three times in a row.

## 4. The reviewers

`config/reviewers.json`. Adding a reviewer means editing that file, not the flow code.

| id | command | read-only guarantee | structured output | prompt delivery |
|---|---|---|---|---|
| `codex` | `codex exec -m gpt-5.6-sol --ephemeral -s read-only -C <repo> -c model_reasoning_effort=xhigh --output-schema <schema> -o <out.json>` | hard sandbox `-s read-only` | `--output-schema` enforced | stdin |
| `grok` | `grok --prompt-file <f> --cwd <repo> --sandbox read-only -m grok-4.6 --reasoning-effort xhigh --output-format json --json-schema <inline>` | hard sandbox `--sandbox read-only` | `--json-schema` enforced | `--prompt-file` |

grok's `-p/--single` and `--prompt-file` are **mutually exclusive**; passing both yields
`a value is required for '--single' but none was supplied`. Using the file form means
dropping `-p`.

codex carries `--ephemeral` by default, so the session is not written into
`~/.codex/sessions/` — otherwise every round leaves roughly 1 MB of rollout behind and
`codex exec resume --last` starts pointing at a review session instead of your own last
piece of work. **If you use a tool that measures codex token usage**, remove that flag:
those tools work by scanning exactly those rollout files, so an ephemeral session is
invisible to them and its cost is never recorded.

Both CLIs automatically pick up the repository's `CLAUDE.md` / `AGENTS.md` as project
context (confirmed by measurement), so the reviewers get the project's conventions for
free and the prompt does not need to repeat them.

### The two output shapes (measured by calling them, not inferred from docs)

**The shapes differ; the parsers must be written separately:**

- **codex**: `-o <file>` writes the **bare schema object**, no envelope.
  ```json
  {"verdict":"approve","blocking":[],"non_blocking":[],"one_line_summary":"probe ok"}
  ```
- **grok**: stdout is an **envelope**; the verdict is at `.structuredOutput`, with `.text`
  (the same JSON as a string) and `.total_cost_usd` (the cost of this call, which can go
  straight into the summary table).
  ```json
  {"text":"{...}", "stopReason":"end_turn", "total_cost_usd":0.0133,
   "structuredOutput":{"verdict":"approve","blocking":[],...}}
  ```

### The schema must be written in OpenAI strict form

codex's `--output-schema` goes through OpenAI strict validation, and a lax schema is an
immediate HTTP 400:

> `Invalid schema for response_format 'codex_output_schema': In context=(), 'additionalProperties' is required to be supplied and to be false.`

So `verdict.schema.json` has to satisfy:

1. **Every object level** states `additionalProperties: false` explicitly
2. Each level's `required` lists **all** of that level's properties (strict mode does not
   allow omitting optional fields)
3. Optional fields are expressed as nullable unions, e.g. `"line": {"type": ["integer","null"]}`

grok accepts that same strict schema in practice (including the `["integer","null"]`
union), so **both reviewers share one schema file**.

## 5. The verdict protocol

The authoritative definition is `config/verdict.schema.json` (strict form, above). Field
semantics:

| field | meaning |
|---|---|
| `verdict` | `approve` / `request_changes` |
| `blocking[]` | `file` `line` `issue` `why_it_matters` `suggested_fix` |
| `non_blocking[]` | `file` `issue` |
| `one_line_summary` | one-sentence conclusion |

> Only the semantics are listed here, never a copy of the JSON. Duplicating a schema into
> the documentation just creates a second source of truth that is guaranteed to drift.
> `config/verdict.schema.json` is the one that counts.

**Only a non-empty `blocking` list counts as a vote against.** This is the crux of
convergence: without the split, reviewers keen to look useful will keep picking at naming
and formatting, and three rounds will never produce a unanimous approval.
`non_blocking` gives them somewhere to put it that does not block the road.

When the `verdict` field contradicts the length of `blocking` (declaring approve while
listing blocking items, say), **the list wins**, and the summary table flags that
reviewer as self-contradictory. Models occasionally fill in the wrong enum value, but
they do not invent concrete blocking entries out of nothing.

## 6. The main loop (convergence state machine)

Written into `SKILL.md`, which Claude follows:

```
round = 1
loop:
  1. write two files OUTSIDE the repository (never touching the repo):
     - intent    what this change is trying to do
     - contested from round 2 on: each blocking item + what you changed / why you declined
  2. node scripts/board-round.mjs --round N --intent <f> [--contested <f>]
     (the script does ensureIgnored → build the brief → convene in parallel)
  3. read the summary table on stdout
  4. everyone approves → write verdict.md, report, exit
  5. otherwise work through the blocking items:
       agree    → change the code; next round's contested says "changed per X"
       disagree → do not change it; next round's contested says "declined, because Y"
                  (**a reason is mandatory**)
  6. round++; round > 3 → escalate: stop, write verdict.md, put the disagreement to the user
```

**Step 5 allowing a reasoned refusal is a necessary condition for convergence.** If every
blocking item had to be accepted, two reviewers could deadlock the host with contradictory
demands (codex says "extract a function", grok says "inlining is clearer") and it would
oscillate between the two forever. Allowing refusal, plus letting the next round's
reviewers see the reasoning, is what makes the debate terminate.

### Output when three rounds do not converge

`verdict.md` must contain: the **full reasoning chain from both sides** for every
unresolved point (who said what in which round, your response, their rebuttal), the other
reviewer's position on that point, and **your own judgement and recommendation**. Give
the judgement, but hand the decision back to the user.

## 7. Layout on disk

### In this repository

```
code-agent-board/
├─ SKILL.md                    the host protocol → /board
├─ DESIGN.md                   this document (also DESIGN.zh-CN.md)
├─ README.md                   (also README.zh-CN.md)
├─ install.sh                  idempotent symlink into ~/.claude/skills/board
├─ scripts/
│  ├─ board-round.mjs          the secretary: orchestration, parallel calls, writing to disk
│  ├─ brief.mjs                assembles the brief (untracked files in, symlinks and secrets out)
│  ├─ git-artifacts.mjs        keeps the artifacts out of git
│  ├─ verdict.mjs              parses both output shapes
│  ├─ tally.mjs                vote counting and the round state machine
│  ├─ summary.mjs              summary-table formatting
│  ├─ modes.mjs                code / plan modes × language
│  ├─ reviewer-config.mjs     roster validation, shared by doctor and board-round
│  └─ board-doctor.mjs         environment self-check
├─ prompts/
│  ├─ code-reviewer.md         reviewing code (default, English)
│  ├─ plan-reviewer.md         reviewing a plan (--mode plan, English)
│  └─ *.zh-CN.md               Chinese versions, used with --lang zh-CN
├─ config/
│  ├─ reviewers.json
│  └─ verdict.schema.json
└─ test/                       116 tests, all of them under `npm test`
   ├─ brief.test.mjs           real git repositories (symlinks, huge files, renames, secrets)
   ├─ git-artifacts.test.mjs   real git repository + real linked worktree
   ├─ modes.test.mjs           (mode × language) matrix over every prompt invariant
   ├─ doctor.test.mjs          probe derivation, model parity, "unverifiable must fail"
   ├─ reviewer-config.test.mjs count, distinct ids, and at least two vendors
   ├─ args.test.mjs            strict flag parsing and repository preflight
   ├─ reviewer-lifecycle.test.mjs  a reviewer that exits with a grandchild holding the pipes
   ├─ verdict.test.mjs
   ├─ tally.test.mjs
   └─ summary.test.mjs
```

`.mjs` rather than bash: parsing, tallying and formatting are pure functions, so they run
directly under `node --test`. Written in bash, none of it would be testable. Zero
third-party dependencies is a hard rule — `npm test` needs no `npm install` first.

### Inside the repository under review (local artifacts, never committed)

```
<repo>/.claude/board/
├─ round-1/
│  ├─ brief.md
│  ├─ prompt.txt
│  ├─ codex.json  codex.md
│  ├─ grok.md
│  ├─ summary.md
│  └─ results.json
├─ round-2/  round-3/
└─ verdict.md
```

If `.claude` is not already gitignored, the script appends a rule to `.git/info/exclude`
(local-only, leaving the project's own `.gitignore` alone).

## 8. Summary table format

`board-round.mjs` prints to stdout:

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

Claude reads only this table (a few hundred tokens) and goes digging in a transcript only
when something looks off. Compared with putting two full transcripts into context, that
saves most of the cost, and over three rounds the gap is large.

The transcript paths are derived from the reviewers that actually ran, not hardcoded. The
cost line names who reported it, because codex does not report cost at all — presenting
one CLI's number as the round's total would be understating it silently.

## 9. Error handling

| failure | handling |
|---|---|
| CLI missing / not logged in | `board-doctor.mjs` catches it up front; mid-meeting it is recorded as `unavailable` |
| timeout (default 900s) | kill the process, record `timeout`. 900s is calibrated for xhigh; changing effort means changing this |
| output is not valid JSON | record `parse_error`, hand the raw text to Claude, never guess |
| `verdict` contradicts `blocking` | the list wins; the table flags it |
| diff > 2000 lines | warn and get confirmation before convening |
| no uncommitted changes / not a git repo | exit with the reason |

### Measured runtime behaviour on a large diff

Reviewing this repository's own 3,468-line extraction (a 233 KB brief) produced numbers
worth knowing before you point board at something big:

| | measured |
|---|---|
| codex, from spawn to verdict | **13 min 49 s** |
| grok, same brief | **12 s** — and it returned a placeholder verdict, having done no real work |
| headroom against `timeoutMs` (900 s) | **71 seconds** |

Three consequences:

1. **"5-8 minutes" holds for ordinary changes, not for this size.** A diff of a few
   hundred lines finishes in that window; a few thousand does not.
2. **`timeoutMs` is the real ceiling on diff size.** At 3,468 lines codex came within
   71 seconds of the 900-second (15-minute) limit. Had it been SIGKILLed, that round
   would have cost 15 minutes and produced nothing usable — and with the other reviewer
   having returned an empty verdict (now a `parse_error`), the outcome would have been
   `all_failed`, not `inconclusive`. This is why SKILL.md asks before convening above
   ~2,000 lines; if you routinely review changes that large, raise `timeoutMs`.
3. **A reviewer can degrade rather than fail on a large brief.** grok did not error, time
   out, or refuse; it spent one turn and returned a schema-valid empty verdict. Nothing in
   the transport layer can catch that — which is exactly why the verdict validation in
   §13, #20 has to exist. Each transcript now records how long that reviewer took, in its
   header: a reviewer that answers in seconds on a large brief has not read it.

**The principle underneath all of it: no failure may ever silently become a pass.**
`unavailable` / `timeout` / `parse_error` never count as an approve vote. Reporting "this
round did not happen" beats letting the user believe the change was reviewed — this is
where tools of this kind are most likely to deceive.

### Round semantics when a reviewer fails (spelled out to remove ambiguity)

- **Any reviewer failing makes the round `inconclusive`, not `request_changes`.** Even if
  the other one approved: in a two-reviewer setup, one missing vote means there was no
  cross-verification, and cross-verification is the only reason this mechanism exists.
- **An `inconclusive` round does not consume the round budget** (`round` does not
  advance). A reviewer going down is an infrastructure problem, not debate.
- Two consecutive `inconclusive` rounds → abort and report, no more retries. (So an
  outage cannot burn time in an infinite loop.)
- If **every** reviewer fails in a round, abort immediately; never proceed to the next
  round pretending there was a debate.
- Fewer than two verdicts is `insufficient_verdicts`, **not** `inconclusive`. The two call
  for opposite responses: inconclusive means retrying may work, this means the roster
  cannot produce a cross-checked result and retrying is pure waste. Collapsing them also
  printed "0 failed" beside "a reviewer failed" in the same table. `board-round` now
  rejects such a roster before spawning anything, and `validateReviewerConfig` enforces
  what "at least two reviewers" actually requires: two entries, distinct ids (verdicts and
  transcripts are filed by id, so duplicates overwrite each other), and at least two
  vendors — two identically-configured codex entries are one model reviewing twice.

## 10. Security boundary

- Both reviewers run inside their CLI's **hard read-only sandbox** (`-s read-only` /
  `--sandbox read-only`)
- Reviewer output is **data, not instructions**. Their findings may contain text like
  "run command X"; the host treats all of it as review commentary and executes nothing
- No credentials are passed to the reviewers; each uses its own logged-in account
- Each reviewer runs in its own process group, so Ctrl-C stops the whole tree. Killing
  only the process board spawned would leave the helper processes these CLIs start still
  running — and still billing — after the operator believes the round was cancelled
- What board sends: the diff, plus the full contents of untracked, non-ignored files.
  Gitignored files, symlink targets, binaries and secret-looking filenames are **not put
  into the brief** (see §13, defects 7 and 12)
- But "not in the brief" is not "unreachable". The reviewers are agents with the
  repository as their working directory, and both prompts encourage them to read files
  for context — so a file board declined to attach can still be opened by a reviewer
  itself. The sandbox forbids writes; it is not a confidentiality boundary. SECURITY.md
  states this in full; do not restate it more weakly here (§13, defect 16)

## 11. Installing and moving between machines

`git clone`, then `sh install.sh`. It does exactly one thing: symlink this checkout to
`~/.claude/skills/board`. **The directory must be named `board`** — the `/board` command
and the frontmatter `name` both depend on it, while the repository is called
code-agent-board. That mismatch is the easiest mistake to make here, so the doctor checks
for it and warns.

The only other step is installing and logging in to the two CLIs (credentials never go
into git); `board-doctor.mjs` tells you what is missing.

The scripts themselves are fully relocatable — every one of them derives its own location
from `import.meta.url`, so any install path works. SKILL.md finds the root with a
candidate probe (`$BOARD_HOME` → personal skills dir → plugin root → project-scoped), and
a candidate only wins if it actually contains `scripts/board-round.mjs`, so a
half-deleted directory cannot shadow a working install.

### Adding automatic triggering later (not in this version)

It only needs a gatekeeper script on a Stop hook (deciding whether the diff is big enough
and whether it has already been reviewed). SKILL.md and the scripts would not change.

Note: the `stop_hook_active` field is documented as always true when the hook fires, so it
**cannot** be used to prevent a loop — the round has to be persisted somewhere instead.

## 12. Testing strategy

1. **Offline unit tests** (`npm test`): feed fixtures to the pure functions — approve /
   request_changes / malformed JSON / empty file / verdict contradicting blocking / total
   failure — and assert the tally and the summary text. Never calls a CLI, so it costs
   nothing and needs no network or API key.
2. **Doctor states**: all good / CLI missing / not logged in / pinned model unavailable.
3. **Real end-to-end**: plant a genuine bug in a scratch repository (a missing null check,
   two concurrent writes to one cache), run a full `/board`, and see whether the reviewers
   catch it.

Item 3 is the only one that answers "is this thing actually useful". Run it as soon as the
implementation lands and report the result honestly — if codex and grok cannot find a bug
that was deliberately planted, the mechanism is wasting time and credits, and it is better
to know early.

## 13. Defects found by board reviewing itself

After the implementation was finished, board reviewed its own change. Three rounds turned
up **11 real defects**: 9 raised by codex or grok, and 2 more (rows 1 and 2) from manual
smoke testing. All were independently verified by hand before being fixed. They are
recorded here because they point at one lesson.

| # | defect | found by | class |
|---|---|---|---|
| 1 | `$&` / `` $` `` in a `String.replace` replacement are special patterns; the diff was silently rewritten | smoke test | data corruption |
| 2 | grok's `-p` and `--prompt-file` are mutually exclusive; passing both errors out | smoke test | misconfiguration |
| 3 | in a linked worktree, `--git-dir` locates `info/exclude` in the wrong place, with no error | codex | silent no-op |
| 4 | an unconditional append piles duplicate rules into exclude | grok | accumulating junk |
| 5 | the brief omitted untracked new files (`git diff HEAD` does not show them) | grok | **review invalidated** |
| 6 | the ignore rule was written after the brief, leaving an exposure window | codex | ordering |
| 7 | untracked symlinks were followed, putting files from outside the repo into the brief and sending them to external CLIs | codex | **security** |
| 8 | the 64 KiB truncation happened after reading the whole file into memory | codex | resource |
| 9 | `countChangedLines === 0` misread pure renames and mode changes as "no change" | codex | logic |
| 10 | missing intent/contested silently became an empty string, losing the debate context from round 2 on | codex | protocol breakage |
| 11 | `import('~/...')` in SKILL.md does not expand `~`; the command never ran | codex | documentation |

### The lesson

**Defects 5, 6 and 10 share a root cause: a safety or correctness step was written into
SKILL.md for an agent to carry out.** "Attach untracked new files in full" was written
down, and the agent did not do it. "Append a line to .git/info/exclude" was written down,
and the agent did not do it. Steps like these have to move into code, which is exactly why
`brief.mjs` and `git-artifacts.mjs` exist as modules.

**Defect 7 shows the read-only sandbox does not protect this direction.** The reviewers'
sandbox constrains the reviewers; the leak happened in the host process while assembling
the prompt. Anything destined for an external CLI needs its boundary check on the
assembly side.

**Defect 5 is the one worth staring at: it invalidated an entire review without raising
an error.** grok refused to judge because it could not see the module being imported — had
it been less careful, it would have returned an "approve" based on a mutilated diff, and
we would have believed the change was reviewed. That is precisely what §9's "no failure
may silently become a pass" is meant to prevent, but at the time the rule did not cover
the entrance case: *the input itself being incomplete*.

### Defects found later, while extracting this repository

Preparing the open-source release turned up four more, all of the same family and all
fixed here:

| # | defect | class |
|---|---|---|
| 12 | an untracked `.env` that is not in `.gitignore` had its full contents attached to the brief and sent to two vendors | **security** |
| 13 | the doctor's probe kept its own hand-written copy of each CLI invocation, so it probed the CLI's *default* model rather than the pinned one — an account without access to the pinned model got a green "all ready" and failed on the first meeting | **silent no-op** |
| 14 | a reviewer id the doctor did not recognise printed a warning but did not count as a failure, so the run still reported "all ready" and exited 0 | **silent pass** |
| 15 | the summary table hardcoded `{codex,grok}.md`, and the cost line summed only the reviewers that report cost while calling the result the round's cost | honesty |

Defect 13 is defect 3 all over again in a different costume: a second, hand-maintained
source of truth that drifts from the real one by construction. The fix was not to correct
the copy but to delete it — the probe now derives its arguments from `config/reviewers.json`
and refuses to run if it cannot prove it is probing the same model a real round would use.

Defect 14 is a direct violation of this project's own iron rule, sitting inside the tool
whose whole job is to catch exactly that.

### Then board reviewed the extraction itself

Before publishing, board was pointed at the extraction diff (3,468 lines). It raised
7 blocking items. **Six were real** and are fixed in this repository; one was an artifact
of the dogfood setup (the temporary baseline commit legitimately contained the private
version, which the reviewer read as "the history to be published").

| # | defect | class |
|---|---|---|
| 16 | the secret-filename filter kept files out of the brief, but the reviewers are agents with the repo as cwd and prompts that encourage reading files — "excluded from the brief" was documented as "not sent", which was too strong | **documentation / security** |
| 17 | the SENSITIVE pattern did not match `.envrc`, `secrets.env` or `secrets.txt`, while SECURITY.md promised `.env*` | **security** |
| 18 | `board-doctor.mjs` compared `process.argv[1]` with `import.meta.url` without resolving symlinks, so when reached through the `~/.claude/skills/board` symlink that `install.sh` creates, it checked nothing and exited 0 | **silent success** |
| 19 | the argument parser ignored unknown flags, so `--mdoe plan` silently reviewed a plan with the code prompt; a malformed `--round` also bypassed the contested requirement | **silent fallback** |
| 20 | a structurally valid but empty verdict became an approve vote | **silent pass** |
| 21 | SKILL.md told the agent not to rely on shell state surviving between commands, then used `$TMP` across commands with fixed filenames | protocol |

**Defect 20 proved itself during the very round that reported it.** One reviewer spent a
single turn and returned `{"verdict":"request_changes","blocking":[],"one_line_summary":"placeholder"}`.
That is schema-valid, so it parsed; and because the blocking list was empty,
`normalizeVerdict` resolved it to **approve**. A reviewer that did no work cast a vote in
favour. Had the other reviewer also approved, the round would have been reported as
unanimous.

The fix generalises the rule that was already right in one direction. Resolving a
contradiction must always move **toward caution**: "declared approve but listed blocking
items" resolves to request_changes (as before), while "declared request_changes but listed
nothing" is now a `parse_error` — unusable, not approval.

Defect 18 is the sharpest of the set: a diagnostic tool silently reporting success, inside
the project whose central promise is that nothing silently reports success. It was
introduced by this extraction (the direct-invocation guard exists so tests can import the
pure functions) and would have hit **every user who installed via `install.sh`**.

### Rounds 2 and 3: reviewing the fixes

Each round reviewed the previous round's fixes. Both found real defects in them.

**Round 2** (2 blocking). A single verdict counted as approval — configure one reviewer
and every round read `approved`, one model's opinion presented as though two vendors had
agreed. Nothing failed in that scenario, so no existing failure path caught it. And the
install-name check was wrong a second time: the fix keyed off the invocation path, which
helps only when the doctor is launched through the symlink, while README's `npm run doctor`
and install.sh's own printed command both run from the physical checkout.

Worse, **a test written for the first fix had defined a zero-reviewer config as success**,
entrenching the defect it was supposed to guard.

**Round 3** (3 blocking). All three were real:

| defect | why it mattered |
|---|---|
| the roster check only counted entries | two identically-configured codex entries passed it — one model reviewing twice, reported as cross-vendor agreement. Duplicate ids also overwrite each other's verdict and transcript, since both are filed by id |
| `insufficient_verdicts` was reported as `inconclusive` | they demand opposite responses. The summary printed "0 failed" beside "a reviewer failed", and the protocol's retry rule would have re-run an expensive review of a configuration that can never work |
| the doctor's install probe diverged from SKILL.md's | it omitted the git-toplevel candidate and ended in `basename(root) === 'board'`, which blesses any directory named board regardless of whether the agent can find it |

The install check took **three attempts**. The first two both answered a slightly wrong
question; only the third asks the one that matters — "is this checkout reachable as a skill
named board?" — by resolving the install targets rather than inspecting the entry point.

**Round 4** (1 approve, 3 blocking). All three were real, and all three were about the
validator added in round 3 failing to validate its own inputs:

| defect | why it mattered |
|---|---|
| `advanceState` did not know the new `insufficient_verdicts` outcome | it fell through to the `changes_requested` branch and returned `next_round` — turning "this roster can never work, stop and fix it" into a retry loop |
| vendor values were compared without normalization | `openai` and `OpenAI` counted as two vendors, so two identical reviewers passed the cross-vendor check and two approvals would have been reported as agreement |
| ids were checked for exact duplicates, then used as filenames | `../../../package` resolves clean out of the artifact directory, and codex writes its verdict there via `-o` — it would overwrite `package.json` in the repository under review. Ids differing only in case are also the same file on macOS |

This is where the dogfood stopped. Not because the reviewers ran out of findings — they
did not — but because the findings had changed character: rounds 1-3 turned up defects in
what the code *did*, round 4 turned up defects in what it *accepted as input*. Both are
worth fixing, and all of them were; but the second kind has no natural end, and the other
reviewer had by then approved the round, calling the remainder "spec/docs/test drift, not
a bug users will hit". Continuing would have been ritual rather than judgement.

### What the reviewers themselves did, across four rounds

Worth recording, because it is the strongest argument for the rules in §9 and §13:

| round | codex | grok |
|---|---|---|
| 1 (233 KB brief) | 13m49s, 7 blocking, 6 real | **12s, $0.0138 — returned a placeholder verdict** |
| 2 (20 KB brief) | 8m46s, 2 blocking, both real | ~10m, $0.2047, approve + 4 nits, one of which codex missed |
| 3 (27 KB brief) | 3 blocking, all real | **$0.0054 — filed "Need full context before judging. Reading the complete prompt now." as a blocking item** |
| 4 (31 KB brief) | 3 blocking, all real | $0.2162, approve + 3 nits — correctly identified which leftovers were drift rather than bugs |

Two things follow.

**One reviewer degraded in two rounds out of three, and never once failed.** No timeout, no
error, no refusal — just an answer that had not been arrived at. Round 1's was caught by
the verdict validation added in #20. Round 3's was not: "I need to read more first" arrives
with a file, an issue and a why_it_matters, so it is structurally indistinguishable from a
finding. Schema validation cannot reach that, and this is exactly why SKILL.md's iron rule
is that a human verifies before acting on any blocking item.

**The cost figures are the tell.** $0.0054 and $0.0138 against $0.2047 for the round where
that reviewer actually worked — a factor of 15 to 40. Together with the elapsed time now
recorded in each transcript, that is the cheapest available signal that a reviewer did not
read the brief. Neither number appears in the verdict itself.

A third form turned up while verifying the backport, and it differs from the first two in
the way that matters: **cost and elapsed time were both normal.** grok ran for 269.8s and
spent $0.07 — it did the work — then returned `stopReason: "cancelled"` with
`structuredOutput: null`, self-reporting `structuredOutputError: "model did not produce
structured output"`, while `.text` held **two concatenated JSON objects** (the first ended
at character 540).

So "watch the cost and the elapsed time" is not a complete tell — it catches a reviewer
that did no work, not one that worked and failed to produce structured output. What
actually caught this was the parsing layer: `parse_error`, therefore `inconclusive`, with
no guessing and no half-verdict counted as a vote. The error message now carries
`structuredOutputError` and `stopReason` through, so the diagnosis no longer requires
opening the transcript.


**The other reviewer found real defects in all four rounds**, including in every previous
round's fixes. Fourteen in total across the four rounds, every one verified by hand before
being accepted.

Cross-vendor review never converged on a unanimous approval here. But it never once
produced a false pass either — and the two reviewers were complementary in a way a single
model could not be: one kept finding real defects, the other correctly judged, in the final
round, which leftovers were drift rather than bugs. That judgement is what let the process
stop somewhere defensible instead of running forever.

## 14. Plan review mode

`--mode plan` swaps in `prompts/plan-reviewer.md`. Prerequisite: the plan has to be
written to a file first, since planning that lives only in a session leaves nothing on disk.

### Why it deserves its own prompt

The same flawed plan, measured under both prompts:

| | code mode | plan mode |
|---|---|---|
| codex blocking | 2 | **3** |
| grok blocking | 2 | 2 |
| extra finding | — | "the auth module returns a hardcoded free tier; the plan has no source of truth for subscription state" |
| citation accuracy | grok invented four identifiers | all real |
| cost | $0.0148 | $0.0390 |

The extra finding in plan mode is a textbook plan-level problem: not a bug, but **a gap in
the plan** — where the data for deciding subscription state comes from was never defined.
Code mode's criteria (bug / security / data loss) structurally cannot reach that.

### The "citations must be real" constraint works

In the code-mode run, grok cited four identifiers that did not exist anywhere in the
repository — which contained four files in total. The reasoning direction was right; the
specifics were invented. After both prompts gained "any filename, function, table or
column you cite must be one you actually read; say so if you cannot confirm it", every
citation in the plan-mode run **held up to checking**.

But **do not count on 100% compliance** — SKILL.md keeps the iron rule that you verify
before accepting any blocking item.

### A misspelled mode must fail loudly

`resolveMode` returns `ok:false` for an unknown mode and the script exits 2. It **never**
falls back to the default. Reviewing a plan with the code prompt fails silently: the
reviewers go hunting for "bugs in this markdown" and very likely approve — because the
markdown genuinely has no bugs — and the user walks away believing the plan passed review.

The same applies to `--lang`.
