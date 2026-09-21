import { readFile } from 'node:fs/promises';

export interface SelectionRunRecord {
  taskId: string;
  selector: string;
  candidateCount: number;
  selectedCount: number;
  candidateRecall: number;
  recall: number;
  precision: number;
  allGoldSelected: boolean;
  contextTokens: number;
  latencyMs: number;
  candidateGenerationMs: number;
}

export interface SelectionSummary {
  selector: string;
  tasks: number;
  candidateCount: number;
  selectedCount: number;
  candidateRecall: number;
  recall: number;
  precision: number;
  allGoldSelectedRate: number;
  meanContextTokens: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  meanCandidateGenerationMs: number;
}

export async function loadSelectionLog(path: string): Promise<SelectionRunRecord[]> {
  const records = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(parseSelectionRecord);
  const identities = new Set<string>();
  for (const record of records) {
    const identity = `${record.selector}\0${record.taskId}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate selection result for selector '${record.selector}' and task '${record.taskId}'`);
    }
    identities.add(identity);
  }
  return records;
}

export async function summarizeSelectionLog(path: string): Promise<SelectionSummary[]> {
  const records = await loadSelectionLog(path);
  const groups = new Map<string, SelectionRunRecord[]>();
  for (const record of records) (groups.get(record.selector) ?? groups.set(record.selector, []).get(record.selector)!).push(record);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([selector, values]) => ({
    selector, tasks: values.length,
    candidateCount: mean(values.map((value) => value.candidateCount)),
    selectedCount: mean(values.map((value) => value.selectedCount)),
    candidateRecall: mean(values.map((value) => value.candidateRecall)),
    recall: mean(values.map((value) => value.recall)),
    precision: mean(values.map((value) => value.precision)),
    allGoldSelectedRate: mean(values.map((value) => Number(value.allGoldSelected))),
    meanContextTokens: mean(values.map((value) => value.contextTokens)),
    meanLatencyMs: mean(values.map((value) => value.latencyMs)),
    p95LatencyMs: percentile(values.map((value) => value.latencyMs), 0.95),
    meanCandidateGenerationMs: mean(values.map((value) => value.candidateGenerationMs)),
  }));
}

export function compareSelectionRecords(
  baseline: SelectionRunRecord[], arm: SelectionRunRecord[], options: { requireCompleteCoverage?: boolean } = {},
): {
  baselineTasks: number;
  armTasks: number;
  commonTasks: number;
  missingFromBaseline: string[];
  missingFromArm: string[];
  complete: boolean;
  allGoldRateDifference: number;
  recallDifference: number;
  contextTokenDifference: number;
  latencyRatio: number;
  fixed: string[];
  broke: string[];
} {
  const left = uniqueByTask(baseline); const right = uniqueByTask(arm);
  const missingFromBaseline = [...right.keys()].filter((id) => !left.has(id)).sort();
  const missingFromArm = [...left.keys()].filter((id) => !right.has(id)).sort();
  const complete = missingFromBaseline.length === 0 && missingFromArm.length === 0;
  if (options.requireCompleteCoverage && !complete) {
    throw new Error(`Incomplete paired selection coverage: missing from baseline [${missingFromBaseline.join(', ')}]; missing from arm [${missingFromArm.join(', ')}]`);
  }
  const ids = [...left.keys()].filter((id) => right.has(id)).sort();
  if (!ids.length) throw new Error('No common selection tasks to compare');
  const pairs = ids.map((id) => ({ baseline: left.get(id)!, arm: right.get(id)! }));
  return {
    baselineTasks: left.size, armTasks: right.size, commonTasks: ids.length,
    missingFromBaseline, missingFromArm, complete,
    allGoldRateDifference: mean(pairs.map(({ baseline: b, arm: a }) => Number(a.allGoldSelected) - Number(b.allGoldSelected))),
    recallDifference: mean(pairs.map(({ baseline: b, arm: a }) => a.recall - b.recall)),
    contextTokenDifference: mean(pairs.map(({ baseline: b, arm: a }) => a.contextTokens - b.contextTokens)),
    latencyRatio: ratio(mean(pairs.map(({ baseline }) => baseline.latencyMs)), mean(pairs.map(({ arm }) => arm.latencyMs))),
    fixed: ids.filter((id) => !left.get(id)!.allGoldSelected && right.get(id)!.allGoldSelected),
    broke: ids.filter((id) => left.get(id)!.allGoldSelected && !right.get(id)!.allGoldSelected),
  };
}

export function parseSelectionRecord(line: string): SelectionRunRecord {
  const value = JSON.parse(line) as Record<string, unknown>;
  if (value.type !== 'selection_eval' || typeof value.task_id !== 'string' || !value.task_id.trim()
    || typeof value.selector !== 'string' || !value.selector.trim()) {
    throw new Error('Invalid selection evaluation record');
  }
  const metrics = value.metrics && typeof value.metrics === 'object' ? value.metrics as Record<string, unknown> : {};
  return {
    taskId: value.task_id, selector: value.selector,
    candidateCount: arrayLength(value.candidates), selectedCount: nonnegativeInteger(metrics.selectedCount, 'selectedCount'),
    candidateRecall: probability(metrics.candidateRecall, 'candidateRecall'), recall: probability(metrics.recall, 'recall'),
    precision: probability(metrics.precision, 'precision'), allGoldSelected: boolean(metrics.allGoldSelected, 'allGoldSelected'),
    contextTokens: nonnegative(metrics.contextTokens, 'contextTokens'), latencyMs: nonnegative(value.latency_ms, 'latency_ms'),
    candidateGenerationMs: optionalNonnegative(value.candidate_generation_ms, 'candidate_generation_ms'),
  };
}

function uniqueByTask(records: SelectionRunRecord[]): Map<string, SelectionRunRecord> {
  const result = new Map<string, SelectionRunRecord>();
  for (const record of records) {
    if (result.has(record.taskId)) throw new Error(`Duplicate selection result for task '${record.taskId}'`);
    result.set(record.taskId, record);
  }
  return result;
}
function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid selection metric '${name}'`);
  return value;
}
function nonnegative(value: unknown, name: string): number {
  const parsed = number(value, name);
  if (parsed < 0) throw new Error(`Invalid selection metric '${name}'`);
  return parsed;
}
function nonnegativeInteger(value: unknown, name: string): number {
  const parsed = nonnegative(value, name);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid selection metric '${name}'`);
  return parsed;
}
function probability(value: unknown, name: string): number {
  const parsed = number(value, name);
  if (parsed < 0 || parsed > 1) throw new Error(`Invalid selection metric '${name}'`);
  return parsed;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid selection metric '${name}'`);
  return value;
}
function optionalNonnegative(value: unknown, name: string): number {
  return value === undefined ? 0 : nonnegative(value, name);
}
function arrayLength(value: unknown): number {
  if (!Array.isArray(value)) throw new Error('Selection candidates must be an array');
  return value.length;
}
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? (numerator > 0 ? Number.POSITIVE_INFINITY : 1) : numerator / denominator;
}
function percentile(values: number[], probability: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(probability * sorted.length))] ?? 0;
}
function mean(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
