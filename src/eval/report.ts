import { readFile } from 'node:fs/promises';
import type { RunEvent } from '../core/events.js';
import { groupAndValidateRunEvents } from '../core/event-validation.js';

export interface RunSummary {
  runId: string;
  taskId: string;
  configId: string;
  outcome: string;
  visibleOutcome: string;
  termination: string;
  steps: number;
  reasoningTokens: number;
  costUsd: number;
  wallClockMs: number;
  reasoningCalls: number;
  decisionCalls: number;
  toolCalls: number;
  retrievalIterations: number;
  initialContextTokens: number;
  selectionInputTokens?: number;
  selectionOutputTokens?: number;
  selectionLatencyMs?: number;
  dynamicContextChars: number;
  truncatedToolOutputs: number;
  escaped: boolean;
  taskType?: string;
  tier?: string;
  reporting: Record<string, string>;
}

export async function summarizeRunLog(path: string): Promise<RunSummary[]> {
  const content = await readFile(path, 'utf8');
  const events = content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunEvent);
  const groups = groupAndValidateRunEvents(events);
  return [...groups.values()].map(summarize).sort((a, b) => a.runId.localeCompare(b.runId));
}

function summarize(events: RunEvent[]): RunSummary {
  const first = events[0]!;
  const end = [...events].reverse().find(({ type }) => type === 'run_end');
  const llm = events.filter(({ type }) => type === 'llm_call');
  const decisions = events.filter(({ type }) => type === 'decision_call');
  const payload = end?.payload ?? {};
  const selection = events.find(({ type }) => type === 'selection')?.payload ?? {};
  const toolCalls = events.filter(({ type }) => type === 'tool_call');
  const totals = requiredObject(payload.totals, `Run '${first.run_id}' totals`);
  const outcome = allowedText(payload.outcome, ['passed', 'failed', 'error'], `Run '${first.run_id}' outcome`);
  const visibleOutcome = allowedText(payload.visible_outcome ?? 'unknown', ['passed', 'failed', 'unknown'], `Run '${first.run_id}' visible outcome`);
  const termination = allowedText(payload.termination_reason, ['stop', 'budget', 'error', 'infrastructure_error'], `Run '${first.run_id}' termination`);
  return {
    runId: first.run_id, taskId: first.task_id, configId: first.config_id,
    outcome, visibleOutcome, termination,
    steps: nonnegativeInteger(totals.steps, 'steps'),
    reasoningTokens: finiteNonnegativeRequired(totals.reasoning_tokens, 'reasoning_tokens'),
    costUsd: [...llm, ...decisions].reduce((sum, event) => sum + eventCost(event.payload), 0),
    wallClockMs: totals.wall_clock_ms === undefined
      ? elapsed(events) : finiteNonnegativeRequired(totals.wall_clock_ms, 'wall_clock_ms'),
    reasoningCalls: llm.length,
    decisionCalls: decisions.length,
    toolCalls: toolCalls.length,
    retrievalIterations: events.filter(({ type, payload }) => type === 'route'
      && ['retrieve_context', 'read_file'].includes(String(payload.action))).length,
    initialContextTokens: finiteNonnegative(selection.presented_context_tokens
      ?? (typeof selection.context_chars === 'number' ? Math.ceil(selection.context_chars / 4) : undefined)
      ?? selection.loaded_context_tokens ?? selection.context_tokens),
    selectionInputTokens: selectionUsage(selection).input,
    selectionOutputTokens: selectionUsage(selection).output,
    selectionLatencyMs: selectionUsage(selection).latencyMs,
    dynamicContextChars: toolCalls.reduce((sum, event) => sum + finiteNonnegative(event.payload.context_chars), 0),
    truncatedToolOutputs: toolCalls.filter(({ payload }) => payload.context_truncated === true).length,
    escaped: events.some(({ type }) => type === 'escape'),
    ...(taskMetadata(payload).type ? { taskType: taskMetadata(payload).type } : {}),
    ...(taskMetadata(payload).reporting.tier ? { tier: taskMetadata(payload).reporting.tier } : {}),
    reporting: taskMetadata(payload).reporting,
  };
}

export function aggregateRuns(runs: RunSummary[]): Record<string, unknown> {
  const taskTypes = [...new Set(runs.map(({ taskType }) => taskType ?? 'unknown'))].sort();
  if (taskTypes.length > 1) throw new Error(`Cannot aggregate mixed task types: ${taskTypes.join(', ')}`);
  return {
    runs: runs.length,
    task_type: taskTypes[0] ?? 'unknown',
    tasks: new Set(runs.map(({ taskId }) => taskId)).size,
    pass_rate: mean(runs.map(({ outcome }) => Number(outcome === 'passed'))),
    mean_steps: mean(runs.map(({ steps }) => steps)),
    mean_reasoning_tokens: mean(runs.map(({ reasoningTokens }) => reasoningTokens)),
    mean_cost_usd: mean(runs.map(({ costUsd }) => costUsd)),
    mean_wall_clock_ms: mean(runs.map(({ wallClockMs }) => wallClockMs)),
    mean_reasoning_calls: mean(runs.map(({ reasoningCalls }) => reasoningCalls)),
    mean_decision_calls: mean(runs.map(({ decisionCalls }) => decisionCalls)),
    mean_tool_calls: mean(runs.map(({ toolCalls }) => toolCalls)),
    mean_retrieval_iterations: mean(runs.map(({ retrievalIterations }) => retrievalIterations)),
    mean_initial_context_tokens: mean(runs.map(({ initialContextTokens }) => initialContextTokens)),
    mean_selection_input_tokens: mean(runs.map(({ selectionInputTokens }) => selectionInputTokens ?? 0)),
    mean_selection_output_tokens: mean(runs.map(({ selectionOutputTokens }) => selectionOutputTokens ?? 0)),
    mean_selection_latency_ms: mean(runs.map(({ selectionLatencyMs }) => selectionLatencyMs ?? 0)),
    mean_dynamic_context_chars: mean(runs.map(({ dynamicContextChars }) => dynamicContextChars)),
    mean_truncated_tool_outputs: mean(runs.map(({ truncatedToolOutputs }) => truncatedToolOutputs)),
    escape_rate: mean(runs.map(({ escaped }) => Number(escaped))),
  };
}

export interface PairingCoverage {
  baselineTasks: number;
  armTasks: number;
  commonTasks: number;
  missingFromBaseline: string[];
  missingFromArm: string[];
  repetitionMismatches: Array<{ taskId: string; baselineRuns: number; armRuns: number }>;
  complete: boolean;
}

export interface PairedComparison extends PairingCoverage {
  fixed: string[];
  broke: string[];
  unchangedPass: string[];
  unchangedFail: string[];
  baselinePassRate: number;
  armPassRate: number;
  passRateDifference: number;
}

/** Compares per-task majority outcomes; ties are deliberately treated as failures. */
export function compareRuns(
  baseline: RunSummary[], arm: RunSummary[], options: { requireCompleteCoverage?: boolean } = {},
): PairedComparison {
  assertCompatibleTaskTypes(baseline, arm);
  const baselineRates = taskPassRates(baseline);
  const armRates = taskPassRates(arm);
  const coverage = runPairingCoverage(baseline, arm);
  if (options.requireCompleteCoverage && !coverage.complete) throw incompleteCoverageError(coverage);
  const common = [...baselineRates.keys()].filter((id) => armRates.has(id)).sort();
  const fixed: string[] = []; const broke: string[] = [];
  const unchangedPass: string[] = []; const unchangedFail: string[] = [];
  for (const id of common) {
    const baselinePassed = baselineRates.get(id)! > 0.5;
    const armPassed = armRates.get(id)! > 0.5;
    if (!baselinePassed && armPassed) fixed.push(id);
    else if (baselinePassed && !armPassed) broke.push(id);
    else if (baselinePassed) unchangedPass.push(id);
    else unchangedFail.push(id);
  }
  return {
    ...coverage, fixed, broke, unchangedPass, unchangedFail,
    baselinePassRate: mean(common.map((id) => baselineRates.get(id)!)),
    armPassRate: mean(common.map((id) => armRates.get(id)!)),
    passRateDifference: mean(common.map((id) => armRates.get(id)! - baselineRates.get(id)!)),
  };
}

export interface BootstrapInterval {
  estimate: number;
  low: number;
  high: number;
  confidence: number;
  samples: number;
  commonTasks: number;
}

/** Paired bootstrap over tasks, retaining repeated-run pass fractions within each task. */
export function pairedPassRateInterval(
  baseline: RunSummary[], arm: RunSummary[],
  options: { samples?: number; confidence?: number; seed?: number; requireCompleteCoverage?: boolean } = {},
): BootstrapInterval {
  assertCompatibleTaskTypes(baseline, arm);
  const samples = options.samples ?? 10_000;
  const confidence = options.confidence ?? 0.95;
  if (!Number.isInteger(samples) || samples < 1) throw new Error('Bootstrap samples must be a positive integer');
  if (!(confidence > 0 && confidence < 1)) throw new Error('Bootstrap confidence must be between 0 and 1');
  const baselineRates = taskPassRates(baseline);
  const armRates = taskPassRates(arm);
  const coverage = runPairingCoverage(baseline, arm);
  if (options.requireCompleteCoverage && !coverage.complete) throw incompleteCoverageError(coverage);
  const differences = [...baselineRates.keys()].filter((id) => armRates.has(id)).sort()
    .map((id) => armRates.get(id)! - baselineRates.get(id)!);
  if (!differences.length) throw new Error('No common tasks to compare');
  const random = mulberry32(options.seed ?? 1);
  const distribution = Array.from({ length: samples }, () => {
    let sum = 0;
    for (let index = 0; index < differences.length; index++) {
      sum += differences[Math.floor(random() * differences.length)]!;
    }
    return sum / differences.length;
  }).sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return {
    estimate: mean(differences), low: percentile(distribution, tail), high: percentile(distribution, 1 - tail),
    confidence, samples, commonTasks: differences.length,
  };
}

export function aggregateBy(runs: RunSummary[], dimension: 'taskType' | string): Record<string, Record<string, unknown>> {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const value = dimension === 'taskType' ? run.taskType : run.reporting[dimension];
    const key = value ?? 'unknown';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(run);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => [key, aggregateRuns(values)]));
}

export function pairingCoverage(baselineIds: Iterable<string>, armIds: Iterable<string>): PairingCoverage {
  const baseline = new Set(baselineIds); const arm = new Set(armIds);
  const missingFromBaseline = [...arm].filter((id) => !baseline.has(id)).sort();
  const missingFromArm = [...baseline].filter((id) => !arm.has(id)).sort();
  return {
    baselineTasks: baseline.size, armTasks: arm.size,
    commonTasks: [...baseline].filter((id) => arm.has(id)).length,
    missingFromBaseline, missingFromArm, repetitionMismatches: [],
    complete: missingFromBaseline.length === 0 && missingFromArm.length === 0,
  };
}

export function runPairingCoverage(baseline: RunSummary[], arm: RunSummary[]): PairingCoverage {
  const baselineCounts = taskCounts(baseline); const armCounts = taskCounts(arm);
  const coverage = pairingCoverage(baselineCounts.keys(), armCounts.keys());
  const repetitionMismatches = [...baselineCounts.keys()].filter((id) => armCounts.has(id))
    .filter((id) => baselineCounts.get(id) !== armCounts.get(id)).sort()
    .map((taskId) => ({ taskId, baselineRuns: baselineCounts.get(taskId)!, armRuns: armCounts.get(taskId)! }));
  return { ...coverage, repetitionMismatches, complete: coverage.complete && repetitionMismatches.length === 0 };
}

function assertCompatibleTaskTypes(baseline: RunSummary[], arm: RunSummary[]): void {
  const types = new Set([...baseline, ...arm].map(({ taskType }) => taskType ?? 'unknown'));
  if (types.size > 1) throw new Error(`Cannot compare mixed task types: ${[...types].sort().join(', ')}`);
}

function taskCounts(runs: RunSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.taskId, (counts.get(run.taskId) ?? 0) + 1);
  return counts;
}

function incompleteCoverageError(coverage: PairingCoverage): Error {
  const repeats = coverage.repetitionMismatches
    .map(({ taskId, baselineRuns, armRuns }) => `${taskId}:${baselineRuns}/${armRuns}`).join(', ');
  return new Error(`Incomplete paired task coverage: missing from baseline [${coverage.missingFromBaseline.join(', ')}]; missing from arm [${coverage.missingFromArm.join(', ')}]; repetition mismatches [${repeats}]`);
}

function finiteNonnegative(value: unknown): number {
  return value === undefined ? 0 : finiteNonnegativeRequired(value, 'optional metric');
}

function finiteNonnegativeRequired(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid non-negative metric '${name}'`);
  return value;
}

function nonnegativeInteger(value: unknown, name: string): number {
  const parsed = finiteNonnegativeRequired(value, name);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid integer metric '${name}'`);
  return parsed;
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function allowedText(value: unknown, allowed: readonly string[], name: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${name} is invalid`);
  return value;
}

function selectionUsage(payload: Record<string, unknown>): { input: number; output: number; latencyMs: number } {
  const meta = payload.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { input: 0, output: 0, latencyMs: 0 };
  const record = meta as Record<string, unknown>;
  const usages = [record.usage, record.choiceUsage, record.noulUsage].filter((value) =>
    value && typeof value === 'object' && !Array.isArray(value)) as Array<Record<string, unknown>>;
  return {
    input: usages.reduce((sum, usage) => sum + finiteNonnegative(usage.input_tokens), 0),
    output: usages.reduce((sum, usage) => sum + finiteNonnegative(usage.output_tokens), 0),
    latencyMs: finiteNonnegative(record.latency_ms)
      + finiteNonnegative(record.choiceLatencyMs) + finiteNonnegative(record.noulLatencyMs),
  };
}

function eventCost(payload: Record<string, unknown>): number {
  return finiteNonnegativeRequired(payload.cost_usd ?? payload.cost, 'call cost');
}

function taskMetadata(payload: Record<string, unknown>): { type?: string; reporting: Record<string, string> } {
  const task = payload.task && typeof payload.task === 'object' ? payload.task as Record<string, unknown> : {};
  const reporting = task.reporting && typeof task.reporting === 'object' && !Array.isArray(task.reporting)
    ? Object.fromEntries(Object.entries(task.reporting as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
  return { ...(typeof task.type === 'string' ? { type: task.type } : {}), reporting };
}

function elapsed(events: RunEvent[]): number {
  if (events.length < 2) return 0;
  const first = Date.parse(events[0]!.ts); const last = Date.parse(events.at(-1)!.ts);
  return Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : 0;
}

function taskPassRates(runs: RunSummary[]): Map<string, number> {
  const grouped = new Map<string, number[]>();
  for (const run of runs) (grouped.get(run.taskId) ?? grouped.set(run.taskId, []).get(run.taskId)!)
    .push(Number(run.outcome === 'passed'));
  return new Map([...grouped].map(([id, values]) => [id, mean(values)]));
}

function percentile(sorted: number[], probability: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(probability * sorted.length)))]!;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
