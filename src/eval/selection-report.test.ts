import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareSelectionRecords, parseSelectionRecord, summarizeSelectionLog } from './selection-report.js';

function line(task: string, selector: string, allGoldSelected: boolean, recall: number, latency = 10): string {
  return JSON.stringify({
    type: 'selection_eval', task_id: task, selector, candidates: ['a', 'b'], selected: ['a'],
    metrics: { selectedCount: 1, candidateRecall: 1, recall, precision: recall, allGoldSelected, contextTokens: 10 },
    candidate_generation_ms: 3, latency_ms: latency,
  });
}

test('summarizes selection logs by selector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selection-report-'));
  const path = join(root, 'results.jsonl');
  await writeFile(path, `${line('a', 'bm25', true, 1, 10)}\n${line('b', 'bm25', false, 0.5, 20)}\n`);
  const summaries = await summarizeSelectionLog(path);
  assert.equal(summaries[0]!.allGoldSelectedRate, 0.5);
  assert.equal(summaries[0]!.meanLatencyMs, 15);
  assert.equal(summaries[0]!.meanCandidateGenerationMs, 3);
});

test('selection logs reject duplicate selector/task identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selection-duplicates-'));
  const path = join(root, 'results.jsonl');
  await writeFile(path, `${line('a', 'arm', true, 1)}\n${line('a', 'arm', false, 0)}\n`);
  await assert.rejects(summarizeSelectionLog(path), /Duplicate selection result/);
});

test('rejects malformed objective selection metrics', () => {
  const malformed = JSON.parse(line('a', 'arm', true, 1)) as Record<string, unknown>;
  (malformed.metrics as Record<string, unknown>).allGoldSelected = 'false';
  assert.throws(() => parseSelectionRecord(JSON.stringify(malformed)), /allGoldSelected/);
  (malformed.metrics as Record<string, unknown>).allGoldSelected = false;
  (malformed.metrics as Record<string, unknown>).recall = 2;
  assert.throws(() => parseSelectionRecord(JSON.stringify(malformed)), /recall/);
});

test('compares paired selection outcomes', () => {
  const baseline = [parseSelectionRecord(line('a', 'base', false, 0.5)), parseSelectionRecord(line('b', 'base', true, 1))];
  const arm = [parseSelectionRecord(line('a', 'arm', true, 1)), parseSelectionRecord(line('b', 'arm', true, 1))];
  const result = compareSelectionRecords(baseline, arm);
  assert.equal(result.allGoldRateDifference, 0.5);
  assert.deepEqual(result.fixed, ['a']);
  assert.deepEqual(result.broke, []);
  assert.equal(result.complete, true);
});

test('selection comparison exposes and can reject missing tasks', () => {
  const baseline = [parseSelectionRecord(line('a', 'base', true, 1)), parseSelectionRecord(line('b', 'base', true, 1))];
  const arm = [parseSelectionRecord(line('a', 'arm', true, 1))];
  assert.deepEqual(compareSelectionRecords(baseline, arm).missingFromArm, ['b']);
  assert.throws(() => compareSelectionRecords(baseline, arm, { requireCompleteCoverage: true }), /Incomplete/);
});
