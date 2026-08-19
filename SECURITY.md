# Security

## What board sends to third parties

board's entire job is to hand your code to two external CLIs. Be deliberate about what
that means.

**Sent** to OpenAI (codex) and xAI (grok), every round:

- `git diff HEAD` of the repository under review
- the **full contents** of untracked files that are not gitignored
- your intent text and, from round 2 on, your contested notes

**Not put into the brief by board:**

| Excluded from the brief | How |
|---|---|
| gitignored files | `git ls-files --others --exclude-standard` never lists them |
| symlink targets | `lstat`, never `stat` — symlinks are skipped, never followed |
| binaries | matched by extension and listed by name only |
| secret-looking filenames | see below |
| anything past 64 KiB of a single untracked file | read with a bounded `read()`, never a full slurp |

The secret-filename patterns cover, in outline: `.env*` (including `.envrc`), `.netrc`,
`.npmrc`, `.pgpass`, anything starting `secret` / `secrets`, private-key and keystore
extensions (`.pem` `.key` `.p12` `.pfx` `.jks` `.keystore`), ssh private key names
(`id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`), and anything containing `credentials`.

**The authoritative definition is the `SENSITIVE` pattern in
[`scripts/brief.mjs`](scripts/brief.mjs)** — the paragraph above paraphrases it, and a
paraphrase is exactly the kind of second source of truth that drifts. It already did once:
an earlier version of this page promised `.env*` while the pattern matched only `.env` and
`.env.<something>`, so `.envrc` and `secrets.txt` were being sent in full. If you need
certainty about a specific filename, read the pattern, or check that the file appears as
skipped in `<repo>/.claude/board/round-N/brief.md` after a round.

Every exclusion is **visible**: the file is listed in the brief with the reason it was
skipped. A silent omission would leave the reviewers reasoning about something they cannot
see, without anyone noticing — which is how a review gets quietly invalidated.

### Excluded from the brief is not the same as unreachable

**This is the most important limitation on this page.** The reviewers are agents, not
text summarizers. They run with the repository as their working directory, and both
prompts actively encourage them to grep and read files to establish context — that is
what makes their findings good.

So a file board declined to attach can still be opened by a reviewer on its own
initiative, and its contents can still end up in that reviewer's context and therefore
with its vendor. The read-only sandbox stops **writes**; it is not a confidentiality
boundary.

What the exclusions above actually buy you: board never *hands over* a secret unprompted,
and the reviewers have no reason to go looking at a file the brief told them was skipped.
What they do not buy you: a guarantee.

If a repository contains credentials you cannot afford to expose to OpenAI or xAI, do not
run board on it. Gitignoring them helps (they will not be listed at all), but the only
real boundary is not pointing an external agent at the repository in the first place.

(Found by board reviewing its own extraction — the first version of this page claimed
these files "are not sent", which was too strong.)

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
