import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ContextProvider, Selector } from '../core/types.js';
import { evaluateOfflineSelection } from './offline-selection.js';
import type { EvaluationTask } from './tasks.js';

const task: EvaluationTask = {
  id: 'fixture', type: 'T-fix', task: 'fix auth', goldFiles: ['auth.ts'], testFiles: ['auth.test.ts'],
  source: { kind: 'fixture', data: {} },
};

test('offline evaluation uses injected workspace, context, and selector capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-eval-'));
  const tasksPath = join(root, 'tasks.jsonl');
  const outputPath = join(root, 'results.jsonl');
  await writeFile(tasksPath, `${JSON.stringify(task)}\n`);
  let released = false;
  const provider: ContextProvider = {
    async search() { return [{ id: 'auth.ts', path: 'auth.ts', kind: 'file', approxTokens: 10 }]; },
    async load(id) { return { id, text: '', tokens: 0 }; },
  };
  const selector: Selector = {
    async select(input) {
      return { selected: ['auth.ts'], unselected: [], scores: [{ id: 'auth.ts', p: 1, via: 'oracle' }], meta: {} };
    },
  };
  const summary = await evaluateOfflineSelection({
    tasksPath, outputPath, selectorId: 'fixture', selectorFor: () => selector,
    workspaces: { async acquire() { return { path: '/opaque', async release() { released = true; } }; } },
    context: { async create() { return provider; } },
    candidates: 10, maxItems: 2, maxTokens: 100,
  });
  assert.equal(summary.all_gold_selected_rate, 1);
  assert.equal(released, true);
  assert.match(await readFile(outputPath, 'utf8'), /"selector":"fixture"/);
});

test('offline evaluation preserves the prior artifact when evaluation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-eval-failure-'));
  const tasksPath = join(root, 'tasks.jsonl');
  const outputPath = join(root, 'results.jsonl');
  await writeFile(tasksPath, `${JSON.stringify(task)}\n`);
  await writeFile(outputPath, 'complete-prior-artifact\n');
  let released = false;
  await assert.rejects(evaluateOfflineSelection({
    tasksPath, outputPath, selectorId: 'broken',
    selectorFor: () => ({ async select() { throw new Error('selector failed'); } }),
    workspaces: { async acquire() { return { path: '/opaque', async release() { released = true; } }; } },
    context: { async create() { return {
      async search() { return [{ id: 'a', path: 'a.ts', kind: 'file' as const, approxTokens: 1 }]; },
      async load(id) { return { id, text: '', tokens: 0 }; },
    }; } },
    candidates: 10, maxItems: 2, maxTokens: 100,
  }), /selector failed/);
  assert.equal(released, true);
  assert.equal(await readFile(outputPath, 'utf8'), 'complete-prior-artifact\n');
});
