import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluateRoutingReplayFile, parseRoutingCase } from './routing-replay-io.js';

const state = {
  task: 'fix', phase: 'post_test', loaded: 'few', unloadedCandidates: 'none',
  tests: { lastRun: 'passed', dirtySinceLastRun: false }, lastActions: ['run_tests'],
};

test('loads routing cases and evaluates an injected router', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-replay-io-'));
  const path = join(root, 'cases.jsonl');
  await writeFile(path, `${JSON.stringify({ id: 'one', state, feasible: ['reason', 'stop'], labels: { shouldStop: true } })}\n`);
  const result = await evaluateRoutingReplayFile(path, { async route() { return { action: 'stop', source: 'rule' }; } });
  assert.equal(result.falseStopRate, 0);
  assert.equal(result.falseContinueRate, 0);
});

test('rejects malformed replay states and labels', () => {
  assert.throws(() => parseRoutingCase(JSON.stringify({ id: 'x', state: {}, feasible: ['reason'], labels: {} })), /Invalid/);
  assert.throws(() => parseRoutingCase(JSON.stringify({ id: 'x', state, feasible: ['invent'], labels: {} })), /Invalid/);
  assert.throws(() => parseRoutingCase(JSON.stringify({ id: 'x', state, feasible: ['reason'], labels: { shouldStop: 'yes' } })), /labels/);
});
