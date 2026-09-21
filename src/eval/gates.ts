import type { RoutingReplayMetrics } from './routing-replay.js';
import { runPairingCoverage, type RunSummary } from './report.js';

export interface GateResult {
  gate: 'G0' | 'G1' | 'G2' | 'G3' | 'G4';
  passed: boolean;
  criteria: Record<string, { value: number | boolean; threshold: string; passed: boolean }>;
}

export function evaluateG0(input: {
  candidateCount: number; top5ShuffleOverlap: number; meanInjectionDisplacement: number;
}): GateResult {
  return gate('G0', {
    candidate_format: criterion(input.candidateCount >= 50, input.candidateCount, '>= 50 candidates'),
    shuffle_overlap: criterion(input.top5ShuffleOverlap >= 0.8, input.top5ShuffleOverlap, '>= 0.8'),
    injection_displacement: criterion(input.meanInjectionDisplacement <= 1, input.meanInjectionDisplacement, '<= 1'),
  });
}

export function evaluateG1(input: {
  armAllGoldRate: number; baselineAllGoldRate: number; referenceAllGoldRate: number;
  armLatencyMs: number; referenceLatencyMs: number; armCostUsd: number; referenceCostUsd: number;
}): GateResult {
  const latencyAdvantage = ratio(input.referenceLatencyMs, input.armLatencyMs);
  const costAdvantage = ratio(input.referenceCostUsd, input.armCostUsd);
  return gate('G1', {
    baseline_gain: criterion(input.armAllGoldRate - input.baselineAllGoldRate >= 0.1,
      input.armAllGoldRate - input.baselineAllGoldRate, '>= 0.10'),
    reference_gap: criterion(input.armAllGoldRate >= input.referenceAllGoldRate - 0.05,
      input.armAllGoldRate - input.referenceAllGoldRate, '>= -0.05'),
    efficiency_advantage: criterion(latencyAdvantage >= 10 || costAdvantage >= 10,
      Math.max(latencyAdvantage, costAdvantage), '>= 10x latency or cost'),
  });
}

export function evaluateG2(baseline: RunSummary[], arm: RunSummary[], noiseFloor: number): GateResult {
  validateNoiseFloor(noiseFloor);
  const paired = pairedMetrics(baseline, arm);
  return gate('G2', {
    fixed_not_less_than_broke: criterion(paired.fixed >= paired.broke, paired.fixed - paired.broke, '>= 0'),
    pass_noninferiority: criterion(paired.passRateDifference >= -noiseFloor,
      paired.passRateDifference, `>= -${noiseFloor}`),
    efficiency_reduction: criterion(Math.max(paired.costReduction, paired.tokenReduction) >= 0.2,
      Math.max(paired.costReduction, paired.tokenReduction), '>= 0.20 cost or tokens'),
  });
}

export function evaluateG3(
  baseline: RunSummary[], arm: RunSummary[], routing: RoutingReplayMetrics, noiseFloor: number,
): GateResult {
  validateNoiseFloor(noiseFloor);
  const paired = pairedMetrics(baseline, arm);
  return gate('G3', {
    false_stop_coverage: criterion(routing.stopNegativeDecisions > 0, routing.stopNegativeDecisions, '> 0 eligible decisions'),
    false_stop_rate: criterion(routing.stopNegativeDecisions > 0 && routing.falseStopRate <= 0.05, routing.falseStopRate, '<= 0.05'),
    work_reduction: criterion(Math.max(paired.stepReduction, paired.reasoningCallReduction) >= 0.15,
      Math.max(paired.stepReduction, paired.reasoningCallReduction), '>= 0.15 steps or reasoning calls'),
    pass_noninferiority: criterion(paired.passRateDifference >= -noiseFloor,
      paired.passRateDifference, `>= -${noiseFloor}`),
  });
}

export function evaluateG4(input: {
  strongestPassRate: number; oraclePassRate: number; cascadePassRate: number; noiseFloor: number;
  strongestCostUsd: number; oracleCostUsd: number; cascadeCostUsd: number;
}): GateResult {
  validateNoiseFloor(input.noiseFloor);
  const oracleSaving = reduction(input.strongestCostUsd, input.oracleCostUsd);
  const totalGap = input.strongestCostUsd - input.oracleCostUsd;
  const gapLeft = totalGap > 0 ? (input.cascadeCostUsd - input.oracleCostUsd) / totalGap : 0;
  return gate('G4', {
    oracle_equal_pass: criterion(input.oraclePassRate >= input.strongestPassRate - input.noiseFloor,
      input.oraclePassRate - input.strongestPassRate, `>= -${input.noiseFloor}`),
    oracle_cost_saving: criterion(oracleSaving >= 0.2, oracleSaving, '>= 0.20'),
    cascade_gap_left: criterion(gapLeft >= 0.5, gapLeft, '>= 0.50'),
    cascade_equal_pass: criterion(input.cascadePassRate >= input.strongestPassRate - input.noiseFloor,
      input.cascadePassRate - input.strongestPassRate, `>= -${input.noiseFloor}`),
  });
}

export function estimateNoiseFloor(first: RunSummary[], second: RunSummary[]): number {
  return Math.abs(pairedMetrics(first, second).passRateDifference);
}

function pairedMetrics(baseline: RunSummary[], arm: RunSummary[]): {
  passRateDifference: number; fixed: number; broke: number; costReduction: number;
  tokenReduction: number; stepReduction: number; reasoningCallReduction: number;
} {
  const left = taskMeans(baseline); const right = taskMeans(arm);
  const coverage = runPairingCoverage(baseline, arm);
  if (!coverage.complete) {
    throw new Error(`Incomplete paired task coverage: missing from baseline [${coverage.missingFromBaseline.join(', ')}]; missing from arm [${coverage.missingFromArm.join(', ')}]`);
  }
  const ids = [...left.keys()].filter((id) => right.has(id));
  if (!ids.length) throw new Error('No common tasks to compare');
  const values = ids.map((id) => ({ baseline: left.get(id)!, arm: right.get(id)! }));
  const fixed = values.filter(({ baseline, arm }) => baseline.pass <= 0.5 && arm.pass > 0.5).length;
  const broke = values.filter(({ baseline, arm }) => baseline.pass > 0.5 && arm.pass <= 0.5).length;
  return {
    passRateDifference: mean(values.map(({ baseline: b, arm: a }) => a.pass - b.pass)), fixed, broke,
    costReduction: pairedReduction(values, 'cost'), tokenReduction: pairedReduction(values, 'tokens'),
    stepReduction: pairedReduction(values, 'steps'), reasoningCallReduction: pairedReduction(values, 'reasoningCalls'),
  };
}

type TaskMeasures = { pass: number; cost: number; tokens: number; steps: number; reasoningCalls: number };
function taskMeans(runs: RunSummary[]): Map<string, TaskMeasures> {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) (groups.get(run.taskId) ?? groups.set(run.taskId, []).get(run.taskId)!).push(run);
  return new Map([...groups].map(([id, values]) => [id, {
    pass: mean(values.map((run) => Number(run.outcome === 'passed'))),
    cost: mean(values.map((run) => run.costUsd)), tokens: mean(values.map((run) => run.reasoningTokens)),
    steps: mean(values.map((run) => run.steps)), reasoningCalls: mean(values.map((run) => run.reasoningCalls)),
  }]));
}

function pairedReduction(values: Array<{ baseline: TaskMeasures; arm: TaskMeasures }>, key: keyof Omit<TaskMeasures, 'pass'>): number {
  return reduction(mean(values.map(({ baseline }) => baseline[key])), mean(values.map(({ arm }) => arm[key])));
}
function reduction(baseline: number, arm: number): number { return baseline > 0 ? (baseline - arm) / baseline : 0; }
function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return numerator > 0 ? Number.POSITIVE_INFINITY : 1;
  return numerator / denominator;
}
function criterion(passed: boolean, value: number | boolean, threshold: string) { return { value, threshold, passed }; }
function gate(id: GateResult['gate'], criteria: GateResult['criteria']): GateResult {
  return { gate: id, passed: Object.values(criteria).every(({ passed }) => passed), criteria };
}
function validateNoiseFloor(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Noise floor must be between 0 and 1');
}
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
