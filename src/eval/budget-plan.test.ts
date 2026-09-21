import assert from 'node:assert/strict';
import test from 'node:test';
import { planOnlineBudget } from './budget-plan.js';

test('plans online spend with reserve and tiers', () => {
  assert.deepEqual(planOnlineBudget({
    tasks: 20, runsPerTask: 2, arms: 3, tiers: 1,
    p90CostPerRunUsd: 0.1, capUsd: 20, spentUsd: 1, reservePct: 20,
  }), {
    plannedRuns: 120, plannedCostUsd: 12, availableUsd: 15, affordable: true,
  });
});

test('rejects plans below the minimum task count before claiming evidence', () => {
  assert.equal(planOnlineBudget({
    tasks: 10, runsPerTask: 2, arms: 1, p90CostPerRunUsd: 0.01,
    capUsd: 20, spentUsd: 0, reservePct: 40,
  }).reason, 'below_minimum_tasks');
});

test('rejects plans that exceed spendable credits', () => {
  assert.equal(planOnlineBudget({
    tasks: 20, runsPerTask: 2, arms: 2, p90CostPerRunUsd: 1,
    capUsd: 50, spentUsd: 5, reservePct: 40,
  }).reason, 'insufficient_budget');
});
