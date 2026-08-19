// The doctor exists so that "installed but not working" is discovered in 30 seconds
// instead of on the first real meeting, five minutes in.
//
// It used to keep its own hand-written copy of each CLI's invocation, which drifted from
// config/reviewers.json by construction: the probe ran whatever model the CLI defaulted
// to, while a real round ran the pinned one. An account without access to the pinned
// model therefore got a green "all ready" and a failure on the first meeting — the
// single most likely install problem, sailing straight past the tool built to catch it.
//
// These tests pin down the derivation and, above all, that an unverifiable reviewer can
// never read as ready.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { assertModelParity, buildProbeArgs, findOnPath } from '../scripts/board-doctor.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = join(ROOT, 'scripts/board-doctor.mjs');

const { createRequire } = await import('node:module');
const cfg = createRequire(import.meta.url)(join(ROOT, 'config/reviewers.json'));
const byId = (id) => cfg.reviewers.find((r) => r.id === id);

const created = [];
after(async () => {
  for (const d of created) await rm(d, { recursive: true, force: true });
});

async function fixtureConfig(reviewers) {
  const dir = await mkdtemp(join(tmpdir(), 'board-doctor-'));
  created.push(dir);
  const p = join(dir, 'reviewers.json');
  await writeFile(p, JSON.stringify({ timeoutMs: 1000, reviewers }, null, 2));
  return p;
}

test('the codex probe uses the pinned model, not the CLI default', () => {
  // THE regression test for the original defect. Before the fix the probe carried no
  // -m at all, so it exercised whatever the global codex config happened to point at.
  const args = buildProbeArgs(byId('codex'));
  assert.equal(args.ok, true, args.reason);
  const i = args.args.indexOf('-m');
  assert.notEqual(i, -1, 'the probe must pass -m');
  assert.equal(args.args[i + 1], 'gpt-5.6-sol');
});

test('the grok probe uses the pinned model too', () => {
  const args = buildProbeArgs(byId('grok'));
  assert.equal(args.ok, true, args.reason);
  const i = args.args.indexOf('-m');
  assert.notEqual(i, -1);
  assert.equal(args.args[i + 1], 'grok-4.6');
});

test('every probe keeps its read-only sandbox flag', () => {
  for (const rv of cfg.reviewers) {
    const { ok, args } = buildProbeArgs(rv);
    assert.equal(ok, true);
    assert.ok(args.includes('read-only'), `${rv.id} probe lost its read-only sandbox`);
  }
});

test('probe derivation strips the schema, output and prompt plumbing', () => {
  for (const rv of cfg.reviewers) {
    const { args } = buildProbeArgs(rv);
    for (const flag of ['--output-schema', '-o', '--json-schema', '--prompt-file', '--cwd', '-C']) {
      assert.ok(!args.includes(flag), `${rv.id} probe should not carry ${flag}`);
    }
  }
});

test('no unsubstituted placeholder survives derivation', () => {
  for (const rv of cfg.reviewers) {
    const { args } = buildProbeArgs(rv);
    const leftover = args.find((a) => /\{[a-zA-Z]+\}/.test(a));
    assert.equal(leftover, undefined, `${rv.id} probe still contains ${leftover}`);
  }
});

test('a flag inherited from args is not added twice by extraArgs', () => {
  // --ephemeral lives in codex's real args and could plausibly be repeated in
  // extraArgs; passing it twice is the kind of thing that only shows up as a confusing
  // CLI error much later.
  const rv = structuredClone(byId('codex'));
  rv.probe.extraArgs = [...rv.probe.extraArgs, '--ephemeral'];
  const { args } = buildProbeArgs(rv);
  assert.equal(args.filter((a) => a === '--ephemeral').length, 1);
});

test('a reviewer with no probe block cannot be verified', () => {
  const rv = structuredClone(byId('codex'));
  delete rv.probe;
  const r = buildProbeArgs(rv);
  assert.equal(r.ok, false);
  assert.match(r.reason, /probe/);
});

test('an unknown promptVia cannot be verified', () => {
  const rv = structuredClone(byId('codex'));
  rv.probe.promptVia = 'telepathy';
  const r = buildProbeArgs(rv);
  assert.equal(r.ok, false);
  assert.match(r.reason, /telepathy/);
});

test('model parity fails if the probe would drop -m', () => {
  // Belt and braces: even if someone later adds -m to dropFlagsWithValue, the doctor
  // must refuse to run rather than silently probe the wrong model.
  const rv = structuredClone(byId('codex'));
  rv.probe.dropFlagsWithValue = [...rv.probe.dropFlagsWithValue, '-m'];
  const { args } = buildProbeArgs(rv);
  const parity = assertModelParity(rv, args);
  assert.equal(parity.ok, false);
  assert.match(parity.reason, /gpt-5\.6-sol/);
});

test('findOnPath resolves a real binary and rejects a missing one', () => {
  assert.ok(findOnPath('git'), 'git should be found on PATH in any environment that can run these tests');
  assert.equal(findOnPath('definitely-not-a-real-binary-9f3a2b'), null);
});

test('doctor exits non-zero when a reviewer cannot be verified', async () => {
  // The iron law, enforced end to end: an unverifiable reviewer must never let the run
  // report success. The old code printed a warning and exited 0.
  const p = await fixtureConfig([
    { id: 'mystery', label: 'mystery', bin: 'git', args: ['--version'] }, // real binary, no probe block
  ]);
  const r = spawnSync(process.execPath, [DOCTOR, '--config', p], { encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stdout:\n${r.stdout}`);
  assert.match(r.stdout, /cannot verify/);
});

test('doctor exits non-zero when a reviewer binary is missing', async () => {
  const p = await fixtureConfig([
    {
      id: 'ghost', label: 'ghost', bin: 'definitely-not-a-real-binary-9f3a2b', args: ['-m', 'x'],
      probe: { dropFlagsWithValue: [], dropFlags: [], extraArgs: [], promptVia: 'argv' },
    },
  ]);
  const r = spawnSync(process.execPath, [DOCTOR, '--config', p], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not installed/);
});
