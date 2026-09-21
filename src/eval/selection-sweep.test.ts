import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Selector } from '../core/types.js';
import { evaluateSelectionSweep, parseSelectionSweepConfig } from './selection-sweep.js';
import type { EvaluationTask } from './tasks.js';

const task: EvaluationTask = {
  id: 't', type: 'T-fix', task: 'fix a', goldFiles: ['a.ts'], testFiles: ['a.test.ts'],
  source: { kind: 'fixture', data: {} },
};

test('selection sweep shares candidate generation and orders arms deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selection-sweep-'));
  const tasksPath = join(root, 'tasks.jsonl'); const outputPath = join(root, 'results.jsonl');
  await writeFile(tasksPath, `${JSON.stringify(task)}\n`);
  let searches = 0; let releases = 0;
  const selector: Selector = { async select(input) {
    const selected = input.candidates.slice(0, input.budget.maxItems).map(({ id }) => id);
    const selectedSet = new Set(selected);
    return {
      selected, unselected: input.candidates.map(({ id }) => id).filter((id) => !selectedSet.has(id)),
      scores: input.candidates.map(({ id }, index) => ({ id, p: 1 / (index + 1), via: 'heuristic' as const })), meta: {},
    };
  } };
  await writeFile(outputPath, '{"stale":true}\n');
  const result = await evaluateSelectionSweep({
    tasksPath, outputPath,
    arms: [
      { id: 'z-N1', selector: 'heuristic', candidates: 1, maxItems: 1, maxTokens: 10 },
      { id: 'a-N2', selector: 'heuristic', candidates: 2, maxItems: 1, maxTokens: 10, candidateKinds: ['file'], poolCandidates: 3 },
    ],
    selectorFor: () => selector,
    workspaces: { async acquire() { return { path: '/opaque', async release() { releases++; } }; } },
    context: { async create() { return {
      async search(_query, options) {
        searches++; return [
          { id: 'a', path: 'a.ts', kind: 'file' as const, approxTokens: 1 },
          { id: 'test', path: 'a.test.ts', kind: 'test' as const, approxTokens: 1 },
          { id: 'b', path: 'b.ts', kind: 'file' as const, approxTokens: 1 },
        ].slice(0, options.limit);
      },
      async load(id) { return { id, text: '', tokens: 0 }; },
    }; } },
  });
  assert.deepEqual(result, { tasks: 1, arms: 2, evaluations: 2 });
  assert.equal(searches, 1);
  assert.equal(releases, 1);
  const records = (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { selector: string });
  assert.deepEqual(records.map(({ selector: id }) => id), ['a-N2', 'z-N1']);
  assert.equal(records.length, 2);
  const detailed = (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { selector: string; candidates: string[]; parameters: Record<string, unknown> });
  assert.deepEqual(detailed[0]!.candidates, ['a', 'b']);
  assert.deepEqual(detailed[0]!.parameters.candidate_kinds, ['file']);
  assert.equal(detailed[0]!.parameters.pool_candidates, 3);
});

test('selection sweep config validates candidate kind filters and pool sizes', () => {
  assert.throws(() => parseSelectionSweepConfig({ arms: [
    { id: 'bad-kind', selector: 'bm25', candidates: 10, maxItems: 1, maxTokens: 100, candidateKinds: ['unknown'] },
  ] }), /known candidate kinds/);
  const parsed = parseSelectionSweepConfig({ arms: [
    { id: 'bad-pool', selector: 'bm25', candidates: 10, poolCandidates: 9, maxItems: 1, maxTokens: 100 },
  ] });
  assert.rejects(async () => evaluateSelectionSweep({
    tasksPath: 'missing', outputPath: 'unused', arms: parsed,
    selectorFor() { throw new Error('unused'); },
    workspaces: { async acquire() { throw new Error('unused'); } },
    context: { async create() { throw new Error('unused'); } },
  }), /poolCandidates must be at least candidates/);
});

test('selection sweep config rejects duplicate IDs', () => {
  const arm = { id: 'same', selector: 'bm25', candidates: 10, maxItems: 2, maxTokens: 100 };
  const parsed = parseSelectionSweepConfig({ arms: [arm, arm] });
  assert.rejects(async () => evaluateSelectionSweep({
    tasksPath: 'missing', outputPath: 'unused', arms: parsed,
    selectorFor() { throw new Error('unused'); },
    workspaces: { async acquire() { throw new Error('unused'); } },
    context: { async create() { throw new Error('unused'); } },
  }), /unique/);
});
