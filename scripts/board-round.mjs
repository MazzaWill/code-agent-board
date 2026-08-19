#!/usr/bin/env node
// The meeting secretary: spawns every reviewer concurrently, collects the minutes,
// tallies the votes, prints the summary table.
//
// Why concurrent rather than sequential: each CLI takes 30-90s at high effort (5-8 min
// at xhigh), so serial means a round costs the sum. Concurrent, a round costs the
// slowest reviewer.
//
// Why the prompt does not go through argv: a diff is easily hundreds of lines and would
// blow past ARG_MAX. codex reads from stdin (the trailing `-`), grok has --prompt-file.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBrief, isDirty, repoStat } from './brief.mjs';
import { ensureIgnored } from './git-artifacts.mjs';
import { resolveMode } from './modes.mjs';
import { validateReviewerConfig } from './reviewer-config.mjs';
import { normalizeVerdict, parseCodexOutput, parseGrokOutput } from './verdict.mjs';
import { formatSummary } from './summary.mjs';
import { tallyRound } from './tally.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PARSERS = { stdout: parseGrokOutput, file: parseCodexOutput };

// Strict argument parsing. The lenient version silently ignored anything it did not
// recognise, so `--mdoe plan` reviewed a plan with the code prompt and very likely
// approved it — the exact silent-fallback failure that resolveMode refuses to allow one
// layer down. A typo in a flag NAME has to fail as loudly as a typo in its value.
const VALUE_FLAGS = new Set(['repo', 'round', 'mode', 'intent', 'contested', 'lang', 'config']);
const BOOL_FLAGS = new Set(['stat']);

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) {
      return { ok: false, reason: `unexpected argument "${tok}" (every option must start with --)` };
    }
    const name = tok.slice(2);

    if (name in out) return { ok: false, reason: `--${name} was given more than once` };

    if (BOOL_FLAGS.has(name)) {
      out[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      const known = [...VALUE_FLAGS, ...BOOL_FLAGS].map((f) => `--${f}`).join(' ');
      return { ok: false, reason: `unknown option "--${name}". Known options: ${known}` };
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, reason: `--${name} requires a value` };
    }
    out[name] = value;
    i++;
  }

  if (out.round !== undefined && !/^[1-9][0-9]*$/.test(out.round)) {
    return { ok: false, reason: `--round must be a positive integer, got "${out.round}"` };
  }

  return { ok: true, args: out };
}

// Populated by main(). Parsing at module scope would run against whatever argv the
// importer happens to have — a test runner's, for instance — and exit the process.
let ARGS = {};

function arg(name, fallback) {
  return ARGS[name] ?? fallback;
}

function has(name) {
  return ARGS[name] === true;
}

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

// Always use the function form of replace, never the string form.
// In a replacement string `$&`, `$'`, `` $` `` and `$1` are all special patterns, and
// those characters appear in diffs perfectly normally (shell scripts, regexes, jQuery).
// With the string form the prompt gets silently rewritten — the reviewers see a diff
// that differs from the real one, and nothing errors.
function inject(template, token, value) {
  return template.replaceAll(token, () => value);
}

function runReviewer(rv, ctx) {
  const args = rv.args.map((a) => {
    let s = a;
    s = inject(s, '{repo}', ctx.repo);
    s = inject(s, '{schema}', ctx.schemaPath);
    s = inject(s, '{schemaInline}', ctx.schemaInline);
    s = inject(s, '{outFile}', ctx.outFile(rv.id));
    s = inject(s, '{promptFile}', ctx.promptFile);
    return s;
  });

  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Every exit path writes a transcript, including this one. The summary table
    // advertises a transcript path per reviewer; a path that does not exist would send
    // the reader looking for a file that was never written.
    //
    // The elapsed time is part of the record because it is diagnostic: a reviewer that
    // answers a large brief in seconds has not read it. That failure mode was measured
    // here (§13, #20) and nothing in the output itself reveals it.
    const started = Date.now();
    const writeTranscript = () =>
      writeFileSync(
        ctx.transcript(rv.id),
        `# ${rv.label}\n\nElapsed: ${((Date.now() - started) / 1000).toFixed(1)}s\n` +
          `\n## stdout\n\n${stdout}\n\n## stderr\n\n${stderr}\n`,
      );

    const child = spawn(rv.bin, args, { cwd: ctx.repo });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ctx.timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    let settled = false;
    let graceTimer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);

      // Tear the pipes down explicitly. A grandchild still holding their write ends keeps
      // our read ends alive as active handles, so without this the whole board-round
      // process sits there after every reviewer has finished and the summary has printed —
      // the round is done, the shell just never gets its prompt back.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();

      writeTranscript();
      done(result);
    };

    const conclude = (code) => {
      if (timedOut) {
        return settle({
          id: rv.id, label: rv.label, status: 'timeout',
          reason: `exceeded ${ctx.timeoutMs / 1000}s`,
        });
      }
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join(' ');
        return settle({
          id: rv.id, label: rv.label, status: 'unavailable',
          reason: `exit code ${code}: ${tail}`,
        });
      }

      const raw = rv.outputVia === 'file'
        ? (existsSync(ctx.outFile(rv.id)) ? readFileSync(ctx.outFile(rv.id), 'utf8') : '')
        : stdout;

      const parsed = PARSERS[rv.outputVia](raw);
      if (parsed.status !== 'ok') {
        return settle({ id: rv.id, label: rv.label, status: 'parse_error', reason: parsed.reason });
      }
      settle({
        id: rv.id, label: rv.label, status: 'ok', costUsd: parsed.costUsd,
        ...normalizeVerdict(parsed.data),
      });
    };

    child.on('error', (e) => {
      stderr += `\n[spawn error] ${e.message}\n`;
      settle({
        id: rv.id, label: rv.label, status: 'unavailable',
        reason: `${rv.bin} could not start: ${e.message}`,
      });
    });

    // Listen to BOTH exit and close, and let whichever arrives first win.
    //
    // `close` alone is a hang waiting to happen: it fires only once every stdio stream is
    // closed, and a grandchild that inherited them keeps them open after the reviewer
    // itself has exited. Both reviewer CLIs are agentic and routinely start helper
    // processes, so a reviewer that answered in 30 seconds would leave the round waiting
    // out the full timeout and then be recorded as a timeout — a real answer thrown away
    // and 15 minutes lost. Verified: with a child that exits while a grandchild holds the
    // pipes, `exit` fires immediately and `close` never arrives.
    //
    // `exit` alone would be wrong in the opposite direction: it can arrive before the last
    // chunks of stdout have been read, truncating the verdict. So exit starts a short
    // grace period for the streams to drain, and close settles immediately when it comes.
    const STDIO_GRACE_MS = 5000;
    child.on('exit', (code) => {
      graceTimer = setTimeout(() => conclude(code), STDIO_GRACE_MS);
    });
    child.on('close', (code) => conclude(code));

    if (rv.promptVia === 'stdin') {
      child.stdin.write(ctx.prompt);
      child.stdin.end();
    }
  });
}

// Fail with an explanation, not with git's raw stderr wrapped in "board-round crashed".
// Every one of these produced a stack-shaped message that reads like a bug in board, and
// the last is a perfectly ordinary situation: someone runs `git init`, writes some code,
// and wants it reviewed before the first commit exists.
function assertReviewable(repo) {
  if (!existsSync(repo)) {
    die(`--repo path does not exist: ${repo}`);
  }
  if (spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel']).status !== 0) {
    die(`${repo} is not a git repository — board builds its brief from git diff`);
  }
  if (spawnSync('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD']).status !== 0) {
    die(
      `${repo} has no commits yet — board diffs against HEAD, so make at least one commit first ` +
        '(an empty one is fine: git commit --allow-empty -m "start")',
    );
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) die(parsed.reason);
  ARGS = parsed.args;

  const repo = resolve(arg('repo', process.cwd()));
  assertReviewable(repo);

  // --stat answers "how big is this change?" without convening anyone. It exists so the
  // protocol never has to run an inline `node -e` with a hardcoded import path.
  if (has('stat')) {
    process.stdout.write(`${JSON.stringify(repoStat(repo))}\n`);
    return;
  }

  const round = Number(arg('round', '1'));

  // Validate mode and language first: a typo must fail loudly, never silently review a
  // plan with the code prompt.
  const selected = resolveMode(arg('mode', null), arg('lang', null));
  if (!selected.ok) die(selected.reason);

  // --config mirrors board-doctor's seam: it makes this entry point testable end to end,
  // and lets anyone try an alternate roster without editing the shipped file.
  const cfgPath = arg('config', join(ROOT, 'config/reviewers.json'));
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    die(`cannot read reviewer config ${cfgPath}: ${e.message}`);
  }

  // Reject an unusable roster before spending anything. Discovering it after the round
  // would mean paying for reviews, reporting an ambiguous outcome, and — because the
  // protocol treats that outcome as an infrastructure hiccup — retrying a configuration
  // that cannot ever work.
  const roster = validateReviewerConfig(cfg.reviewers);
  if (!roster.ok) die(`${cfgPath}: ${roster.reason}`);

  const schemaPath = join(ROOT, 'config/verdict.schema.json');
  const schemaInline = readFileSync(schemaPath, 'utf8');

  // The ignore rule must be in place before anything is written into the repository.
  // An earlier version had the host write brief.md first and the script add the ignore
  // rule afterwards, leaving a window: if the process died there, or another workflow
  // ran `git add -A`, the artifacts were exposed and a later rule could not unstage them.
  const ignore = ensureIgnored(repo);
  if (!ignore.ok) {
    if (ignore.action === 'not-a-git-repo') die(`${repo} is not a git repository; board needs git diff to work`);
    die(`.claude/board/ is still not ignored after writing ${ignore.excludePath}; fix it manually and retry`);
  }
  if (ignore.action === 'added-to-git-info-exclude') {
    process.stderr.write(`Added .claude/board/ to ${ignore.excludePath} (local-only ignore)\n`);
  }

  // intent / contested come from the host through temp files outside the repository —
  // the host no longer writes anything into .claude/board/ itself.
  //
  // Missing input always fails closed, never silently becomes an empty string. From
  // round 2 on, without contested the reviewers cannot see the previous round's points
  // or your reasons for accepting/rejecting them, so they either repeat themselves or
  // clear the change on incomplete context. That is not a debate; it is reviewing the
  // same diff twice.
  const repoReal = realpathSync(repo);
  const readRequired = (path, flag, why) => {
    if (!path) die(`missing ${flag} <file>: ${why}`);
    if (!existsSync(path)) die(`${flag} points at a file that does not exist: ${path}`);

    // The file must live outside the repository under review. Inside, it becomes an
    // untracked file and gets attached to its own brief. realpath both sides: on macOS
    // os.tmpdir() is /var/folders/... which resolves to /private/var/folders/..., so a
    // naive prefix comparison gives the wrong answer.
    const fileReal = realpathSync(path);
    if (fileReal === repoReal || fileReal.startsWith(repoReal + sep)) {
      die(`${flag} must point outside the repository under review (got ${fileReal}); otherwise it becomes an untracked file and ends up inside its own brief`);
    }

    // Same reasoning as assertReviewable: a directory or an unreadable file used to come
    // back as "board-round crashed: Error: EISDIR" / "EACCES", which reads like a bug in
    // board rather than a description of what the operator got wrong.
    let stats;
    try {
      stats = statSync(fileReal);
    } catch (e) {
      die(`${flag} cannot be read: ${path} (${e.code ?? e.message})`);
    }
    if (!stats.isFile()) {
      die(`${flag} must point at a regular file, but ${path} is not one`);
    }

    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      die(`${flag} cannot be read: ${path} (${e.code ?? e.message})`);
    }
    if (!text.trim()) die(`${flag} points at an empty file: ${path} — ${why}`);
    return text;
  };

  const intent = readRequired(arg('intent', null), '--intent', 'the reviewers need to know what this change is trying to do');
  const contested = round > 1
    ? readRequired(arg('contested', null), '--contested', `round ${round} must carry the previous round's contested points and how you handled them, or it is not a debate`)
    : '';

  if (!isDirty(repo)) die('the working tree has no uncommitted changes; there is nothing to review');

  const { changedLines } = repoStat(repo);
  const brief = buildBrief(repo, { intent, contested });

  const dir = join(repo, '.claude/board', `round-${round}`);
  mkdirSync(dir, { recursive: true });
  const briefPath = join(dir, 'brief.md');
  writeFileSync(briefPath, brief);
  // Set the expectation from the actual size rather than repeating one number. Measured:
  // 3,468 lines took 13m49s, which is 71 seconds under the default timeout.
  const big = changedLines > 2000;
  const eta = big
    ? `well over 10 minutes at xhigh effort for a change this size (the timeout is ${(cfg.timeoutMs ?? 300000) / 1000}s)`
    : 'roughly 5-8 minutes at xhigh effort';
  process.stderr.write(
    `[${selected.label}] brief ready: ${changedLines} changed lines, ${brief.length} characters.\n` +
      `Asking ${cfg.reviewers.length} reviewers in parallel — expect ${eta}, with no output until they finish.\n`,
  );

  const template = readFileSync(join(ROOT, selected.prompt), 'utf8');
  const prompt = inject(template, '{{BRIEF}}', brief);
  const promptFile = join(dir, 'prompt.txt');
  writeFileSync(promptFile, prompt);

  const ctx = {
    repo, prompt, promptFile, schemaPath, schemaInline,
    timeoutMs: cfg.timeoutMs ?? 300000,
    outFile: (id) => join(dir, `${id}.json`),
    transcript: (id) => join(dir, `${id}.md`),
  };

  const results = await Promise.all(cfg.reviewers.map((rv) => runReviewer(rv, ctx)));
  const tally = tallyRound(results);

  // Cost is derived inside formatSummary from the results themselves, so the table can
  // say which reviewers actually reported a number instead of presenting one CLI's cost
  // as the whole round's.
  const text = formatSummary({
    round, results, tally,
    modeLabel: selected.label,
    artifactDir: `.claude/board/round-${round}`,
  });

  writeFileSync(join(dir, 'summary.md'), `${text}\n`);
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify({ round, tally, results }, null, 2)}\n`);
  process.stdout.write(`${text}\n`);
}

// Only run when invoked directly, so tests can import parseArgs. realpath both sides —
// an installed skill is reached through a symlink.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((e) => die(`board-round crashed: ${e.stack}`));
}
