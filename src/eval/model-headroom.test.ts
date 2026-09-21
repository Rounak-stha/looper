import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeModelHeadroom, type TierRunObservation } from './model-headroom.js';

const observations: TierRunObservation[] = [
  { taskId: 'easy', tier: 'cheap', passed: true, visiblePassed: true, costUsd: 1, reasoningTokens: 10, steps: 2, wallClockMs: 10 },
  { taskId: 'easy', tier: 'strong', passed: true, visiblePassed: true, costUsd: 4, reasoningTokens: 20, steps: 2, wallClockMs: 20 },
  { taskId: 'hard', tier: 'cheap', passed: false, visiblePassed: false, costUsd: 1, reasoningTokens: 10, steps: 2, wallClockMs: 10 },
  { taskId: 'hard', tier: 'strong', passed: true, visiblePassed: true, costUsd: 4, reasoningTokens: 20, steps: 2, wallClockMs: 20 },
];
const tiers = [{ id: 'cheap', rank: 0 }, { id: 'strong', rank: 1 }];

test('analyzes always, cascade, and oracle policies over a complete cost matrix', () => {
  const report = analyzeModelHeadroom(observations, tiers);
  const policies = Object.fromEntries(report.policies.map((policy) => [policy.policy, policy]));
  assert.equal(policies.always_strongest!.meanCostUsd, 4);
  assert.equal(policies.always_cheapest!.passRate, 0.5);
  assert.equal(policies.oracle!.meanCostUsd, 2.5);
  assert.equal(policies.cascade!.meanCostUsd, 3);
  assert.equal(report.oracleCostSaving, 0.375);
  assert.ok(report.gapLeftFraction > 0);
});

test('aggregates repetitions before applying the pass threshold', () => {
  const repeated = [...observations,
    { ...observations[0]!, passed: false, visiblePassed: false },
    { ...observations[1]!, passed: true, visiblePassed: true },
    { ...observations[2]!, passed: false, visiblePassed: false },
    { ...observations[3]!, passed: true, visiblePassed: true },
  ];
  const report = analyzeModelHeadroom(repeated, tiers, 0.75);
  assert.equal(report.cells.find(({ taskId, tier }) => taskId === 'easy' && tier === 'cheap')!.passRate, 0.5);
  assert.equal(report.policies.find(({ policy }) => policy === 'oracle')!.meanCostUsd, 4);
});

test('rejects incomplete task by tier matrices', () => {
  assert.throws(() => analyzeModelHeadroom(observations.slice(0, -1), tiers), /Missing matrix cell/);
});
