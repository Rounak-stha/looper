import assert from 'node:assert/strict';
import test from 'node:test';
import { BudgetExceededError } from '../core/ledger.js';
import type { AgentRunDependencies } from './agent-runner.js';
import { experimentRunId, runAgentExperiment } from './experiment-runner.js';
import type { EvaluationTask } from './tasks.js';

const tasks: EvaluationTask[] = ['a', 'b'].map((id) => ({
  id, type: 'T-fix', task: `fix ${id}`, goldFiles: [`${id}.ts`], testFiles: [`${id}.test.ts`],
  source: { kind: 'fixture', data: {} },
}));

function dependencies(releases: string[]): AgentRunDependencies {
  return {
    events: { async write() {} },
    workspaces: { async acquire(task) { return { path: task.id, async release() { releases.push(task.id); } }; } },
    context: { async create({ task }) { return {
      async search() { return [{ id: `${task.id}.ts`, path: `${task.id}.ts`, kind: 'file', approxTokens: 1 }]; },
      async load(id) { return { id, text: '', tokens: 0 }; },
    }; } },
    selectors: undefined,
    selectorFor: () => ({ async select(input) {
      return { selected: [input.candidates[0]!.id], unselected: [], scores: [], meta: {} };
    } }),
    async controllerFor() { return {
      router: { async route() { return { action: 'reason', source: 'rule' }; } },
      reasoner: { async decide() { return { tool: { name: 'run_tests' }, usage: { inputTokens: 0, outputTokens: 0 } }; } },
    }; },
    tools: { async create() { return {
      async readFile() { return { ok: true, output: '', durationMs: 1 }; },
      async writeFile() { return { ok: true, output: '', durationMs: 1 }; },
      async search() { return { ok: true, output: '', durationMs: 1 }; },
      async runTests() { return { ok: true, output: '', durationMs: 1 }; },
      async snapshot() { return { id: 's' }; },
    }; } },
    evaluator: { async evaluate() { return { passed: true, exitCode: 0, durationMs: 1 }; } },
  } as AgentRunDependencies;
}

const options = {
  configId: 'arm', candidateLimit: 5, selectionBudget: { maxItems: 2, maxTokens: 10 },
  sessionBudgets: { maxSteps: 1, maxReasoningTokens: 100, wallClockMs: 10_000 },
  manifest: { datasetVersion: 'v1', configHash: 'h', modelIds: [], decisionModelIds: [] },
  runsPerTask: 2, seed: 7, estimatedCostPerRunUsd: 0.2,
};

test('experiment runs repetitions and performs admission before every run', async () => {
  const releases: string[] = []; let admissions = 0;
  const result = await runAgentExperiment(tasks, dependencies(releases), {
    ...options, admission: { async admit({ estimatedCostUsd }) { admissions++; assert.equal(estimatedCostUsd, 0.2); } },
  });
  assert.equal(result.completed.length, 4);
  assert.equal(result.errors.length, 0);
  assert.equal(admissions, 4);
  assert.equal(releases.length, 4);
  assert.ok(result.completed.every(({ runId }) => runId.startsWith('run_arm_7_')));
});

test('experiment rejects duplicate task IDs before scheduling', async () => {
  await assert.rejects(runAgentExperiment([tasks[0]!, { ...tasks[0]! }], dependencies([]), options), /Duplicate task id/);
});

test('scheduled run IDs are deterministic and escape components', () => {
  assert.equal(experimentRunId('a/b', 3, 'task one', 1), 'run_a%2Fb_3_task%20one_1');
});

test('experiment isolates ordinary admission failures', async () => {
  let admissions = 0;
  const result = await runAgentExperiment(tasks, dependencies([]), {
    ...options, runsPerTask: 1,
    admission: { async admit() { if (++admissions === 1) throw new Error('temporary'); } },
  });
  assert.equal(result.completed.length, 1);
  assert.equal(result.errors.length, 1);
});

test('experiment stops scheduling after global budget denial', async () => {
  let admissions = 0;
  const result = await runAgentExperiment(tasks, dependencies([]), {
    ...options,
    admission: { async admit() { admissions++; throw new BudgetExceededError(1, 1, 1); } },
  });
  assert.equal(admissions, 1);
  assert.equal(result.completed.length, 0);
  assert.equal(result.errors.length, 1);
});
