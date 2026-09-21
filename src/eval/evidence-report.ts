import { readFile } from 'node:fs/promises';
import { analyzeCalibration, type CalibrationReport, type ConfidenceObservation } from './calibration.js';
import { evaluateG0, evaluateG1, evaluateG2, evaluateG3, evaluateG4, estimateNoiseFloor, type GateResult } from './gates.js';
import { summarizeRunLog } from './report.js';
import type { RoutingReplayMetrics } from './routing-replay.js';
import { compareSelectionRecords, loadSelectionLog, type SelectionRunRecord } from './selection-report.js';

export async function evaluateGateManifest(value: unknown): Promise<GateResult> {
  const manifest = object(value, 'Gate manifest');
  const gate = text(manifest.gate, 'gate');
  if (gate === 'G0') return evaluateG0({
    candidateCount: number(manifest.candidateCount, 'candidateCount'),
    top5ShuffleOverlap: probability(manifest.top5ShuffleOverlap, 'top5ShuffleOverlap'),
    meanInjectionDisplacement: nonnegative(manifest.meanInjectionDisplacement, 'meanInjectionDisplacement'),
  });
  if (gate === 'G1') {
    if (manifest.selectionResults !== undefined) return evaluateG1FromSelectionArtifact(manifest);
    return evaluateG1({
      armAllGoldRate: probability(manifest.armAllGoldRate, 'armAllGoldRate'),
      baselineAllGoldRate: probability(manifest.baselineAllGoldRate, 'baselineAllGoldRate'),
      referenceAllGoldRate: probability(manifest.referenceAllGoldRate, 'referenceAllGoldRate'),
      armLatencyMs: nonnegative(manifest.armLatencyMs, 'armLatencyMs'),
      referenceLatencyMs: nonnegative(manifest.referenceLatencyMs, 'referenceLatencyMs'),
      armCostUsd: nonnegative(manifest.armCostUsd, 'armCostUsd'),
      referenceCostUsd: nonnegative(manifest.referenceCostUsd, 'referenceCostUsd'),
    });
  }
  if (gate === 'G2' || gate === 'G3') {
    const [baseline, arm] = await Promise.all([
      summarizeRunLog(text(manifest.baselineEvents, 'baselineEvents')),
      summarizeRunLog(text(manifest.armEvents, 'armEvents')),
    ]);
    const noiseFloor = await resolveNoiseFloor(manifest);
    if (gate === 'G2') return evaluateG2(baseline, arm, noiseFloor);
    const routing = parseRoutingMetrics(JSON.parse(await readFile(text(manifest.routingMetrics, 'routingMetrics'), 'utf8')) as unknown);
    return evaluateG3(baseline, arm, routing, noiseFloor);
  }
  if (gate === 'G4') return evaluateG4({
    strongestPassRate: probability(manifest.strongestPassRate, 'strongestPassRate'),
    oraclePassRate: probability(manifest.oraclePassRate, 'oraclePassRate'),
    cascadePassRate: probability(manifest.cascadePassRate, 'cascadePassRate'),
    noiseFloor: probability(manifest.noiseFloor, 'noiseFloor'),
    strongestCostUsd: nonnegative(manifest.strongestCostUsd, 'strongestCostUsd'),
    oracleCostUsd: nonnegative(manifest.oracleCostUsd, 'oracleCostUsd'),
    cascadeCostUsd: nonnegative(manifest.cascadeCostUsd, 'cascadeCostUsd'),
  });
  throw new Error(`Unsupported gate '${gate}'`);
}

async function evaluateG1FromSelectionArtifact(manifest: Record<string, unknown>): Promise<GateResult> {
  const records = await loadSelectionLog(text(manifest.selectionResults, 'selectionResults'));
  const baseline = armRecords(records, text(manifest.baselineSelector, 'baselineSelector'));
  const arm = armRecords(records, text(manifest.armSelector, 'armSelector'));
  const reference = armRecords(records, text(manifest.referenceSelector, 'referenceSelector'));
  compareSelectionRecords(baseline, arm, { requireCompleteCoverage: true });
  compareSelectionRecords(reference, arm, { requireCompleteCoverage: true });
  return evaluateG1({
    baselineAllGoldRate: mean(baseline.map((record) => Number(record.allGoldSelected))),
    armAllGoldRate: mean(arm.map((record) => Number(record.allGoldSelected))),
    referenceAllGoldRate: mean(reference.map((record) => Number(record.allGoldSelected))),
    armLatencyMs: mean(arm.map((record) => record.latencyMs)),
    referenceLatencyMs: mean(reference.map((record) => record.latencyMs)),
    armCostUsd: nonnegative(manifest.armCostUsd, 'armCostUsd'),
    referenceCostUsd: nonnegative(manifest.referenceCostUsd, 'referenceCostUsd'),
  });
}

function armRecords(records: SelectionRunRecord[], selector: string): SelectionRunRecord[] {
  const selected = records.filter((record) => record.selector === selector);
  if (!selected.length) throw new Error(`Selection artifact has no records for '${selector}'`);
  return selected;
}

export async function calibrationReportFromFile(
  path: string, options: { bins?: number; coveragePoints?: number } = {},
): Promise<CalibrationReport> {
  const observations = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line, index) => {
    const value = object(JSON.parse(line) as unknown, `Calibration record ${index + 1}`);
    if (typeof value.correct !== 'boolean') throw new Error(`Calibration record ${index + 1} requires boolean correct`);
    return {
      id: text(value.id, `record ${index + 1} id`),
      probability: probability(value.probability, `record ${index + 1} probability`), correct: value.correct,
    } satisfies ConfidenceObservation;
  });
  return analyzeCalibration(observations, options);
}

async function resolveNoiseFloor(manifest: Record<string, unknown>): Promise<number> {
  if (manifest.noiseFloor !== undefined) return probability(manifest.noiseFloor, 'noiseFloor');
  const first = text(manifest.noiseBaselineFirst, 'noiseBaselineFirst');
  const second = text(manifest.noiseBaselineSecond, 'noiseBaselineSecond');
  return estimateNoiseFloor(await summarizeRunLog(first), await summarizeRunLog(second));
}

function parseRoutingMetrics(value: unknown): RoutingReplayMetrics {
  const input = object(value, 'Routing metrics');
  return {
    decisions: nonnegativeInteger(input.decisions, 'decisions'),
    stopNegativeDecisions: nonnegativeInteger(input.stopNegativeDecisions, 'stopNegativeDecisions'),
    stopPositiveDecisions: nonnegativeInteger(input.stopPositiveDecisions, 'stopPositiveDecisions'),
    retrievalPositiveDecisions: nonnegativeInteger(input.retrievalPositiveDecisions, 'retrievalPositiveDecisions'),
    falseStopRate: probability(input.falseStopRate, 'falseStopRate'),
    falseContinueRate: probability(input.falseContinueRate, 'falseContinueRate'),
    missedRetrievalRate: probability(input.missedRetrievalRate, 'missedRetrievalRate'),
    invalidDecisionRate: probability(input.invalidDecisionRate, 'invalidDecisionRate'),
    readDecisions: input.readDecisions === undefined ? 0 : nonnegativeInteger(input.readDecisions, 'readDecisions'),
    invalidReadTargetRate: input.invalidReadTargetRate === undefined ? 0 : probability(input.invalidReadTargetRate, 'invalidReadTargetRate'),
    fallbackRate: probability(input.fallbackRate, 'fallbackRate'),
  };
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}
function nonnegative(value: unknown, name: string): number {
  const parsed = number(value, name); if (parsed < 0) throw new Error(`${name} must be nonnegative`); return parsed;
}
function probability(value: unknown, name: string): number {
  const parsed = number(value, name); if (parsed < 0 || parsed > 1) throw new Error(`${name} must be between 0 and 1`); return parsed;
}
function mean(values: number[]): number {
  if (!values.length) throw new Error('Cannot average an empty evidence set');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function nonnegativeInteger(value: unknown, name: string): number {
  const parsed = nonnegative(value, name); if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`); return parsed;
}
