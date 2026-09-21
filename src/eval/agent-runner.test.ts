import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodingReasoner } from '../agent/types.js';
import type { RunEvent } from '../core/events.js';
import { validateRunEvents } from '../core/event-validation.js';
import { BudgetExceededError } from '../core/ledger.js';
import type { EventSink } from '../core/logger.js';
import type { Router, Selector } from '../core/types.js';
import { runAgentTask } from './agent-runner.js';
import type { EvaluationTask } from './tasks.js';

const task: EvaluationTask = {
  id: 'task', type: 'T-fix', task: 'fix auth', goldFiles: ['auth.ts'], testFiles: ['auth.test.ts'],
  source: { kind: 'fixture', data: {} },
};

test('runner composes only injected capabilities and releases workspace', async () => {
  const events: RunEvent[] = []; let released = false; let route = 0;
  const seenTasks: Array<Record<string, unknown>> = [];
  const sink: EventSink = { async write(event) { events.push(event); } };
  const selector: Selector = { async select() {
    return { selected: ['auth.ts'], unselected: ['other.ts'], scores: [{ id: 'auth.ts', p: 1, via: 'oracle' }], meta: {} };
  } };
  const router: Router = { async route() { return { action: route++ ? 'stop' : 'reason', source: 'rule' }; } };
  const reasoner: CodingReasoner = { async decide() { return { tool: { name: 'run_tests' }, usage: { inputTokens: 0, outputTokens: 0 } }; } };
  const result = await runAgentTask(task, {
    events: sink, selectorFor: (selectorTask) => {
      seenTasks.push(selectorTask as unknown as Record<string, unknown>);
      return selector;
    },
    async controllerFor(controllerTask, context) {
      seenTasks.push(controllerTask as unknown as Record<string, unknown>);
      assert.equal(context.runId.startsWith('r_'), true);
      assert.equal(context.currentStep(), 0);
      return { router, reasoner };
    },
    evaluator: { async evaluate() {
      return { passed: true, exitCode: 0, durationMs: 1, output: 'hidden pass', metadata: { secret: 'hidden detail' } };
    } },
    workspaces: { async acquire() { return { path: '/workspace', async release() { released = true; } }; } },
    context: { async create({ task: contextTask }) {
      seenTasks.push(contextTask as unknown as Record<string, unknown>);
      return {
      async search() { return [
        { id: 'auth.ts', path: 'auth.ts', kind: 'file', approxTokens: 1 },
        { id: 'other.ts', path: 'other.ts', kind: 'file', approxTokens: 1 },
      ]; },
      async load(id) { return { id, text: 'content', tokens: 1 }; },
    }; } },
    tools: { async create({ task: toolsTask }) {
      seenTasks.push(toolsTask as unknown as Record<string, unknown>);
      return {
      async readFile() { return { ok: true, output: '', durationMs: 1 }; },
      async writeFile() { return { ok: true, output: '', durationMs: 1 }; },
      async search() { return { ok: true, output: '', durationMs: 1 }; },
      async runTests() { return { ok: true, output: 'pass', durationMs: 1, exitCode: 0 }; },
      async snapshot() { return { id: 'snapshot' }; },
    }; } },
  }, {
    configId: 'fixture', candidateLimit: 10, selectionBudget: { maxItems: 2, maxTokens: 100 },
    sessionBudgets: { maxSteps: 5, maxReasoningTokens: 100, wallClockMs: 10_000 },
    manifest: { datasetVersion: 'v1', configHash: 'hash', modelIds: [], decisionModelIds: [] },
  });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.visibleOutcome, 'passed');
  assert.equal(released, true);
  assert.equal(seenTasks.length, 4);
  for (const seen of seenTasks) {
    assert.equal(seen.goldFiles, undefined);
    assert.equal(seen.testFiles, undefined);
    assert.equal(seen.source, undefined);
    assert.equal(seen.gold, undefined);
  }
  assert.ok(events.some(({ type }) => type === 'selection'));
  assert.equal(events.filter(({ type }) => type === 'run_start').length, 1);
  assert.equal(events.filter(({ type }) => type === 'run_end').length, 1);
  const initialSnapshot = events.find(({ type, payload }) => type === 'snapshot' && payload.initial === true);
  assert.equal(initialSnapshot?.step, 0);
  const evaluation = events.find(({ type }) => type === 'run_end')?.payload.evaluation as Record<string, unknown>;
  assert.equal(evaluation.output, undefined);
  assert.equal(evaluation.outputChars, 11);
  assert.match(String(evaluation.outputHash), /^[a-f0-9]{64}$/);
  assert.equal(evaluation.metadata, undefined);
  assert.match(String(evaluation.metadataHash), /^[a-f0-9]{64}$/);
});

test('runner filters an expanded candidate pool before selection', async () => {
  let seen: string[] = [];
  await runAgentTask(task, {
    events: { async write() {} },
    selectorFor: () => ({ async select(input) {
      seen = input.candidates.map(({ id }) => id);
      return { selected: [], unselected: seen, scores: [], meta: {} };
    } }),
    async controllerFor() { return {
      router: { async route() { return { action: 'stop', source: 'rule' }; } },
      reasoner: { async decide() { throw new Error('unused'); } },
    }; },
    evaluator: { async evaluate() { return { passed: false, exitCode: 1, durationMs: 1 }; } },
    workspaces: { async acquire() { return { path: '/workspace', async release() {} }; } },
    context: { async create() { return {
      async search(_query, options) {
        assert.equal(options.limit, 3);
        return [
          { id: 'test', path: 'test.ts', kind: 'test' as const, approxTokens: 1 },
          { id: 'a', path: 'a.ts', kind: 'file' as const, approxTokens: 1 },
          { id: 'b', path: 'b.ts', kind: 'file' as const, approxTokens: 1 },
        ];
      },
      async load(id) { return { id, text: '', tokens: 0 }; },
    }; } },
    tools: { async create() { return {
      async readFile() { return { ok: true, output: '', durationMs: 1 }; },
      async writeFile() { return { ok: true, output: '', durationMs: 1 }; },
      async search() { return { ok: true, output: '', durationMs: 1 }; },
      async runTests() { return { ok: false, output: '', durationMs: 1 }; },
      async snapshot() { return { id: 'snapshot' }; },
    }; } },
  }, {
    configId: 'fixture', candidateLimit: 1, poolCandidates: 3, candidateKinds: ['file'],
    selectionBudget: { maxItems: 1, maxTokens: 10 },
    sessionBudgets: { maxSteps: 1, maxReasoningTokens: 10, wallClockMs: 10_000 },
    manifest: { datasetVersion: 'v1', configHash: 'hash', modelIds: [], decisionModelIds: [] },
  });
  assert.deepEqual(seen, ['a']);
});

test('runner bounds and validates loaded initial context before model use', async () => {
  let seenText: string | undefined;
  let route = 0;
  const selector: Selector = { async select() {
    return { selected: ['a'], unselected: [], scores: [], meta: {} };
  } };
  const result = await runAgentTask(task, {
    events: { async write() {} }, selectorFor: () => selector,
    async controllerFor() { return {
      router: { async route() { return { action: route++ ? 'stop' : 'reason', source: 'rule' }; } },
      reasoner: { async decide(input) { seenText = input.selectedContext[0]?.text; return { tool: { name: 'run_tests' }, usage: { inputTokens: 0, outputTokens: 0 } }; } },
    }; },
    evaluator: { async evaluate() { return { passed: true, exitCode: 0, durationMs: 1 }; } },
    workspaces: { async acquire() { return { path: '/workspace', async release() {} }; } },
    context: { async create() { return {
      async search() { return [{ id: 'a', path: 'a.ts', kind: 'file', approxTokens: 1 }]; },
      async load() { return { id: 'a', text: 'abcdefghij', tokens: 3 }; },
    }; } },
    tools: { async create() { return {
      async readFile() { return { ok: true, output: '', durationMs: 1 }; },
      async writeFile() { return { ok: true, output: '', durationMs: 1 }; },
      async search() { return { ok: true, output: '', durationMs: 1 }; },
      async runTests() { return { ok: true, output: '', durationMs: 1 }; },
      async snapshot() { return { id: 's' }; },
    }; } },
  }, {
    configId: 'fixture', candidateLimit: 1, selectionBudget: { maxItems: 1, maxTokens: 1 },
    sessionBudgets: { maxSteps: 3, maxReasoningTokens: 100, wallClockMs: 10_000 },
    manifest: { datasetVersion: 'v1', configHash: 'hash', modelIds: [], decisionModelIds: [] },
  });
  assert.equal(result.outcome, 'passed');
  assert.equal(seenText, 'abcd');
});

test('runner rejects mismatched context loads and invalid initial snapshots', async () => {
  const dependencies = {
    events: { async write() {} },
    selectorFor: (): Selector => ({ async select() { return { selected: ['a'], unselected: [], scores: [], meta: {} }; } }),
    async controllerFor() { throw new Error('unused'); },
    evaluator: { async evaluate() { return { passed: false, exitCode: 1, durationMs: 1 }; } },
    workspaces: { async acquire() { return { path: '/workspace', async release() {} }; } },
    context: { async create() { return {
      async search() { return [{ id: 'a', path: 'a.ts', kind: 'file' as const, approxTokens: 1 }]; },
      async load() { return { id: 'wrong', text: '', tokens: 0 }; },
    }; } },
    tools: { async create() { throw new Error('unused'); } },
  };
  const options = {
    configId: 'fixture', candidateLimit: 1, selectionBudget: { maxItems: 1, maxTokens: 10 },
    sessionBudgets: { maxSteps: 3, maxReasoningTokens: 100, wallClockMs: 10_000 },
    manifest: { datasetVersion: 'v1', configHash: 'hash', modelIds: [], decisionModelIds: [] },
  };
  await assert.rejects(runAgentTask(task, dependencies, options), /loaded 'wrong'/);
});

test('runner preserves a valid lifecycle when authoritative evaluation fails after agent steps', async () => {
  const events: RunEvent[] = []; let route = 0;
  await assert.rejects(runAgentTask(task, {
    events: { async write(event) { events.push(event); } },
    selectorFor: (): Selector => ({ async select() { return { selected: ['a'], unselected: [], scores: [], meta: {} }; } }),
    async controllerFor() { return {
      router: { async route() { return { action: route++ ? 'stop' : 'reason', source: 'rule' }; } },
      reasoner: { async decide() { return { tool: { name: 'run_tests' }, usage: { inputTokens: 0, outputTokens: 0 } }; } },
    }; },
    evaluator: { async evaluate() { throw new Error('evaluator unavailable'); } },
    workspaces: { async acquire() { return { path: '/workspace', async release() {} }; } },
    context: { async create() { return {
      async search() { return [{ id: 'a', path: 'a.ts', kind: 'file' as const, approxTokens: 1 }]; },
      async load(id) { return { id, text: '', tokens: 0 }; },
    }; } },
    tools: { async create() { return {
      async readFile() { return { ok: true, output: '', durationMs: 1 }; }, async writeFile() { return { ok: true, output: '', durationMs: 1 }; },
      async search() { return { ok: true, output: '', durationMs: 1 }; }, async runTests() { return { ok: true, output: '', durationMs: 1 }; },
      async snapshot() { return { id: 's' }; },
    }; } },
  }, {
    configId: 'fixture', candidateLimit: 1, selectionBudget: { maxItems: 1, maxTokens: 10 },
    sessionBudgets: { maxSteps: 3, maxReasoningTokens: 100, wallClockMs: 10_000 },
    manifest: { datasetVersion: 'v1', configHash: 'hash', modelIds: [], decisionModelIds: [] },
  }), /evaluator unavailable/);
  assert.doesNotThrow(() => validateRunEvents(events));
  assert.equal(events.at(-1)?.step, 2);
  assert.equal(events.at(-1)?.payload.termination_reason, 'infrastructure_error');
});

test('runner classifies setup budget failures as budget termination', async () => {
  const events: RunEvent[] = [];
  await assert.rejects(runAgentTask(task, {
    events: { async write(event) { events.push(event); } },
    selectorFor: () => { throw new BudgetExceededError(1, 1, 1); },
    async controllerFor() { throw new Error('unused'); },
    evaluator: { async evaluate() { return { passed: false, exitCode: 1, durationMs: 1 }; } },
    workspaces: { async acquire() { return { path: '/workspace', async release() {} }; } },
    context: { async create() { return {
      async search() { return []; }, async load(id) { return { id, text: '', tokens: 0 }; },
    }; } },
    tools: { async create() { throw new Error('unused'); } },
  }, {
    configId: 'fixture', candidateLimit: 10, selectionBudget: { maxItems: 2, maxTokens: 100 },
    sessionBudgets: { maxSteps: 5, maxReasoningTokens: 100, wallClockMs: 10_000 },
    manifest: { datasetVersion: 'v1', configHash: 'hash', modelIds: [], decisionModelIds: [] },
  }), BudgetExceededError);
  assert.equal(events.find(({ type }) => type === 'run_end')?.payload.termination_reason, 'budget');
});

test('runner logs infrastructure failures and still releases an acquired workspace', async () => {
  const events: RunEvent[] = []; let released = false;
  await assert.rejects(runAgentTask(task, {
    events: { async write(event) { events.push(event); } },
    selectorFor: () => { throw new Error('selector unavailable'); },
    async controllerFor() { throw new Error('unused'); },
    evaluator: { async evaluate() { return { passed: false, exitCode: 1, durationMs: 1 }; } },
    workspaces: { async acquire() { return { path: '/workspace', async release() { released = true; } }; } },
    context: { async create() { return {
      async search() { return []; }, async load(id) { return { id, text: '', tokens: 0 }; },
    }; } },
    tools: { async create() { throw new Error('unused'); } },
  }, {
    configId: 'fixture', candidateLimit: 10, selectionBudget: { maxItems: 2, maxTokens: 100 },
    sessionBudgets: { maxSteps: 5, maxReasoningTokens: 100, wallClockMs: 10_000 },
    manifest: { datasetVersion: 'v1', configHash: 'hash', modelIds: [], decisionModelIds: [] },
  }), /selector unavailable/);
  assert.equal(released, true);
  assert.equal(events.filter(({ type }) => type === 'run_start').length, 1);
  const end = events.find(({ type }) => type === 'run_end');
  assert.equal(end?.payload.termination_reason, 'infrastructure_error');
});
