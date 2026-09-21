import assert from 'node:assert/strict';
import test from 'node:test';
import type { RouterState } from '../core/types.js';
import type { DecisionModel, DecisionResult } from '../decisions/types.js';
import { DecisionModelRouter } from './decision-model.js';
import { feasibleActions } from './feasible.js';
import { RulesRouter } from './rules.js';

const state = (overrides: Partial<RouterState> = {}): RouterState => ({
  task: 'fix auth', phase: 'context_loaded', loaded: 'few', unloadedCandidates: 'some',
  tests: { lastRun: 'never', dirtySinceLastRun: false }, lastActions: [], ...overrides,
});

function model(action: string, probability: number, complete = 1): DecisionModel {
  return { async ask(_state, questions): Promise<DecisionResult> {
    const stop = 'task_complete' in questions;
    return {
      model: 'fixture', nouls: stop ? { task_complete: complete } : {},
      choices: stop ? {} : { next_action: { choice: action, probabilities: { [action]: probability }, confidence: probability } },
      scores: {}, usage: { input_tokens: 1, output_tokens: 1 },
      raw: { model: 'fixture', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }, latencyMs: 1, cacheHit: false,
    };
  } };
}

test('rules force retrieval when no context is loaded', () => {
  assert.deepEqual(feasibleActions(state({ loaded: 'none' })), ['retrieve_context']);
});

test('rules force tests after edits', () => {
  assert.deepEqual(feasibleActions(state({ tests: { lastRun: 'failed', dirtySinceLastRun: true } })), ['run_tests']);
});

test('rules stop after clean passing tests', async () => {
  const current = state({ phase: 'post_test', unloadedCandidates: 'none', tests: { lastRun: 'passed', dirtySinceLastRun: false } });
  assert.equal((await new RulesRouter().route({ state: current, feasible: feasibleActions(current) })).action, 'stop');
});

test('submission policy permits stopping only after an edit without claiming visible success', async () => {
  const current = state({
    phase: 'post_edit', unloadedCandidates: 'none',
    tests: { lastRun: 'never', dirtySinceLastRun: true },
    completionPolicy: 'submission', hasSuccessfulEdit: true,
  });
  const feasible = feasibleActions(current, { completionPolicy: 'submission', hasSuccessfulEdit: true });
  assert.deepEqual(feasible, ['reason', 'run_tests', 'stop']);
  assert.equal((await new RulesRouter().route({ state: current, feasible })).action, 'stop');
  assert.ok(!feasibleActions(current, { completionPolicy: 'submission', hasSuccessfulEdit: false }).includes('stop'));
});

test('low-confidence decisions fall back to reason', async () => {
  const router = new DecisionModelRouter(model('read_file', 0.4), { tauRoute: 0.6, tauStop: 0.9 });
  assert.deepEqual(await router.route({ state: state(), feasible: ['reason', 'read_file'] }), {
    action: 'reason', probs: { read_file: 0.4 }, source: 'fallback',
  });
});

test('stop requires deterministic and model gates', async () => {
  const router = new DecisionModelRouter(model('stop', 0.95, 0.8), { tauRoute: 0.6, tauStop: 0.9 });
  const result = await router.route({
    state: state({ phase: 'post_test', unloadedCandidates: 'none', tests: { lastRun: 'passed', dirtySinceLastRun: false } }),
    feasible: ['reason', 'stop'],
  });
  assert.equal(result.action, 'reason');
  assert.equal(result.source, 'fallback');
});
