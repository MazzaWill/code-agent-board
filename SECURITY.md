# Security

## What board sends to third parties

board's entire job is to hand your code to two external CLIs. Be deliberate about what
that means.

**Sent** to OpenAI (codex) and xAI (grok), every round:

- `git diff HEAD` of the repository under review
- the **full contents** of untracked files that are not gitignored
- your intent text and, from round 2 on, your contested notes

**Not sent:**

| Excluded | How |
|---|---|
| gitignored files | `git ls-files --others --exclude-standard` never lists them |
| symlink targets | `lstat`, never `stat` — symlinks are skipped, never followed |
| binaries | matched by extension and listed by name only |
| secret-looking filenames | `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `*credentials*`, `secrets.*`, `.netrc`, `.npmrc` |
| anything past 64 KiB of a single untracked file | read with a bounded `read()`, never a full slurp |

Every exclusion is **visible**: the file is listed in the brief with the reason it was
skipped. A silent omission would leave the reviewers reasoning about something they cannot
see, without anyone noticing — which is how a review gets quietly invalidated.

## The two limits worth understanding

**1. The reviewers' sandbox does not protect the direction you might assume.** Both CLIs
run under a hard read-only sandbox (`-s read-only` / `--sandbox read-only`), which
constrains *them*. But data leaves your machine while the **host** process assembles the
prompt — long before any sandbox is involved. That is why the boundary checks live in
`scripts/brief.mjs`, on the assembly side. This was a real defect (DESIGN.md §13, #7): an
untracked symlink pointing at `~/.ssh/id_rsa` put a private key into the brief.

**2. Filename heuristics are heuristics.** A secret in a file named `config.json` is
attached like any other file. If your repository keeps credentials in untracked files,
gitignore them — that is the only exclusion here that is authoritative rather than
best-effort.

## Prompt injection

Reviewer output is treated as **data, never instructions**. If a reviewer returns text
like "run the following command", the protocol requires the host to treat it as review
commentary and execute nothing. Reviewers also never edit code; every change is made by
the host session.

Note that reviewer output is derived from your repository's contents, which may include
text an attacker planted. The same rule covers that case: findings are read, not obeyed.

## Credentials

board passes no credentials to anything. Each CLI authenticates with its own already
logged-in account, and board never reads, stores, or forwards those tokens.

## Artifacts on disk

Review artifacts are written to `<repo>/.claude/board/` and excluded through
`.git/info/exclude`, which is local to your clone. This means:

- your project's `.gitignore` is never modified
- **the exclusion does not travel with the repository** — a collaborator who runs board
  gets their own local rule, which is correct, but if you copy the directory somewhere
  else by hand the artifacts are no longer excluded

Transcripts contain your full diff. Treat `.claude/board/` as sensitive as the code itself.

## Reporting a vulnerability

Open a GitHub issue for anything low-risk. For something you would rather not post
publicly, use GitHub's private vulnerability reporting on this repository.
