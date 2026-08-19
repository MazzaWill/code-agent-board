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

  assert.notEqual(r.signal, 'SIGTERM', `round did not finish within ${ALLOWED_MS}ms — it hung`);
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

  assert.equal(r.signal, null, 'the process had to be killed — it never exited by itself');
  assert.equal(r.status, 0);
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
