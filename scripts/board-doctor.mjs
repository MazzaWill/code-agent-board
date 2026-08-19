#!/usr/bin/env node
// Run this after installing, or after moving to a new machine.
// Why this deserves its own script: when a CLI is not logged in, the error hides in
// stderr and you only find out on the first real meeting — wasting a full round of
// waiting. Worse, the error reads like "the model refused to answer", so people
// conclude the mechanism is bad when they simply were not authenticated.

import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateReviewerConfig } from './reviewer-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROBE = 'Reply with the two characters OK and do nothing else.';

const MIN_NODE_MAJOR = 20;

// Resolve a binary through PATH ourselves instead of shelling out to `command -v`.
// `command` is a POSIX shell builtin that cmd.exe does not have, so the shell route
// reports every reviewer as missing on Windows.
export function findOnPath(bin, env = process.env) {
  const dirs = (env.PATH || '').split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, bin + ext);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

// Extract every model flag and its value, as adjacent pairs, from an argv array.
function modelPairs(args) {
  const pairs = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-m' || args[i] === '--model') pairs.push([args[i], args[i + 1]]);
  }
  return pairs;
}

// Derive probe arguments from the reviewer's real `args`, so there is exactly one
// source of truth for how each CLI is invoked. A hand-maintained second copy drifts
// by construction — that is how the probe ended up exercising a different model than
// the meeting used.
export function buildProbeArgs(rv) {
  const probe = rv?.probe;
  if (!probe) {
    return { ok: false, reason: `no "probe" block in config for "${rv?.id}"` };
  }

  const withValue = new Set(probe.dropFlagsWithValue || []);
  const bare = new Set(probe.dropFlags || []);

  const out = [];
  for (let i = 0; i < rv.args.length; i++) {
    const tok = rv.args[i];
    if (withValue.has(tok)) {
      i++; // also drop the value that follows
      continue;
    }
    if (bare.has(tok)) continue;
    out.push(tok);
  }

  // extraArgs are probe-only additions. Dedupe: a flag already inherited from `args`
  // (--ephemeral is the live example) must not be passed twice.
  for (const extra of probe.extraArgs || []) {
    if (!out.includes(extra)) out.push(extra);
  }

  // A surviving {placeholder} would reach the CLI literally and fail in a way that
  // looks like an auth problem. Refuse to probe rather than emit a misleading verdict.
  const leftover = out.find((t) => /\{[a-zA-Z]+\}/.test(t));
  if (leftover) {
    return { ok: false, reason: `unsubstituted placeholder "${leftover}" survived probe derivation` };
  }

  const via = probe.promptVia;
  if (via === 'argv') {
    out.push(PROBE);
  } else if (via === 'flag') {
    if (!probe.promptFlag) return { ok: false, reason: 'probe.promptVia is "flag" but promptFlag is missing' };
    out.push(probe.promptFlag, PROBE);
  } else {
    return { ok: false, reason: `unknown probe.promptVia "${via}" (expected "argv" or "flag")` };
  }

  return { ok: true, args: out };
}

// Belt and braces. Even if someone later adds -m to dropFlagsWithValue, refuse to run
// rather than silently probing whatever the CLI's global default happens to be.
export function assertModelParity(rv, probeArgs) {
  for (const [flag, model] of modelPairs(rv.args)) {
    const i = probeArgs.indexOf(flag);
    if (i === -1 || probeArgs[i + 1] !== model) {
      return { ok: false, reason: `probe would not pass ${flag} ${model}; it must use the same model as a real round` };
    }
  }
  return { ok: true };
}

// Is this checkout reachable as a skill directory named "board"? Resolve each plausible
// install location and compare with ROOT, so the answer does not depend on how the doctor
// was invoked.
export function installedAsBoard(root = ROOT, env = process.env) {
  // Same candidate list as SKILL.md's step 0, in the same order. If the two drift, the
  // doctor blesses installs the agent cannot find, or warns about ones it can.
  const candidates = [
    env.BOARD_HOME,
    env.HOME ? join(env.HOME, '.claude/skills/board') : null,
    env.CLAUDE_PLUGIN_ROOT ? join(env.CLAUDE_PLUGIN_ROOT, 'skills/board') : null,
    gitToplevel() ? join(gitToplevel(), '.claude/skills/board') : null,
    join(process.cwd(), '.claude/skills/board'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (realpathSync(c) === realpathSync(root)) return true;
    } catch {
      /* candidate does not exist */
    }
  }

  // No basename fallback. "The directory happens to be called board" is not the question —
  // a board/ directory nowhere on the skill search path is not installed, and treating it
  // as installed turns this check into an unconditional pass. Custom locations must say so
  // through BOARD_HOME.
  return false;
}

function gitToplevel() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function main() {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--config');
  const cfgPath = ci !== -1 ? argv[ci + 1] : join(ROOT, 'config/reviewers.json');

  console.log(`skill root: ${ROOT}`);

  // Answer the question that actually matters — "is this checkout reachable as a skill
  // named board?" — instead of inspecting whatever path the doctor was launched from.
  //
  // Two earlier attempts were both wrong. Checking basename(ROOT) warns every correct
  // install, because installing correctly means symlinking a checkout named
  // code-agent-board to .../skills/board. Checking the invocation path fixes that only
  // when the doctor is launched THROUGH the symlink — while README's `npm run doctor` and
  // install.sh's own printed command both run from the physical checkout, so the false
  // warning survived that fix too. Resolving the install target gives the same answer no
  // matter how the doctor was started. Found by board reviewing its own fix.
  if (!installedAsBoard()) {
    console.log(
      '⚠️  this checkout is not reachable as a skill named "board"\n' +
        '   (the /board command and the skill frontmatter both depend on that name).\n' +
        '   Run: sh install.sh',
    );
  }

  let bad = 0;

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MIN_NODE_MAJOR) {
    console.log(`❌ Node ${process.versions.node} is too old — board needs Node ${MIN_NODE_MAJOR}+`);
    bad++;
  }
  if (!findOnPath('git')) {
    console.log('❌ git not found on PATH — board builds its brief with git');
    bad++;
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.log(`❌ cannot read config ${cfgPath}: ${e.message}`);
    process.exit(1);
  }

  const reviewers = cfg.reviewers ?? [];
  const roster = validateReviewerConfig(reviewers);
  if (!roster.ok) {
    console.log(`❌ ${roster.reason}`);
    bad++;
  }

  for (const rv of reviewers) {
    process.stdout.write(`${String(rv.label).padEnd(24)} `);

    if (!findOnPath(rv.bin)) {
      console.log(`❌ not installed (${rv.bin} is not on PATH)`);
      bad++;
      continue;
    }

    const built = buildProbeArgs(rv);
    if (!built.ok) {
      // Never let an unverifiable reviewer read as ready. Silence here is exactly the
      // failure this project refuses to ship elsewhere.
      console.log(`❌ cannot verify: ${built.reason}`);
      bad++;
      continue;
    }

    const parity = assertModelParity(rv, built.args);
    if (!parity.ok) {
      console.log(`❌ cannot verify: ${parity.reason}`);
      bad++;
      continue;
    }

    const [, model] = modelPairs(rv.args)[0] || [];
    try {
      execFileSync(rv.bin, built.args, { timeout: 120000, stdio: 'ignore' });
      console.log(`✅ ready${model ? ` (${model})` : ''}`);
    } catch (e) {
      if (e.signal === 'SIGTERM') {
        console.log('❌ probe timed out after 120s');
      } else {
        // With the model pinned into the probe, "no access to this model" is now as
        // likely as "not logged in". Name both, and name the file to edit.
        console.log(
          `❌ probe failed. Either you are not logged in (try \`${rv.bin} login\`)` +
            (model ? `, or your account cannot use "${model}" — change it in ${cfgPath}` : ''),
        );
      }
      bad++;
    }
  }

  if (bad > 0) {
    console.log(`\n${bad} check(s) failed. board needs every reviewer ready, or there is no cross-verification.`);
    process.exit(1);
  }
  console.log('\nAll ready.');
}

// Only run when invoked directly, so tests can import the pure functions.
//
// realpath BOTH sides. install.sh links this repo to ~/.claude/skills/board, so argv[1]
// is a path through that symlink while import.meta.url is already resolved — comparing
// them unresolved makes this false for every installed user, and doctor then exits 0
// having checked nothing. A diagnostic tool silently reporting success is precisely what
// this project forbids everywhere else. Found by board reviewing this extraction.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}
