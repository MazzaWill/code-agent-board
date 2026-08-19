// Keep review artifacts out of git's sight.
//
// This started life as a pre-flight step in the protocol, relying on the host agent to
// remember it — and the very first manual smoke test skipped it. A safety step that
// depends on an agent remembering is not a safety step, so it moved into code.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PROBE = '.claude/board/x';
const PATTERN = '.claude/board/';
const ENTRY = `\n# board review artifacts (local-only ignore; your .gitignore is left alone)\n${PATTERN}\n`;

function isIgnored(repo) {
  return spawnSync('git', ['-C', repo, 'check-ignore', '-q', PROBE]).status === 0;
}

export function ensureIgnored(repo) {
  // Ask git check-ignore rather than grepping .gitignore: it is the authoritative
  // answer and covers all three sources at once — the project .gitignore, the global
  // core.excludesFile, and .git/info/exclude.
  if (isIgnored(repo)) return { ok: true, action: 'already-ignored' };

  // Must use --git-path, never --git-dir.
  // In a linked worktree --git-dir points at .git/worktrees/<name>, but git actually
  // reads info/exclude from the common dir. Writing to the former has no effect and
  // reports no error: the script would claim success and carry on while the artifacts
  // stayed visible in git status.
  const p = spawnSync('git', ['-C', repo, 'rev-parse', '--git-path', 'info/exclude'], {
    encoding: 'utf8',
  });
  if (p.status !== 0) return { ok: false, action: 'not-a-git-repo' };

  const excludePath = resolve(repo, p.stdout.trim());
  mkdirSync(dirname(excludePath), { recursive: true });

  // Check for an existing entry before appending. If check-ignore keeps failing for
  // some unrelated reason (permissions, a corrupt exclude file), an unconditional
  // append would pile up duplicate rules.
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  if (!existing.split('\n').some((l) => l.trim() === PATTERN)) {
    appendFileSync(excludePath, ENTRY);
  }

  // Re-check after writing. "claimed success but had no effect" is exactly how the
  // previous version of this function failed; without the re-check it would recur.
  if (!isIgnored(repo)) return { ok: false, action: 'write-had-no-effect', excludePath };
  return { ok: true, action: 'added-to-git-info-exclude', excludePath };
}
