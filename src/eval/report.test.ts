import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { aggregateRuns, compareRuns, pairedPassRateInterval, summarizeRunLog, type RunSummary } from './report.js';

test('summarizes event logs without provider-specific fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-'));
  const path = join(root, 'run.jsonl');
  const base = { run_id: 'r1', task_id: 't1', config_id: 'c1', step: 1, ts: new Date().toISOString() };
  await writeFile(path, [
    { ...base, type: 'run_start', payload: {} },
    { ...base, type: 'llm_call', payload: { cost: 0.2 } },
    { ...base, type: 'decision_call', payload: { cost_usd: 0.01 } },
    { ...base, type: 'selection', payload: {
      context_tokens: 50_000, loaded_context_tokens: 12_000, presented_context_tokens: 12,
    } },
    { ...base, type: 'tool_call', payload: { context_chars: 20, context_truncated: true } },
    { ...base, type: 'escape', payload: {} },
    { ...base, type: 'agent_end', payload: { visible_outcome: 'passed', termination_reason: 'stop' } },
    { ...base, type: 'run_end', payload: { outcome: 'passed', termination_reason: 'stop', totals: { steps: 2, reasoning_tokens: 30 } } },
  ].map((event) => JSON.stringify(event)).join('\n'));
  const runs = await summarizeRunLog(path);
  assert.ok(Math.abs(runs[0]!.costUsd - 0.21) < 1e-12);
  const aggregate = aggregateRuns(runs);
  assert.ok(Math.abs(Number(aggregate.mean_cost_usd) - 0.21) < 1e-12);
  assert.deepEqual({ ...aggregate, mean_cost_usd: 0.21 }, {
    runs: 1, task_type: 'unknown', tasks: 1, pass_rate: 1, mean_steps: 2, mean_reasoning_tokens: 30,
    mean_cost_usd: 0.21, mean_wall_clock_ms: 0, mean_reasoning_calls: 1,
    mean_decision_calls: 1, mean_tool_calls: 1, mean_retrieval_iterations: 0,
    mean_initial_context_tokens: 12, mean_selection_input_tokens: 0,
    mean_selection_output_tokens: 0, mean_selection_latency_ms: 0, mean_dynamic_context_chars: 20,
    mean_truncated_tool_outputs: 1, escape_rate: 1,
  });
});

test('rejects malformed terminal metrics instead of coercing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-invalid-'));
  const path = join(root, 'run.jsonl');
  const base = { run_id: 'r1', task_id: 't1', config_id: 'c1', step: 0, ts: new Date().toISOString() };
  await writeFile(path, [
    { ...base, type: 'run_start', payload: {} },
    { ...base, type: 'agent_end', payload: { visible_outcome: 'unknown', termination_reason: 'error' } },
    { ...base, type: 'run_end', payload: { outcome: 'maybe', termination_reason: 'error', totals: { steps: -1, reasoning_tokens: 0 } } },
  ].map((event) => JSON.stringify(event)).join('\n'));
  await assert.rejects(summarizeRunLog(path), /outcome is invalid/);
});

test('compares majority task outcomes against a baseline', () => {
  const run = (taskId: string, outcome: string): RunSummary => ({
    runId: `${taskId}-${outcome}`, taskId, configId: 'c', outcome, visibleOutcome: outcome, termination: 'stop',
    steps: 1, reasoningTokens: 1, costUsd: 0, wallClockMs: 1, reasoningCalls: 1,
    decisionCalls: 0, toolCalls: 1, retrievalIterations: 0, initialContextTokens: 0,
    dynamicContextChars: 0, truncatedToolOutputs: 0, escaped: false, reporting: {},
  });
  const comparison = compareRuns(
    [run('fixed', 'failed'), run('broke', 'passed'), run('same', 'passed')],
    [run('fixed', 'passed'), run('broke', 'failed'), run('same', 'passed')],
  );
  assert.deepEqual(comparison.fixed, ['fixed']);
  assert.deepEqual(comparison.broke, ['broke']);
  assert.deepEqual(comparison.unchangedPass, ['same']);
  assert.equal(comparison.passRateDifference, 0);
  assert.equal(comparison.complete, true);
});

test('paired comparison reports coverage and strict mode rejects omissions', () => {
  const run = (taskId: string): RunSummary => ({
    runId: taskId, taskId, configId: 'c', outcome: 'passed', visibleOutcome: 'passed', termination: 'stop',
    steps: 1, reasoningTokens: 1, costUsd: 0, wallClockMs: 1, reasoningCalls: 1,
    decisionCalls: 0, toolCalls: 0, retrievalIterations: 0, initialContextTokens: 0,
    dynamicContextChars: 0, truncatedToolOutputs: 0, escaped: false, reporting: {},
  });
  const comparison = compareRuns([run('a'), run('b')], [run('a')]);
  assert.deepEqual(comparison.missingFromArm, ['b']);
  assert.equal(comparison.complete, false);
  assert.throws(() => compareRuns([run('a'), run('b')], [run('a')], { requireCompleteCoverage: true }), /Incomplete/);
  const repetitions = compareRuns([run('a'), run('a')], [run('a')]);
  assert.deepEqual(repetitions.repetitionMismatches, [{ taskId: 'a', baselineRuns: 2, armRuns: 1 }]);
  assert.throws(() => compareRuns([run('a'), run('a')], [run('a')], { requireCompleteCoverage: true }), /repetition mismatches/);
});

test('reports reject pooling or comparing distinct task types', () => {
  const run = (taskType: string): RunSummary => ({
    runId: taskType, taskId: taskType, configId: 'c', outcome: 'passed', visibleOutcome: 'unknown', termination: 'stop',
    steps: 1, reasoningTokens: 0, costUsd: 0, wallClockMs: 1, reasoningCalls: 0,
    decisionCalls: 0, toolCalls: 0, retrievalIterations: 0, initialContextTokens: 0,
    dynamicContextChars: 0, truncatedToolOutputs: 0, escaped: false, taskType, reporting: {},
  });
  assert.throws(() => aggregateRuns([run('T-fix'), run('T-issue')]), /mixed task types/);
  assert.throws(() => compareRuns([run('T-fix')], [run('T-issue')]), /mixed task types/);
});

test('paired bootstrap interval is deterministic', () => {
  const run = (taskId: string, outcome: string): RunSummary => ({
    runId: `${taskId}-${outcome}`, taskId, configId: 'c', outcome, visibleOutcome: outcome, termination: 'stop',
    steps: 1, reasoningTokens: 1, costUsd: 0, wallClockMs: 1, reasoningCalls: 1,
    decisionCalls: 0, toolCalls: 1, retrievalIterations: 0, initialContextTokens: 0,
    dynamicContextChars: 0, truncatedToolOutputs: 0, escaped: false, reporting: {},
  });
  const baseline = [run('a', 'failed'), run('b', 'failed'), run('c', 'passed')];
  const arm = [run('a', 'passed'), run('b', 'failed'), run('c', 'passed')];
  const first = pairedPassRateInterval(baseline, arm, { samples: 1_000, seed: 9 });
  const second = pairedPassRateInterval(baseline, arm, { samples: 1_000, seed: 9 });
  assert.deepEqual(first, second);
  assert.equal(first.estimate, 1 / 3);
  assert.ok(first.low <= first.estimate && first.high >= first.estimate);
});
