// These run against a real git repository, because what is being verified IS git's own
// behaviour (--git-dir and --git-path resolve to different places inside a linked
// worktree). Mocking git away would mock away the thing under test.
//
// Where they came from: the first version of ensureIgnored located info/exclude via
// --git-dir. That works in an ordinary repository but writes to the wrong place in a
// linked worktree, without any error — the script claimed the artifacts were ignored and
// carried on while they stayed visible in git status.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, test } from 'node:test';

import { ensureIgnored } from '../scripts/git-artifacts.mjs';

const created = [];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

async function newRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'board-git-'));
  created.push(dir);
  git(dir, 'init', '-q');
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

// The artifact has to actually exist before "can git see it" means anything — git does
// not track empty directories in the first place.
async function makeArtifacts(dir) {
  await mkdir(join(dir, '.claude/board/round-1'), { recursive: true });
  await writeFile(join(dir, '.claude/board/round-1/brief.md'), 'x\n');
}

after(async () => {
  for (const d of created) await rm(d, { recursive: true, force: true });
});

test('ordinary repository: artifacts are ignored once exclude is written', async () => {
  const dir = await newRepo();
  await makeArtifacts(dir);

  const r = ensureIgnored(dir);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'added-to-git-info-exclude');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'artifacts must not show up in git status');
});

test('linked worktree: exclude must land in the common git dir or it has no effect', async () => {
  const main = await newRepo();
  const wt = join(main, '..', `wt-${Date.now() % 100000}`);
  created.push(wt);
  git(main, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
  await makeArtifacts(wt);

  const r = ensureIgnored(wt);
  assert.equal(r.ok, true, 'must succeed inside a worktree — locating via --git-dir fails right here');
  assert.equal(git(wt, 'status', '--porcelain'), '', 'artifacts must be invisible to git inside the worktree too');

  // Assert it landed in the right place: the common dir, not .git/worktrees/<name>/.
  // Normalize separators so this reads the same on Windows.
  assert.match(r.excludePath.split(sep).join('/'), /\.git\/info\/exclude$/);
  assert.doesNotMatch(r.excludePath, /worktrees/);
});

test('does not touch exclude when .gitignore already covers the path', async () => {
  const dir = await newRepo();
  await writeFile(join(dir, '.gitignore'), '.claude\n');
  await makeArtifacts(dir);

  const r = ensureIgnored(dir);
  assert.equal(r.action, 'already-ignored');
  assert.equal(r.excludePath, undefined);
});

test('repeated calls are idempotent', async () => {
  const dir = await newRepo();
  await makeArtifacts(dir);

  assert.equal(ensureIgnored(dir).action, 'added-to-git-info-exclude');
  assert.equal(ensureIgnored(dir).action, 'already-ignored', 'the second call must take the already-ignored branch');
});

test('does not append a duplicate when the rule is already in exclude', async () => {
  const dir = await newRepo();
  await makeArtifacts(dir);
  const excludePath = join(dir, '.git/info/exclude');

  ensureIgnored(dir);
  const first = await readFile(excludePath, 'utf8');

  // Simulate check-ignore failing for an unrelated reason: the rule is still in the
  // file, but the function reaches the write branch anyway. An unconditional append
  // would grow exclude without bound.
  ensureIgnored(dir);
  await writeFile(excludePath, first);
  ensureIgnored(dir);

  const after2 = await readFile(excludePath, 'utf8');
  const occurrences = after2.split('\n').filter((l) => l.trim() === '.claude/board/').length;
  assert.equal(occurrences, 1, `.claude/board/ should appear exactly once, found ${occurrences}`);
});

test('a non-git directory returns not-a-git-repo instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-nogit-'));
  created.push(dir);

  const r = ensureIgnored(dir);
  assert.equal(r.ok, false);
  assert.equal(r.action, 'not-a-git-repo');
});
