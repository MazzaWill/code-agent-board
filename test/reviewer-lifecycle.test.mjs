// End-to-end coverage of how a reviewer process is waited on.
//
// board used to listen for `close` alone. That event fires only once every stdio stream
// is closed, and a grandchild that inherited them keeps them open long after the reviewer
// itself has exited. Both shipped reviewers are agentic CLIs that routinely start helper
// processes, so a reviewer which answered in 30 seconds would leave the round waiting out
// the entire 900-second timeout and then be recorded as a `timeout` — a real verdict
// thrown away, fifteen minutes gone.
//
// These tests use a fake reviewer that prints a valid verdict, exits, and leaves a
// grandchild holding the pipes. They assert on wall-clock time, because the failure mode
// is not a wrong answer but a right answer that arrives far too late, or never.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUND = join(ROOT, 'scripts/board-round.mjs');

const TIMEOUT_MS = 600000; // what a real round is configured with; must not be reached
const ALLOWED_MS = 30000; // grace period is 5s, so anything near this means it hung

async function scratchRepo(dir) {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  await writeFile(join(dir, 'a.txt'), 'x\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  await writeFile(join(dir, 'a.txt'), 'y\n');
}

// Exits immediately, but leaves a grandchild holding stdout/stderr for two minutes.
const FAKE = `#!/bin/sh
cat > /dev/null &
sleep 120 &
printf '%s'
exit 0
`;

async function fixture(verdictJson) {
  // The repository and the operator's files must be separate trees: board rejects an
  // --intent that resolves inside the repository under review, because such a file becomes
  // untracked and ends up inside its own brief. (That guard caught the first version of
  // this fixture, which is a good sign.)
  const home = await mkdtemp(join(tmpdir(), 'board-lifecycle-'));
  const dir = join(home, 'repo');
  await mkdir(dir);
  await scratchRepo(dir);
  await writeFile(join(home, 'intent.md'), 'why this change exists\n');

  const reviewers = [];
  for (const [i, id] of ['one', 'two'].entries()) {
    const bin = join(home, `fake-${id}`);
    await writeFile(bin, FAKE.replace('%s', verdictJson.replace(/'/g, "'\\''")));
    await chmod(bin, 0o755);
    reviewers.push({
      id, label: id, bin, vendor: `vendor-${i}`, promptVia: 'stdin', outputVia: 'stdout', args: [],
      probe: { dropFlagsWithValue: [], dropFlags: [], extraArgs: [], promptVia: 'argv' },
    });
  }
  const cfg = join(home, 'reviewers.json');
  await writeFile(cfg, JSON.stringify({ timeoutMs: TIMEOUT_MS, reviewers }));
  return { dir, cfg, intent: join(home, 'intent.md') };
}

const ENVELOPE = (summary) =>
  JSON.stringify({
    structuredOutput: { verdict: 'approve', blocking: [], non_blocking: [], one_line_summary: summary },
    total_cost_usd: 0.01,
  });

test('a reviewer that exits while a grandchild holds the pipes does not hang the round', async () => {
  const { dir, cfg, intent } = await fixture(ENVELOPE('fake ok'));

  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    [ROUND, '--repo', dir, '--round', '1', '--intent', intent, '--config', cfg],
    { encoding: 'utf8', timeout: ALLOWED_MS },
  );
  const elapsed = Date.now() - started;

  // Check the exit STATUS, not the signal. Since board installs a SIGTERM handler, the
  // kill that spawnSync sends on timeout is caught and turned into exit(130) — so
  // `signal` is null in the hang case too, and asserting on it would pass exactly when
  // the test is meant to fail. (Verified by reverting the fix: this test goes red, the
  // signal assertion alone would not have.)
  assert.equal(r.status, 0, `round did not finish cleanly within ${ALLOWED_MS}ms — it hung (signal=${r.signal})`);
  assert.ok(elapsed < ALLOWED_MS, `round took ${elapsed}ms, nowhere near the ${TIMEOUT_MS}ms timeout`);
  assert.match(r.stdout, /approved \(unanimous\)/, 'the verdicts were collected correctly');
  assert.doesNotMatch(r.stdout, /timeout/, 'a reviewer that answered must not be recorded as a timeout');
});

test('the process exits on its own, rather than being held open by the pipes', async () => {
  // Distinct from the above: the round can conclude and print its summary while the node
  // process still sits there, because our read ends of the grandchild-held pipes remain
  // active handles. The shell simply never gets its prompt back.
  const { dir, cfg, intent } = await fixture(ENVELOPE('fake ok'));

  const r = spawnSync(
    process.execPath,
    [ROUND, '--repo', dir, '--round', '1', '--intent', intent, '--config', cfg],
    { encoding: 'utf8', timeout: ALLOWED_MS },
  );

  // status, again: a caught SIGTERM produces status 130 with signal null, so only the
  // status distinguishes "exited by itself" from "was killed and handled it gracefully".
  assert.equal(r.status, 0, `the process did not exit by itself (status=${r.status}, signal=${r.signal})`);
});

test('the elapsed time of each reviewer is recorded in its transcript', async () => {
  // The only signal that distinguishes a reviewer which worked from one which did not.
  const { dir, cfg, intent } = await fixture(ENVELOPE('fake ok'));

  spawnSync(
    process.execPath,
    [ROUND, '--repo', dir, '--round', '1', '--intent', intent, '--config', cfg],
    { encoding: 'utf8', timeout: ALLOWED_MS },
  );

  const { readFileSync } = await import('node:fs');
  const transcript = readFileSync(join(dir, '.claude/board/round-1/one.md'), 'utf8');
  assert.match(transcript, /^Elapsed: [0-9.]+s$/m);
});

test('Ctrl-C stops the reviewers instead of leaving them running', async () => {
  // Without this, the operator's prompt comes back and they assume the round was
  // cancelled, while both reviewers keep working — and keep charging — in the background.
  // Killing the direct child is not enough either: these CLIs start helper processes that
  // survive it, which is why each reviewer gets its own process group.
  const home = await mkdtemp(join(tmpdir(), 'board-cancel-'));
  const dir = join(home, 'repo');
  await mkdir(dir);
  await scratchRepo(dir);
  await writeFile(join(home, 'intent.md'), 'why\n');

  const pidDir = join(home, 'pids');
  await mkdir(pidDir);

  const reviewers = [];
  for (const [i, id] of ['a', 'b'].entries()) {
    const bin = join(home, `slow-${id}`);
    // Records the pid of a helper it starts, then blocks. The helper is what a plain
    // child.kill() would miss.
    await writeFile(bin, `#!/bin/sh\nsleep 300 &\necho $! > ${join(pidDir, id)}\nsleep 300\n`);
    await chmod(bin, 0o755);
    reviewers.push({
      id, label: id, bin, vendor: `v${i}`, promptVia: 'stdin', outputVia: 'stdout', args: [],
      probe: { dropFlagsWithValue: [], dropFlags: [], extraArgs: [], promptVia: 'argv' },
    });
  }
  const cfg = join(home, 'reviewers.json');
  await writeFile(cfg, JSON.stringify({ timeoutMs: TIMEOUT_MS, reviewers }));

  const { spawn } = await import('node:child_process');
  const { readFileSync, existsSync } = await import('node:fs');
  const round = spawn(
    process.execPath,
    [ROUND, '--repo', dir, '--round', '1', '--intent', join(home, 'intent.md'), '--config', cfg],
    { stdio: 'ignore' },
  );

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  // Wait for both helpers to exist.
  let helpers = [];
  for (let i = 0; i < 100 && helpers.length < 2; i++) {
    await sleepMs(100);
    helpers = ['a', 'b']
      .filter((id) => existsSync(join(pidDir, id)))
      .map((id) => Number(readFileSync(join(pidDir, id), 'utf8').trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }
  assert.equal(helpers.length, 2, 'both reviewers should have started a helper process');
  assert.ok(helpers.every(alive), 'helpers should be running before we cancel');

  round.kill('SIGINT');

  let remaining = helpers;
  for (let i = 0; i < 50 && remaining.length > 0; i++) {
    await sleepMs(100);
    remaining = helpers.filter(alive);
  }

  // Clean up anything that survived, so a failure here does not leak processes.
  for (const pid of remaining) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }

  assert.deepEqual(remaining, [], 'helper processes survived cancellation');
});

test('a stale verdict from a previous attempt is never counted as this round', async () => {
  // The protocol says an inconclusive round "does not count — re-run with the same round
  // number", so a retry reuses round-N/. The verdict file was read behind a bare
  // existsSync, so a reviewer that exits this time without writing anything had its
  // PREVIOUS verdict counted as a fresh vote. Reproduced before the fix: a reviewer that
  // did no work voted approve on a diff it never saw, and the round read "approved
  // (unanimous)".
  const home = await mkdtemp(join(tmpdir(), 'board-stale-'));
  const dir = join(home, 'repo');
  await mkdir(dir);
  await scratchRepo(dir);
  await writeFile(join(home, 'intent.md'), 'why\n');

  const grok = join(home, 'grok');
  await writeFile(grok, `#!/bin/sh\nprintf '%s'\n`.replace('%s', ENVELOPE('grok ok').replace(/'/g, "'\\''")));
  await chmod(grok, 0o755);

  const roster = (codexBin) => ({
    timeoutMs: TIMEOUT_MS,
    reviewers: [
      { id: 'codex', label: 'codex', bin: codexBin, vendor: 'v1', promptVia: 'stdin', outputVia: 'file',
        args: ['x', '{outFile}'], probe: { dropFlagsWithValue: [], dropFlags: [], extraArgs: [], promptVia: 'argv' } },
      { id: 'grok', label: 'grok', bin: grok, vendor: 'v2', promptVia: 'stdin', outputVia: 'stdout',
        args: [], probe: { dropFlagsWithValue: [], dropFlags: [], extraArgs: [], promptVia: 'argv' } },
    ],
  });

  // Attempt 1: codex writes a real verdict.
  const writer = join(home, 'writer');
  await writeFile(writer, `#!/bin/sh\nprintf '{"verdict":"approve","blocking":[],"non_blocking":[],"one_line_summary":"STALE-FROM-ATTEMPT-1"}' > "$2"\n`);
  await chmod(writer, 0o755);
  const cfg1 = join(home, 'cfg1.json');
  await writeFile(cfg1, JSON.stringify(roster(writer)));

  const run = (cfg) => spawnSync(
    process.execPath,
    [ROUND, '--repo', dir, '--round', '1', '--intent', join(home, 'intent.md'), '--config', cfg],
    { encoding: 'utf8', timeout: ALLOWED_MS },
  );

  run(cfg1);

  // Attempt 2, same round number: codex exits without writing anything.
  const nothing = join(home, 'nothing');
  await writeFile(nothing, '#!/bin/sh\nexit 0\n');
  await chmod(nothing, 0o755);
  const cfg2 = join(home, 'cfg2.json');
  await writeFile(cfg2, JSON.stringify(roster(nothing)));

  const r = run(cfg2);

  assert.doesNotMatch(r.stdout, /STALE-FROM-ATTEMPT-1/, "the previous attempt's verdict was counted as this round's");
  assert.doesNotMatch(r.stdout, /approved \(unanimous\)/, 'a reviewer that did no work must not carry the round');
  assert.match(r.stdout, /parse_error/);
});

test('a multi-byte verdict survives chunk boundaries intact', async () => {
  // `stdout += buffer` stringifies each chunk on its own, so a character straddling a
  // 64 KiB boundary became U+FFFD. JSON's structural characters are ASCII, so the parse
  // still succeeded and validation still passed — the damage landed inside the findings
  // themselves and reached the summary table with nothing signalling it. --lang zh-CN
  // exists to make reviewers answer in exactly such a language.
  const long = '评审意见'.repeat(8000);
  const verdict = {
    structuredOutput: {
      verdict: 'request_changes',
      blocking: [{ file: 'a.ts', line: 1, issue: long, why_it_matters: '要紧', suggested_fix: null }],
      non_blocking: [], one_line_summary: '中文摘要',
    },
  };

  const home = await mkdtemp(join(tmpdir(), 'board-utf8-'));
  const dir = join(home, 'repo');
  await mkdir(dir);
  await scratchRepo(dir);
  await writeFile(join(home, 'intent.md'), 'why\n');
  await writeFile(join(home, 'verdict.json'), JSON.stringify(verdict));

  const reviewers = [];
  for (const [i, id] of ['a', 'b'].entries()) {
    const bin = join(home, `r-${id}`);
    await writeFile(bin, i === 0
      ? `#!/bin/sh\ncat ${JSON.stringify(join(home, 'verdict.json'))}\n`
      : `#!/bin/sh\nprintf '%s'\n`.replace('%s', ENVELOPE('ok').replace(/'/g, "'\\''")));
    await chmod(bin, 0o755);
    reviewers.push({ id, label: id, bin, vendor: `v${i}`, promptVia: 'stdin', outputVia: 'stdout', args: [],
      probe: { dropFlagsWithValue: [], dropFlags: [], extraArgs: [], promptVia: 'argv' } });
  }
  const cfg = join(home, 'reviewers.json');
  await writeFile(cfg, JSON.stringify({ timeoutMs: TIMEOUT_MS, reviewers }));

  spawnSync(
    process.execPath,
    [ROUND, '--repo', dir, '--round', '1', '--intent', join(home, 'intent.md'), '--config', cfg],
    { encoding: 'utf8', timeout: ALLOWED_MS },
  );

  const { readFileSync } = await import('node:fs');
  const results = JSON.parse(readFileSync(join(dir, '.claude/board/round-1/results.json'), 'utf8'));
  const issue = results.results.find((r) => r.id === 'a').blocking[0].issue;

  assert.ok(!issue.includes('�'), 'the verdict contains replacement characters');
  assert.equal(issue, long, 'the verdict was corrupted in transit');
});

test('a reviewer that never received the brief cannot vote', async () => {
  // Nothing used to verify the brief arrived: stdin errors were swallowed wholesale and
  // write()'s completion was never observed. A reviewer that exits early — expired auth,
  // a bad flag, a dead helper — answers about a change it never saw, and its vote counts.
  // prompts/*.md put {{BRIEF}} on the LAST line, so a partial write delivers every
  // instruction and only a prefix of the diff: the worst possible truncation point.
  const home = await mkdtemp(join(tmpdir(), 'board-undelivered-'));
  const dir = join(home, 'repo');
  await mkdir(dir);
  await scratchRepo(dir);
  await writeFile(join(home, 'intent.md'), 'why\n');
  // Large enough that the write cannot fit in the pipe buffer in one go.
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(300000));

  const liar = join(home, 'liar');
  await writeFile(liar, `#!/bin/sh\nprintf '%s'\nexit 0\n`.replace('%s', ENVELOPE('looks fine to me').replace(/'/g, "'\\''")));
  await chmod(liar, 0o755);

  const honest = join(home, 'honest');
  await writeFile(honest, `#!/bin/sh\ncat > /dev/null\nprintf '%s'\n`.replace('%s', ENVELOPE('read it properly').replace(/'/g, "'\\''")));
  await chmod(honest, 0o755);

  const cfg = join(home, 'reviewers.json');
  await writeFile(cfg, JSON.stringify({
    timeoutMs: TIMEOUT_MS,
    reviewers: [
      { id: 'liar', label: 'liar', bin: liar, vendor: 'v1', promptVia: 'stdin', outputVia: 'stdout', args: [],
        probe: { dropFlagsWithValue: [], dropFlags: [], extraArgs: [], promptVia: 'argv' } },
      { id: 'honest', label: 'honest', bin: honest, vendor: 'v2', promptVia: 'stdin', outputVia: 'stdout', args: [],
        probe: { dropFlagsWithValue: [], dropFlags: [], extraArgs: [], promptVia: 'argv' } },
    ],
  }));

  const r = spawnSync(
    process.execPath,
    [ROUND, '--repo', dir, '--round', '1', '--intent', join(home, 'intent.md'), '--config', cfg],
    { encoding: 'utf8', timeout: ALLOWED_MS },
  );

  assert.match(r.stdout, /brief was not delivered/, 'the undelivered reviewer must be reported as such');
  assert.doesNotMatch(r.stdout, /looks fine to me/, 'its verdict must not be counted');
  assert.doesNotMatch(r.stdout, /approved \(unanimous\)/);
});
