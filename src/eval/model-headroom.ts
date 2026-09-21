export interface TierDefinition {
  id: string;
  rank: number;
}

export interface TierRunObservation {
  taskId: string;
  tier: string;
  passed: boolean;
  visiblePassed: boolean;
  costUsd: number;
  reasoningTokens: number;
  steps: number;
  wallClockMs: number;
}

export interface TierTaskCell {
  taskId: string;
  tier: string;
  runs: number;
  passRate: number;
  visiblePassRate: number;
  meanCostUsd: number;
  meanReasoningTokens: number;
  meanSteps: number;
  meanWallClockMs: number;
}

export interface RoutingPolicySummary {
  policy: 'always_strongest' | 'always_cheapest' | 'cascade' | 'oracle';
  tasks: number;
  passRate: number;
  meanCostUsd: number;
  meanReasoningTokens: number;
  meanSteps: number;
  meanWallClockMs: number;
}

export interface ModelHeadroomReport {
  tiers: string[];
  tasks: string[];
  cells: TierTaskCell[];
  policies: RoutingPolicySummary[];
  oracleCostSaving: number;
  cascadeCostSaving: number;
  cascadeCapturedFraction: number;
  gapLeftFraction: number;
}

export function tierObservationsFromRuns(
  runs: ReadonlyArray<{
    taskId: string; tier?: string; outcome: string; visibleOutcome: string;
    costUsd: number; reasoningTokens: number; steps: number; wallClockMs: number;
  }>,
): TierRunObservation[] {
  return runs.map((run) => {
    if (!run.tier) throw new Error(`Run '${run.taskId}' has no reporting tier`);
    return {
      taskId: run.taskId, tier: run.tier, passed: run.outcome === 'passed',
      visiblePassed: run.visibleOutcome === 'passed', costUsd: run.costUsd,
      reasoningTokens: run.reasoningTokens, steps: run.steps, wallClockMs: run.wallClockMs,
    };
  });
}

/**
 * Replays static, cascade, and oracle policies over a fully observed task × tier matrix.
 * Cascade escalation is based only on visible pass signals. Oracle uses authoritative pass
 * rates and is therefore an upper-bound evaluation control, never an online policy.
 */
export function analyzeModelHeadroom(
  observations: TierRunObservation[], tiers: TierDefinition[], passThreshold = 0.5,
): ModelHeadroomReport {
  if (!(passThreshold > 0 && passThreshold <= 1)) throw new Error('Pass threshold must be in (0, 1]');
  const orderedTiers = validateTiers(tiers);
  const cells = buildCells(observations);
  const tasks = [...new Set(observations.map(({ taskId }) => taskId))].sort();
  if (!tasks.length) throw new Error('Model headroom requires observations');
  const matrix = new Map(cells.map((cell) => [`${cell.taskId}\0${cell.tier}`, cell]));
  for (const taskId of tasks) for (const tier of orderedTiers) {
    if (!matrix.has(`${taskId}\0${tier.id}`)) throw new Error(`Missing matrix cell for task '${taskId}', tier '${tier.id}'`);
  }
  const cheapest = orderedTiers[0]!; const strongest = orderedTiers.at(-1)!;
  const strongestPolicy = staticPolicy('always_strongest', tasks.map((taskId) => matrix.get(`${taskId}\0${strongest.id}`)!));
  const cheapestPolicy = staticPolicy('always_cheapest', tasks.map((taskId) => matrix.get(`${taskId}\0${cheapest.id}`)!));
  const oraclePolicy = summarizePolicy('oracle', tasks.map((taskId) => {
    const choices = orderedTiers.map(({ id }) => matrix.get(`${taskId}\0${id}`)!);
    return choices.find(({ passRate }) => passRate >= passThreshold) ?? choices.at(-1)!;
  }).map(singleAttempt));
  const cascadePolicy = summarizePolicy('cascade', tasks.map((taskId) => {
    const attempts: PolicyTaskResult[] = [];
    for (const { id } of orderedTiers) {
      const cell = matrix.get(`${taskId}\0${id}`)!;
      attempts.push(singleAttempt(cell));
      if (cell.visiblePassRate >= passThreshold) break;
    }
    return combineAttempts(attempts);
  }));
  const oracleCostSaving = reduction(strongestPolicy.meanCostUsd, oraclePolicy.meanCostUsd);
  const cascadeCostSaving = reduction(strongestPolicy.meanCostUsd, cascadePolicy.meanCostUsd);
  return {
    tiers: orderedTiers.map(({ id }) => id), tasks, cells,
    policies: [strongestPolicy, cheapestPolicy, cascadePolicy, oraclePolicy],
    oracleCostSaving, cascadeCostSaving,
    cascadeCapturedFraction: oracleCostSaving > 0 ? cascadeCostSaving / oracleCostSaving : 0,
    gapLeftFraction: oracleCostSaving > 0 ? (oracleCostSaving - cascadeCostSaving) / oracleCostSaving : 0,
  };
}

function buildCells(observations: TierRunObservation[]): TierTaskCell[] {
  const groups = new Map<string, TierRunObservation[]>();
  for (const item of observations) {
    validateObservation(item);
    const key = `${item.taskId}\0${item.tier}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(item);
  }
  return [...groups.values()].map((items) => ({
    taskId: items[0]!.taskId, tier: items[0]!.tier, runs: items.length,
    passRate: mean(items.map(({ passed }) => Number(passed))),
    visiblePassRate: mean(items.map(({ visiblePassed }) => Number(visiblePassed))),
    meanCostUsd: mean(items.map(({ costUsd }) => costUsd)),
    meanReasoningTokens: mean(items.map(({ reasoningTokens }) => reasoningTokens)),
    meanSteps: mean(items.map(({ steps }) => steps)),
    meanWallClockMs: mean(items.map(({ wallClockMs }) => wallClockMs)),
  })).sort((a, b) => a.taskId.localeCompare(b.taskId) || a.tier.localeCompare(b.tier));
}

type PolicyTaskResult = { pass: number; cost: number; tokens: number; steps: number; latency: number };
function singleAttempt(cell: TierTaskCell): PolicyTaskResult {
  return { pass: cell.passRate, cost: cell.meanCostUsd, tokens: cell.meanReasoningTokens, steps: cell.meanSteps, latency: cell.meanWallClockMs };
}
function combineAttempts(attempts: PolicyTaskResult[]): PolicyTaskResult {
  const last = attempts.at(-1)!;
  return {
    pass: last.pass,
    cost: sum(attempts.map(({ cost }) => cost)), tokens: sum(attempts.map(({ tokens }) => tokens)),
    steps: sum(attempts.map(({ steps }) => steps)), latency: sum(attempts.map(({ latency }) => latency)),
  };
}
function staticPolicy(policy: 'always_strongest' | 'always_cheapest', cells: TierTaskCell[]): RoutingPolicySummary {
  return summarizePolicy(policy, cells.map(singleAttempt));
}
function summarizePolicy(policy: RoutingPolicySummary['policy'], tasks: PolicyTaskResult[]): RoutingPolicySummary {
  return {
    policy, tasks: tasks.length, passRate: mean(tasks.map(({ pass }) => pass)),
    meanCostUsd: mean(tasks.map(({ cost }) => cost)), meanReasoningTokens: mean(tasks.map(({ tokens }) => tokens)),
    meanSteps: mean(tasks.map(({ steps }) => steps)), meanWallClockMs: mean(tasks.map(({ latency }) => latency)),
  };
}
function validateTiers(tiers: TierDefinition[]): TierDefinition[] {
  if (tiers.length < 2) throw new Error('Model headroom requires at least two tiers');
  if (new Set(tiers.map(({ id }) => id)).size !== tiers.length) throw new Error('Tier IDs must be unique');
  if (new Set(tiers.map(({ rank }) => rank)).size !== tiers.length) throw new Error('Tier ranks must be unique');
  return [...tiers].sort((a, b) => a.rank - b.rank);
}
function validateObservation(item: TierRunObservation): void {
  if (!item.taskId || !item.tier) throw new Error('Tier observations require task and tier IDs');
  if ([item.costUsd, item.reasoningTokens, item.steps, item.wallClockMs].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Tier observation metrics must be finite and non-negative');
  }
}
function reduction(baseline: number, value: number): number { return baseline > 0 ? (baseline - value) / baseline : 0; }
function mean(values: number[]): number { return sum(values) / values.length; }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
