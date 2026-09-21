import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateNoiseFloor, evaluateG0, evaluateG1, evaluateG2, evaluateG3, evaluateG4 } from './gates.js';
import type { RunSummary } from './report.js';

function run(taskId: string, passed: boolean, values: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: `${taskId}-${passed}`, taskId, configId: 'c', outcome: passed ? 'passed' : 'failed',
    visibleOutcome: passed ? 'passed' : 'failed', termination: 'stop', steps: 10, reasoningTokens: 100, costUsd: 1, wallClockMs: 10,
    reasoningCalls: 10, decisionCalls: 0, toolCalls: 5, retrievalIterations: 1,
    initialContextTokens: 0, dynamicContextChars: 0, truncatedToolOutputs: 0,
    escaped: false, reporting: {}, ...values,
  };
}

test('evaluates characterization and offline-selection gates', () => {
  assert.equal(evaluateG0({ candidateCount: 50, top5ShuffleOverlap: 0.8, meanInjectionDisplacement: 1 }).passed, true);
  assert.equal(evaluateG1({
    armAllGoldRate: 0.8, baselineAllGoldRate: 0.7, referenceAllGoldRate: 0.85,
    armLatencyMs: 10, referenceLatencyMs: 100, armCostUsd: 0.01, referenceCostUsd: 0.05,
  }).passed, true);
});

test('G2 requires noninferior pass rate and paired efficiency gain', () => {
  const baseline = [run('a', false), run('b', true)];
  const arm = [run('a', true, { reasoningTokens: 70 }), run('b', true, { reasoningTokens: 70 })];
  const result = evaluateG2(baseline, arm, 0.1);
  assert.equal(result.passed, true);
  assert.equal(result.criteria.efficiency_reduction!.value, 0.3);
});

test('G3 combines replay safety with online work reduction', () => {
  const baseline = [run('a', true), run('b', true)];
  const arm = baseline.map((item) => ({ ...item, steps: 8, reasoningCalls: 8 }));
  assert.equal(evaluateG3(baseline, arm, {
    decisions: 10, stopNegativeDecisions: 10, stopPositiveDecisions: 0,
    retrievalPositiveDecisions: 0, falseStopRate: 0.05, falseContinueRate: 0,
    missedRetrievalRate: 0, invalidDecisionRate: 0, readDecisions: 0,
    invalidReadTargetRate: 0, fallbackRate: 0,
  }, 0).passed, true);
});

test('G3 cannot pass without eligible false-stop examples', () => {
  const baseline = [run('a', true)];
  const arm = [{ ...run('a', true), steps: 1, reasoningCalls: 1 }];
  assert.equal(evaluateG3(baseline, arm, {
    decisions: 1, stopNegativeDecisions: 0, stopPositiveDecisions: 0,
    retrievalPositiveDecisions: 0, falseStopRate: 0, falseContinueRate: 0,
    missedRetrievalRate: 0, invalidDecisionRate: 0, readDecisions: 0,
    invalidReadTargetRate: 0, fallbackRate: 0,
  }, 0).passed, false);
});

test('G4 preserves equal pass rate and routing headroom', () => {
  assert.equal(evaluateG4({
    strongestPassRate: 0.8, oraclePassRate: 0.8, cascadePassRate: 0.8, noiseFloor: 0.05,
    strongestCostUsd: 10, oracleCostUsd: 7, cascadeCostUsd: 9,
  }).passed, true);
});

test('noise floor uses paired repeated-run pass fractions', () => {
  assert.equal(estimateNoiseFloor([run('a', true), run('b', false)], [run('a', false), run('b', false)]), 0.5);
});

test('online gates reject incomplete paired task coverage', () => {
  assert.throws(() => evaluateG2([run('a', true), run('b', true)], [run('a', true)], 0), /Incomplete/);
});
