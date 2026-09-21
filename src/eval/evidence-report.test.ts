import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { calibrationReportFromFile, evaluateGateManifest } from './evidence-report.js';

function runEvents(runId: string, taskId: string, passed: boolean, steps: number) {
  const common = { run_id: runId, task_id: taskId, config_id: 'c', step: 0, ts: '2026-01-01T00:00:00Z' };
  return [
    { ...common, type: 'run_start', payload: {} },
    { ...common, step: steps, type: 'agent_end', payload: { visible_outcome: passed ? 'passed' : 'failed', termination_reason: 'stop' } },
    { ...common, step: steps, type: 'run_end', payload: {
      outcome: passed ? 'passed' : 'failed', termination_reason: 'stop',
      totals: { steps, reasoning_tokens: steps * 10 },
    } },
  ];
}

test('evaluates G1 directly from a complete selection artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'g1-evidence-'));
  const selection = join(root, 'selection.jsonl');
  const record = (task: string, selector: string, allGoldSelected: boolean, latency: number) => JSON.stringify({
    type: 'selection_eval', task_id: task, selector, candidates: ['a'], selected: ['a'],
    metrics: { selectedCount: 1, candidateRecall: 1, recall: Number(allGoldSelected), precision: Number(allGoldSelected), allGoldSelected, contextTokens: 1 },
    candidate_generation_ms: 1, latency_ms: latency,
  });
  await writeFile(selection, [
    record('a', 'baseline', false, 1), record('b', 'baseline', true, 1),
    record('a', 'arm', true, 1), record('b', 'arm', true, 1),
    record('a', 'reference', true, 20), record('b', 'reference', true, 20),
  ].join('\n'));
  const result = await evaluateGateManifest({
    gate: 'G1', selectionResults: selection,
    baselineSelector: 'baseline', armSelector: 'arm', referenceSelector: 'reference',
    armCostUsd: 0, referenceCostUsd: 0,
  });
  assert.equal(result.gate, 'G1');
  assert.equal(result.passed, true);
});

test('artifact-backed G1 rejects unequal arm coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'g1-coverage-'));
  const selection = join(root, 'selection.jsonl');
  const record = (task: string, selector: string) => JSON.stringify({
    type: 'selection_eval', task_id: task, selector, candidates: ['a'], selected: ['a'],
    metrics: { selectedCount: 1, candidateRecall: 1, recall: 1, precision: 1, allGoldSelected: true, contextTokens: 1 },
    candidate_generation_ms: 1, latency_ms: 1,
  });
  await writeFile(selection, [record('a', 'baseline'), record('a', 'arm'), record('b', 'arm'), record('a', 'reference')].join('\n'));
  await assert.rejects(evaluateGateManifest({
    gate: 'G1', selectionResults: selection,
    baselineSelector: 'baseline', armSelector: 'arm', referenceSelector: 'reference',
    armCostUsd: 0, referenceCostUsd: 0,
  }), /Incomplete paired selection coverage/);
});

test('evaluates a run-backed G2 manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evidence-report-'));
  const baseline = join(root, 'baseline.jsonl'); const arm = join(root, 'arm.jsonl');
  await writeFile(baseline, runEvents('b', 't', true, 10).map((item) => JSON.stringify(item)).join('\n'));
  await writeFile(arm, runEvents('a', 't', true, 7).map((item) => JSON.stringify(item)).join('\n'));
  const result = await evaluateGateManifest({ gate: 'G2', baselineEvents: baseline, armEvents: arm, noiseFloor: 0 });
  assert.equal(result.gate, 'G2');
  assert.equal(result.passed, true);
});

test('calibration file requires objective boolean labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'calibration-report-'));
  const valid = join(root, 'valid.jsonl'); const invalid = join(root, 'invalid.jsonl');
  await writeFile(valid, '{"id":"a","probability":0.9,"correct":true}\n{"id":"b","probability":0.2,"correct":false}\n');
  await writeFile(invalid, '{"id":"a","probability":0.9,"correct":"yes"}\n');
  assert.equal((await calibrationReportFromFile(valid)).observations, 2);
  await assert.rejects(calibrationReportFromFile(invalid), /boolean correct/);
});
