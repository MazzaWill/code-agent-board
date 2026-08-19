// Where these tests come from: during a self-review, a hand-written brief omitted the
// two most important files of the change (a new module and its tests) — `git diff HEAD`
// does not show untracked files. One reviewer refused to judge because it could not see
// the module being imported. It was right to refuse.
//
// "untracked new files must appear in the brief" is the only reason this module exists,
// so that assertion matters most. These run against a real git repository, because what
// is being verified is git's own behaviour around untracked files.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  buildBrief, countChangedLines, isDirty, listUntracked, readUntrackedFile, repoStat,
} from '../scripts/brief.mjs';

// Symlink creation needs elevation on Windows, and file-mode bits are not tracked
// there. Skipping loudly beats a red suite that says nothing about the code.
const posixOnly = process.platform === 'win32' ? { skip: 'POSIX-only behaviour' } : {};

const created = [];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

async function newRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'board-brief-'));
  created.push(dir);
  git(dir, 'init', '-q');
  await writeFile(join(dir, 'tracked.mjs'), 'export const a = 1;\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

after(async () => {
  for (const d of created) await rm(d, { recursive: true, force: true });
});

test('untracked new files reach the brief with their full contents', async () => {
  const dir = await newRepo();
  await writeFile(join(dir, 'brand-new.mjs'), 'export function secret() { return 42; }\n');

  const brief = buildBrief(dir, { intent: 'add a new module' });

  assert.match(brief, /brand-new\.mjs/, 'the filename must appear');
  assert.match(brief, /export function secret/, 'so must the contents — a filename alone is useless');
  assert.match(brief, /Untracked new files \(full contents\)/);
});

test('changes to tracked files go through the diff section', async () => {
  const dir = await newRepo();
  await writeFile(join(dir, 'tracked.mjs'), 'export const a = 2;\n');

  const brief = buildBrief(dir, { intent: 'x' });
  assert.match(brief, /-export const a = 1;/);
  assert.match(brief, /\+export const a = 2;/);
});

test('binary files are listed by name only, contents withheld', async () => {
  const dir = await newRepo();
  await writeFile(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  const brief = buildBrief(dir, {});
  assert.match(brief, /logo\.png/);
  assert.match(brief, /binary file, contents not attached/);
});

test('security: secret-looking files are skipped visibly, never attached', async () => {
  const dir = await newRepo();
  // Untracked AND absent from .gitignore, so git reports it and it would otherwise be
  // attached in full — and the brief goes to two third-party CLIs.
  await writeFile(join(dir, '.env'), 'STRIPE_SECRET_KEY=sk_live_MUST_NOT_LEAK\n');
  await writeFile(join(dir, 'server.pem'), '-----BEGIN PRIVATE KEY-----\nMUST_NOT_LEAK\n');

  const brief = buildBrief(dir, { intent: 't' });

  assert.doesNotMatch(brief, /sk_live_MUST_NOT_LEAK/, '.env contents leaked into the brief');
  assert.doesNotMatch(brief, /BEGIN PRIVATE KEY/, 'private key contents leaked into the brief');
  assert.match(brief, /looks like a secret/, 'the skip must be visible, not silent');
  assert.match(brief, /\.env/, 'the filename itself is still worth showing the reviewers');
});

test('oversized untracked files are truncated and say so, instead of blowing up the brief', async () => {
  const dir = await newRepo();
  await writeFile(join(dir, 'huge.log'), 'x'.repeat(200 * 1024));

  const brief = buildBrief(dir, {});
  assert.match(brief, /only the first 65536 are attached/);
  assert.ok(brief.length < 120 * 1024, `brief should be truncated, got ${brief.length} characters`);
});

test('filenames containing spaces are listed correctly (NUL splitting)', async () => {
  const dir = await newRepo();
  await mkdir(join(dir, 'a dir'), { recursive: true });
  await writeFile(join(dir, 'a dir', 'has space.mjs'), 'export const s = 1;\n');

  const files = listUntracked(dir);
  assert.deepEqual(files, ['a dir/has space.mjs']);
  assert.match(buildBrief(dir, {}), /export const s = 1;/);
});

test('contested points appear when supplied and leave no empty section when not', async () => {
  const dir = await newRepo();
  await writeFile(join(dir, 'tracked.mjs'), 'export const a = 3;\n');

  assert.doesNotMatch(buildBrief(dir, { intent: 'x' }), /Contested points/);
  assert.match(
    buildBrief(dir, { intent: 'x', contested: '### some point\nnot adopted, because Y' }),
    /not adopted, because Y/,
  );
});

test('changed-line count includes untracked files', async () => {
  const dir = await newRepo();
  await writeFile(join(dir, 'tracked.mjs'), 'export const a = 2;\n');
  const trackedOnly = countChangedLines(dir);

  await writeFile(join(dir, 'new.mjs'), 'a\nb\nc\n');
  const withUntracked = countChangedLines(dir);

  assert.ok(withUntracked > trackedOnly, 'untracked lines must count, or a big change reads as a small one');
});

test('a clean working tree reports 0 changed lines', async () => {
  const dir = await newRepo();
  assert.equal(countChangedLines(dir), 0);
});

test('repoStat reports both dirtiness and size in one call', async () => {
  const dir = await newRepo();
  assert.deepEqual(repoStat(dir), { dirty: false, changedLines: 0 });

  await writeFile(join(dir, 'new.mjs'), 'a\nb\n');
  const stat = repoStat(dir);
  assert.equal(stat.dirty, true);
  assert.ok(stat.changedLines > 0);
});

// —— The following came out of board reviewing its own implementation. Each one maps to
// —— a real defect that was found and fixed.

test('security: untracked symlinks are never followed; outside content stays out', posixOnly, async () => {
  const dir = await newRepo();
  const outside = join(dir, '..', `outside-${Date.now() % 100000}.txt`);
  created.push(outside);
  await writeFile(outside, 'FAKE-PRIVATE-KEY-MUST-NOT-LEAK\n');
  await symlink(outside, join(dir, 'notes.txt'));

  const brief = buildBrief(dir, { intent: 't' });
  assert.doesNotMatch(brief, /FAKE-PRIVATE-KEY-MUST-NOT-LEAK/,
    'content from outside the repo leaked through a symlink — the brief goes to external CLIs');
  assert.match(brief, /not a regular file/, 'the skip reason must be stated, not silently swallowed');
});

test('security: symlinks are excluded from the line count too (same read path)', posixOnly, async () => {
  const dir = await newRepo();
  const outside = join(dir, '..', `big-${Date.now() % 100000}.txt`);
  created.push(outside);
  await writeFile(outside, 'x\n'.repeat(5000));
  await symlink(outside, join(dir, 'link.txt'));

  assert.equal(countChangedLines(dir), 0, 'a symlink must not contribute to the line count');
});

test('huge files are not read into memory whole (only the first 64 KiB)', async () => {
  const dir = await newRepo();
  // 200 MB. The old implementation read the file fully and then sliced, which would
  // OOM or throw ERR_STRING_TOO_LONG right here.
  const huge = join(dir, 'huge.log');
  const fd = await open(huge, 'w');
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  for (let i = 0; i < 200; i++) await fd.write(chunk);
  await fd.close();

  const f = readUntrackedFile(dir, 'huge.log');
  assert.ok(f.content.length <= 65536, `should read 64 KiB at most, got ${f.content.length}`);
  assert.match(f.truncated, /only the first 65536 are attached/);
});

test('isDirty: a pure rename counts as a change (countChangedLines would say 0)', async () => {
  const dir = await newRepo();
  git(dir, 'mv', 'tracked.mjs', 'renamed.mjs');

  assert.equal(countChangedLines(dir), 0, 'precondition: a rename has 0 added and 0 deleted');
  assert.equal(isDirty(dir), true, 'but it is a legitimate change; the meeting must not be refused');
});

test('isDirty: a file-mode change counts as a change', posixOnly, async () => {
  const dir = await newRepo();
  await chmod(join(dir, 'tracked.mjs'), 0o755);

  assert.equal(isDirty(dir), true);
});

test('isDirty: untracked files alone count as a change', async () => {
  const dir = await newRepo();
  await writeFile(join(dir, 'brand-new.mjs'), 'export const x = 1;\n');

  assert.equal(isDirty(dir), true);
});

test('isDirty: a clean working tree returns false', async () => {
  const dir = await newRepo();
  assert.equal(isDirty(dir), false);
});
