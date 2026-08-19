// A typo in a flag NAME has to fail as loudly as a typo in its value. The lenient parser
// ignored anything it did not recognise, so `--mdoe plan` silently reviewed a plan with
// the code prompt — very likely approving it, because markdown genuinely has no bugs.
// That is the same silent-fallback failure resolveMode refuses to allow one layer down.
// Found by board reviewing its own extraction.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseArgs } from '../scripts/board-round.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('a valid argument list parses', () => {
  const r = parseArgs(['--repo', '/tmp', '--round', '2', '--mode', 'plan', '--lang', 'zh-CN']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, { repo: '/tmp', round: '2', mode: 'plan', lang: 'zh-CN' });
});

test('boolean flags need no value', () => {
  const r = parseArgs(['--repo', '/tmp', '--stat']);
  assert.equal(r.ok, true);
  assert.equal(r.args.stat, true);
});

test('a misspelled flag name is rejected, never ignored', () => {
  const r = parseArgs(['--repo', '/tmp', '--mdoe', 'plan']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /--mdoe/);
  assert.match(r.reason, /--mode/, 'the error should list what is valid');
});

test('a flag missing its value is rejected rather than read as absent', () => {
  assert.equal(parseArgs(['--repo', '/tmp', '--lang']).ok, false);
  assert.equal(parseArgs(['--mode', '--repo', '/tmp']).ok, false, 'the next flag must not be eaten as a value');
});

test('a repeated flag is rejected', () => {
  const r = parseArgs(['--repo', '/a', '--repo', '/b']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /more than once/);
});

test('a bare positional argument is rejected', () => {
  const r = parseArgs(['--repo', '/tmp', 'oops']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /oops/);
});

test('round must be a positive integer', () => {
  // A malformed round used to slip past the "round > 1 requires --contested" rule,
  // losing the previous round's disputes and breaking the debate protocol.
  assert.equal(parseArgs(['--round', 'oops']).ok, false);
  assert.equal(parseArgs(['--round', '0']).ok, false);
  assert.equal(parseArgs(['--round', '-1']).ok, false);
  assert.equal(parseArgs(['--round', '2']).ok, true);
});

test('importing the module does not execute it', () => {
  // parseArgs used to run at module scope, so importing this file parsed the test
  // runner's argv and killed the process.
  assert.equal(typeof parseArgs, 'function');
});

test('the CLI entry point rejects a bad flag with exit code 2', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/board-round.mjs'), '--repo', '/tmp', '--mdoe', 'plan'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--mdoe/);
});

// —— Preflight on the repository itself. Each of these used to surface as
// —— "board-round crashed: Error: git diff --quiet failed: ..." — a stack-shaped message
// —— that reads like a bug in board rather than a description of what is wrong.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROUND = join(ROOT, 'scripts/board-round.mjs');
const runStat = (repo) =>
  spawnSync(process.execPath, [ROUND, '--repo', repo, '--stat'], { encoding: 'utf8' });

test('a repository with no commits yet is explained, not crashed on', async () => {
  // Ordinary situation: git init, write some code, want it reviewed before committing.
  const dir = await mkdtemp(join(tmpdir(), 'board-fresh-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  await writeFile(join(dir, 'a.txt'), 'x\n');

  const r = runStat(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no commits yet/);
  assert.doesNotMatch(r.stderr, /crashed/, 'must not look like a bug in board');
});

test('a directory that is not a git repository is explained', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-notgit-'));
  const r = runStat(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a git repository/);
  assert.doesNotMatch(r.stderr, /crashed/);
});

test('a --repo path that does not exist is explained', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-missing-'));
  const r = runStat(join(dir, 'nope'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist/);
  assert.doesNotMatch(r.stderr, /crashed/);
});

test('a normal repository still works', () => {
  const r = runStat(ROOT);
  assert.equal(r.status, 0);
  const stat = JSON.parse(r.stdout);
  assert.equal(typeof stat.dirty, 'boolean');
  assert.equal(typeof stat.changedLines, 'number');
});

test('--intent pointing at a directory is explained', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-intent-dir-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  await writeFile(join(dir, 'a.txt'), 'x\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  await writeFile(join(dir, 'a.txt'), 'y\n');

  const asDir = await mkdtemp(join(tmpdir(), 'board-notafile-'));
  const r = spawnSync(process.execPath, [ROUND, '--repo', dir, '--round', '1', '--intent', asDir], { encoding: 'utf8' });

  assert.equal(r.status, 2);
  assert.match(r.stderr, /regular file/);
  assert.doesNotMatch(r.stderr, /crashed/);
});

test('--intent that cannot be read is explained', { skip: process.getuid?.() === 0 ? 'root reads everything' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-intent-perm-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  await writeFile(join(dir, 'a.txt'), 'x\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  await writeFile(join(dir, 'a.txt'), 'y\n');

  const holder = await mkdtemp(join(tmpdir(), 'board-perm-'));
  const locked = join(holder, 'intent.md');
  await writeFile(locked, 'intent\n', { mode: 0o000 });

  const r = spawnSync(process.execPath, [ROUND, '--repo', dir, '--round', '1', '--intent', locked], { encoding: 'utf8' });

  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot be read/);
  assert.doesNotMatch(r.stderr, /crashed/);
});

test('importing the module registers no signal handlers', () => {
  // Handlers at module scope are inherited by every importer — `node --test` included,
  // where a cancellation would print board's message and exit 130 instead of running the
  // runner's own teardown. This file's own module already states that rule for argv
  // parsing; it applies just as much to signals. (args.test.mjs imports board-round, so
  // this assertion is about the very act of loading it here.)
  assert.equal(process.listenerCount('SIGINT'), 0);
  assert.equal(process.listenerCount('SIGTERM'), 0);
});

test('a non-numeric or zero timeoutMs is rejected with the offending value named', async () => {
  // The shipped config invites editing this field and it goes straight to setTimeout.
  // "15m" becomes NaN and fires after 1ms, killing every reviewer before it reads a byte
  // and reporting "exceeded NaNs" — which reads as "both CLIs hung", not "your config is
  // a string". 0, meaning "no timeout" to a human, survives ?? and does the same.
  const dir = await mkdtemp(join(tmpdir(), 'board-timeout-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  await writeFile(join(dir, 'a.txt'), 'x\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i']);
  await writeFile(join(dir, 'a.txt'), 'y\n');
  await writeFile(join(dir, '..', 'intent.md'), 'x\n');

  const { readFileSync } = await import('node:fs');
  const base = JSON.parse(readFileSync(join(ROOT, 'config/reviewers.json'), 'utf8'));

  for (const bad of ['15m', 0, -1, 1.5, 2 ** 40]) {
    const cfg = join(dir, '..', `t-${String(bad).replace(/\W/g, '')}.json`);
    await writeFile(cfg, JSON.stringify({ ...base, timeoutMs: bad }));
    const r = spawnSync(
      process.execPath,
      [ROUND, '--repo', dir, '--round', '1', '--intent', join(dir, '..', 'intent.md'), '--config', cfg],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 2, `timeoutMs ${JSON.stringify(bad)} should be refused`);
    assert.match(r.stderr, /timeoutMs must be a positive integer/);
  }
});

test('--repo must be the repository root, not a subdirectory', async () => {
  // git ls-files --others is scoped to the cwd while git diff HEAD covers the whole
  // repository, so a subdirectory produces a brief with the repo-wide diff and NO
  // untracked files — silently omitting exactly what this module exists to include.
  const dir = await mkdtemp(join(tmpdir(), 'board-subdir-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  await mkdir(join(dir, 'pkg'));
  await writeFile(join(dir, 'a.txt'), 'x\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i']);

  const r = spawnSync(process.execPath, [ROUND, '--repo', join(dir, 'pkg'), '--stat'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be the repository root/);
  assert.match(r.stderr, /Use: --repo/, 'the error should give the path that works');
});
