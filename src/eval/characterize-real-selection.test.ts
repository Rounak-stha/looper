import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Selector } from '../core/types.js';
import { characterizeRealSelection } from './characterize-real-selection.js';

const task = {
  id: 't', type: 'T-fix', task: 'fix target', goldFiles: ['gold.py'], testFiles: ['test.py'],
  source: { kind: 'fixture', data: {} }, split: 'dev',
};

test('characterizes an injected selector with filtering, shuffling, and injection probes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'real-selection-'));
  const tasksPath = join(root, 'tasks.jsonl'); const outputPath = join(root, 'result.jsonl');
  await writeFile(tasksPath, `${JSON.stringify(task)}\n`);
  const sanitizationModes: boolean[] = [];
  const selectorFor = (_task: unknown, sanitize: boolean): Selector => ({ async select(input) {
    sanitizationModes.push(sanitize);
    const selected = input.candidates.slice(0, input.budget.maxItems).map(({ id }) => id);
    return {
      selected, unselected: input.candidates.map(({ id }) => id).filter((id) => !selected.includes(id)),
      scores: input.candidates.map(({ id }, index) => ({ id, p: 1 / (index + 1), via: 'llm' as const })),
      meta: { model: 'fixture', calls: 2, repaired: true, usage: { input_tokens: 3, output_tokens: 1 } },
    };
  } });
  const summary = await characterizeRealSelection({
    tasksPath, outputPath, selectorId: 'fixture', candidateLimit: 2, poolCandidates: 3,
    candidateKinds: ['file'], maxItems: 2, repetitions: 2, shuffles: 1, seed: 7, selectorFor,
    workspaces: { async acquire() { return { path: '/opaque', async release() {} }; } },
    context: { async create() { return {
      async search() { return [
        { id: 'gold', path: 'gold.py', kind: 'file' as const, approxTokens: 1 },
        { id: 'test', path: 'test.py', kind: 'test' as const, approxTokens: 1 },
        { id: 'other', path: 'other.py', kind: 'file' as const, approxTokens: 1 },
      ]; },
      async load(id) { return { id, text: '', tokens: 0 }; },
    }; } },
  });
  assert.equal(summary.tasks, 1); assert.equal(summary.completedTasks, 1);
  assert.equal(summary.candidateRecall, 1); assert.equal(summary.failedCalls, 0);
  assert.equal(summary.repairedCalls, 6); assert.deepEqual(summary.models, ['fixture']);
  assert.deepEqual(sanitizationModes, [true, true, true, false, false, true]);
  const artifact = JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(artifact.candidate_kinds, ['file']); assert.equal(artifact.pool_candidates, 3);
});
