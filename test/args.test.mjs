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
