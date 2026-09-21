import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildRoutingDataset } from './routing-dataset.js';
import type { EvaluationTask } from './tasks.js';

const task: EvaluationTask = {
  id: 'task', type: 'T-fix', task: 'fix auth', goldFiles: ['auth.ts'], testFiles: ['auth.test.ts'],
  source: { kind: 'fixture', data: {} }, gold: { readFiles: ['helper.ts'] },
};

function event(type: string, step: number, payload: Record<string, unknown>) {
  return { run_id: 'run', task_id: 'task', config_id: 'base', step, ts: new Date().toISOString(), type, payload };
}

const state = {
  task: 'fix auth', phase: 'context_loaded', loaded: 'few', unloadedCandidates: 'some',
  tests: { lastRun: 'failed', dirtySinceLastRun: false }, lastActions: [],
};

test('rejects incomplete routing evidence instead of silently weakening labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-invalid-'));
  const eventsPath = join(root, 'events.jsonl');
  const events = [
    event('run_start', 0, {}),
    event('candidates', 0, { candidates: [{ id: 'a', path: 'auth.ts' }] }),
    event('selection', 0, { selected: ['missing'] }),
    event('route', 0, { state, feasible: ['reason'] }),
    event('agent_end', 1, { termination_reason: 'error' }),
    event('run_end', 1, { outcome: 'error', termination_reason: 'error' }),
  ];
  await writeFile(eventsPath, events.map((item) => JSON.stringify(item)).join('\n'));
  await assert.rejects(buildRoutingDataset({ eventsPath, tasks: [task] }), /unknown candidate/);

  events[2] = event('selection', 0, { selected: [] });
  await writeFile(eventsPath, events.map((item) => JSON.stringify(item)).join('\n'));
  await assert.rejects(buildRoutingDataset({
    eventsPath, tasks: [task], snapshots: { async evaluate() { return { passed: false, exitCode: 1, durationMs: 1 }; } },
  }), /no preceding snapshot/);
});

test('builds objective routing labels from events and opaque snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-dataset-'));
  const eventsPath = join(root, 'events.jsonl'); const outputPath = join(root, 'cases.jsonl');
  const events = [
    event('run_start', 0, {}),
    event('candidates', 0, { candidates: [{ id: 'auth-id', path: 'auth.ts' }, { id: 'helper-id', path: 'helper.ts' }] }),
    event('selection', 0, { selected: ['helper-id'] }),
    event('snapshot', 0, { id: 'snap-0', initial: true }),
    event('route', 0, { state, feasible: ['reason', 'read_file'] }),
    event('tool_call', 1, { name: 'read_file', args: { path: 'auth.ts' }, ok: true }),
    event('snapshot', 1, { id: 'snap-1' }),
    event('route', 1, { state: { ...state, unloadedCandidates: 'none' }, feasible: ['reason', 'stop'] }),
    event('agent_end', 2, { visible_outcome: 'passed', termination_reason: 'stop' }),
    event('run_end', 2, { outcome: 'passed', termination_reason: 'stop' }),
  ];
  await writeFile(eventsPath, events.map((item) => JSON.stringify(item)).join('\n'));
  let evaluations = 0;
  const cases = await buildRoutingDataset({
    eventsPath, outputPath, tasks: [task],
    snapshots: { async evaluate({ snapshotId }) {
      evaluations++;
      return { passed: snapshotId === 'snap-1', exitCode: snapshotId === 'snap-1' ? 0 : 1, durationMs: 1 };
    } },
  });
  assert.equal(cases[0]!.labels.needsRetrieval, true);
  assert.equal(cases[0]!.labels.shouldStop, false);
  assert.equal(cases[1]!.labels.needsRetrieval, false);
  assert.equal(cases[1]!.labels.shouldStop, true);
  assert.deepEqual(cases[1]!.labels.validReadTargets, ['auth.ts', 'helper.ts']);
  assert.deepEqual(cases[0]!.candidatePaths, { 'auth-id': 'auth.ts', 'helper-id': 'helper.ts' });
  assert.equal(evaluations, 2);
  assert.equal((await readFile(outputPath, 'utf8')).trim().split('\n').length, 2);
});
