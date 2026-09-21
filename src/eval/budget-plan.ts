export interface OnlineBudgetPlanInput {
  tasks: number;
  runsPerTask: number;
  arms: number;
  tiers?: number;
  p90CostPerRunUsd: number;
  capUsd: number;
  spentUsd: number;
  reservePct: number;
  minimumTasks?: number;
}

export interface OnlineBudgetPlan {
  plannedRuns: number;
  plannedCostUsd: number;
  availableUsd: number;
  affordable: boolean;
  reason?: 'below_minimum_tasks' | 'insufficient_budget';
}

/** Pure preflight calculation; actual calls remain guarded by the append-only ledger. */
export function planOnlineBudget(input: OnlineBudgetPlanInput): OnlineBudgetPlan {
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  }
  if (![input.tasks, input.runsPerTask, input.arms, input.tiers ?? 1].every(Number.isInteger)) {
    throw new Error('Task, repetition, arm, and tier counts must be integers');
  }
  if (input.reservePct >= 100) throw new Error('reservePct must be below 100');
  const minimumTasks = input.minimumTasks ?? 20;
  const plannedRuns = input.tasks * input.runsPerTask * input.arms * (input.tiers ?? 1);
  const plannedCostUsd = plannedRuns * input.p90CostPerRunUsd;
  const spendableCap = input.capUsd * (1 - input.reservePct / 100);
  const availableUsd = Math.max(0, spendableCap - input.spentUsd);
  const reason = input.tasks < minimumTasks ? 'below_minimum_tasks' as const
    : plannedCostUsd > availableUsd ? 'insufficient_budget' as const : undefined;
  return {
    plannedRuns, plannedCostUsd, availableUsd, affordable: reason === undefined,
    ...(reason ? { reason } : {}),
  };
}
