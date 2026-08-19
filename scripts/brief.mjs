// Builds the review brief.
//
// Why the script assembles this instead of the host agent writing it by hand: during a
// self-review, a hand-written brief omitted the two most important files of the change
// (a new module and its tests). `git diff HEAD` does not show untracked files, and the
// instruction "attach untracked files in full" relied on the agent remembering to do
// it — so it did not happen. One reviewer refused to judge at all because it could not
// see the module being imported. It was right to refuse.
//
// Any step that depends on an agent remembering will eventually be skipped. Move it
// into code.

import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

// Attaching binaries is pointless and blows up the prompt. Extension matching is enough
// — real sniffing means reading file headers, not worth a dependency here.
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|svgz|pdf|zip|gz|tgz|bz2|xz|7z|mp[34]|mov|avi|webm|woff2?|ttf|otf|eot|wasm|so|dylib|dll|exe|bin|db|sqlite3?)$/i;

// Files whose *contents* must never leave the machine, even though git happily reports
// them as untracked.
//
// The brief is sent to two third-party CLIs. A `.env` that is untracked AND absent from
// .gitignore would otherwise be attached in full — same class of leak as following an
// untracked symlink out of the repository, which this module already refuses to do.
// These are skipped VISIBLY: a silent omission would leave the reviewers reasoning
// about a file they cannot see without anyone knowing.
//
// The pattern must stay in step with what SECURITY.md promises. It once claimed `.env*`
// while the regex only matched `.env` and `.env.<something>` — missing `.envrc`,
// `secrets.env` and `secrets.txt` entirely. Over-matching here is cheap (the skip is
// visible and the reviewer can still ask about the file); under-matching ships a secret
// to two vendors.
// Match anywhere within the final path segment, not just at its start. Anchoring each
// alternative to the beginning of the segment let the most common real-world spellings
// through: prod.env and staging.env (docker --env-file, dotenv-per-stage), and
// app-secrets.json / k8s-secrets.yaml. Verified before the fix: a brief carried
// "DB_PASSWORD=hunter2" from prod.env five lines below .env's "contents withheld".
const SENSITIVE = new RegExp(
  '(^|/)(' +
    '\\.env[^/]*' + '|' +                       // .env, .env.local, .envrc
    '[^/]*\\.env(\\.[^/]*)?' + '|' +             // prod.env, db.env, staging.env.bak
    '[^/]*secrets?([._-][^/]*)?' + '|' +        // secrets.txt, app-secrets.json, k8s-secrets.yaml
    '[^/]*credentials[^/]*' + '|' +
    '[^/]*\\.(pem|key|p12|pfx|jks|keystore)' + '|' +
    'id_(rsa|dsa|ecdsa|ed25519)[^/]*' + '|' +
    '\\.netrc|\\.npmrc|\\.pgpass' +
  ')$',
  'i',
);

// A directory called secrets/ or .secrets/ anywhere in the path makes everything under it
// sensitive, however the leaf file happens to be named.
const SENSITIVE_DIR = /(^|\/)\.?secrets?\//i;

function looksSensitive(rel) {
  return SENSITIVE.test(rel) || SENSITIVE_DIR.test(rel);
}

// Cap on a single untracked file's contents. Beyond this we attach the head and say so,
// so one accidentally-present log file cannot push the whole brief out of the
// reviewers' context window.
const MAX_UNTRACKED_BYTES = 64 * 1024;

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

export function listUntracked(repo) {
  // -z and NUL splitting, because filenames may contain spaces or even newlines;
  // splitting on lines would split them wrong.
  return git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
}

// Read only the first maxBytes, without pulling the whole file into memory.
//
// An earlier version read the file entirely and then sliced to 64 KiB — the "truncation"
// happened after memory had already blown up, which is no protection at all. A
// several-hundred-MB untracked log would hit ERR_STRING_TOO_LONG or kill the process.
function readHead(abs, maxBytes) {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// Regular files only.
//
// Critical security boundary: symlinks must be skipped, never followed. An untracked
// `notes.txt -> ~/.ssh/id_rsa` would write a private key from outside the repository
// into the brief — and the brief goes to two external CLIs. The reviewers' read-only
// sandbox cannot stop this; the leak happens in this process while assembling the
// prompt. Hence lstat, not stat.
function regularFileSize(abs) {
  const st = lstatSync(abs); // does not follow symlinks
  if (!st.isFile()) return null;
  return st.size;
}

export function readUntrackedFile(repo, rel) {
  if (looksSensitive(rel)) return { rel, skipped: 'looks like a secret — contents withheld' };
  if (BINARY.test(rel)) return { rel, skipped: 'binary file, contents not attached' };

  const abs = join(repo, rel);
  let size;
  try {
    size = regularFileSize(abs);
  } catch {
    return { rel, skipped: 'could not read (may have been deleted)' };
  }
  if (size === null) return { rel, skipped: 'not a regular file (symlink/device/pipe), contents not attached' };

  try {
    const content = readHead(abs, MAX_UNTRACKED_BYTES);
    if (size > MAX_UNTRACKED_BYTES) {
      return { rel, content, truncated: `file is ${size} bytes; only the first ${MAX_UNTRACKED_BYTES} are attached` };
    }
    return { rel, content };
  } catch {
    return { rel, skipped: 'could not read' };
  }
}

// Whether the working tree has changes.
//
// "countChangedLines === 0" is not a substitute: pure renames, file-mode changes and
// binary edits can all produce a numstat of 0 or "-", so legitimate changes would be
// misread as "nothing to review" and the meeting refused.
export function isDirty(repo) {
  const r = spawnSync('git', ['-C', repo, 'diff', '--quiet', 'HEAD']);
  if (r.status === 1) return true; // 1 = differs; 0 = identical; >1 = error
  if (r.status !== 0) throw new Error(`git diff --quiet failed: ${(r.stderr || '').toString().trim()}`);
  return listUntracked(repo).length > 0;
}

// Size of the change, used only for the "this is a big diff" threshold — never to
// decide whether there is anything to review.
export function countChangedLines(repo) {
  let lines = 0;
  for (const row of git(repo, ['diff', 'HEAD', '--numstat']).split('\n')) {
    if (!row.trim()) continue;
    const [add, del] = row.split('\t');
    lines += (Number(add) || 0) + (Number(del) || 0); // binaries show "-", Number → NaN → 0
  }
  for (const rel of listUntracked(repo)) {
    if (BINARY.test(rel)) continue;
    const f = readUntrackedFile(repo, rel);
    if (f.content) lines += f.content.split('\n').length;
  }
  return lines;
}

// One call for everything the host agent needs before deciding whether to convene.
// Exposed as `board-round.mjs --stat` so the protocol never needs an inline `node -e`.
export function repoStat(repo) {
  return { dirty: isDirty(repo), changedLines: countChangedLines(repo) };
}

// Section headings stay English in every language: the JSON schema field names are
// already English, so the machine-readable contract is language-neutral and only the
// free text varies. One less axis to keep in sync.
export function buildBrief(repo, { intent = '', contested = '' } = {}) {
  const out = [];

  out.push('## Intent of this change');
  out.push(intent.trim() || '(the host did not supply an intent)');
  out.push('');

  out.push('## Changed files');
  out.push('```');
  out.push(git(repo, ['diff', 'HEAD', '--stat']).trimEnd() || '(no changes to tracked files)');
  const untracked = listUntracked(repo);
  if (untracked.length > 0) {
    out.push('');
    out.push(`${untracked.length} untracked new file(s):`);
    for (const rel of untracked) out.push(`  ${rel}`);
  }
  out.push('```');
  out.push('');

  out.push('## diff (tracked files)');
  out.push('```diff');
  out.push(git(repo, ['diff', 'HEAD']).trimEnd() || '(none)');
  out.push('```');
  out.push('');

  // This section is the reason this module exists. `git diff HEAD` cannot see these
  // files at all, and a newly added module is often the very core of the change.
  if (untracked.length > 0) {
    out.push('## Untracked new files (full contents)');
    out.push('');
    out.push('These files are new in this change. `git diff` does not show them, so their full contents follow.');
    out.push('');
    for (const rel of untracked) {
      const f = readUntrackedFile(repo, rel);
      out.push(`### ${rel}`);
      if (f.skipped) {
        out.push(`(${f.skipped})`);
      } else {
        if (f.truncated) out.push(`(${f.truncated})`);
        out.push('```');
        out.push(f.content.trimEnd());
        out.push('```');
      }
      out.push('');
    }
  }

  if (contested.trim()) {
    out.push('## Contested points from the previous round');
    out.push('');
    out.push(contested.trim());
    out.push('');
  }

  return `${out.join('\n')}\n`;
}
