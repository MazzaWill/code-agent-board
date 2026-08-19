# Contributing

## Ground rules

**Zero third-party dependencies.** This is not a preference. `npm test` must work on a
fresh clone with no install step, and the skill must run wherever Node runs. A PR that
adds a dependency needs to argue why the alternative is impossible.

**Nothing unverifiable may ever report success.** This is the project's central promise.
If you add a code path that can fail, make sure the failure cannot be mistaken for a pass
— and assert that in a test. Several existing tests exist purely to pin this down
(`tally.test.mjs`, `doctor.test.mjs`).

**Steps that rely on an agent remembering will be skipped.** Three of the eleven defects
in DESIGN.md §13 share this root cause. If a step is required for safety or correctness,
it belongs in code, not in prose in SKILL.md.

## Getting set up

```bash
git clone https://github.com/MazzaWill/code-agent-board.git
cd code-agent-board
sh install.sh
npm run doctor
npm test
```

## Before you open a PR

```bash
npm test
```

The suite is offline: it never calls codex or grok, needs no API key and costs nothing.
If your change touches a user-visible string, update its assertion in the same commit —
several strings are asserted by name, and splitting them across commits produces a red CI
run for a reason unrelated to your change.

**Run board on your own diff.** This project reviews itself; that is the whole point, and
it found 11 real defects doing so. If board raises a blocking item you disagree with,
decline it *with a reason* — that is a legitimate outcome, and worth mentioning in the PR.

## Adding a reviewer

Editing `config/reviewers.json` is enough when the CLI:

1. can be constrained to read-only,
2. can be forced into a JSON schema, and
3. emits either a bare JSON object or an envelope with `structuredOutput`.

Add an entry with its `args` and a `probe` block (the doctor derives its connectivity
probe from `args` using those rules — see `_probeNote` in the config).

If the output shape differs from those two, you also need a parser in
`scripts/verdict.mjs`. Say so in the PR; the README's "config-only" claim should stay
honest.

## Translations

`README.md` and `DESIGN.md` are normative; the `.zh-CN.md` copies may lag. When you change
one, note in the PR whether the other needs updating — a stale translation is better than
a wrong one, but a tracked one is better than both.

## A note on the two copies of this skill

This repository is the public home of a skill that also lives in the author's private
setup. The intent is for the public repository to become the single source, with any local
configuration kept as an untracked override of `config/reviewers.json`. If you notice the
two drifting in a way that affects contributors, please open an issue.
