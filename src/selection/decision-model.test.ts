import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextCandidate } from '../core/types.js';
import type { DecisionModel, DecisionResult } from '../decisions/types.js';
import { DecisionModelSelector } from './decision-model.js';

const candidates: ContextCandidate[] = [
  { id: 'auth.ts', path: 'auth.ts', kind: 'file', approxTokens: 10 },
  { id: 'user.ts', path: 'user.ts', kind: 'file', approxTokens: 10 },
];

const model: DecisionModel = {
  async ask(_state, questions): Promise<DecisionResult> {
    const isChoice = 'most_important' in questions;
    return {
      model: 'fixture', usage: { input_tokens: 1, output_tokens: 1 }, raw: { model: 'fixture', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } },
      latencyMs: 1, cacheHit: false,
      choices: isChoice ? { most_important: { choice: 'auth.ts', probabilities: { 'auth.ts': 0.8, 'user.ts': 0.2 }, confidence: 0.7 } } : {},
      nouls: isChoice ? {} : { 'edit::auth.ts': 0.9, 'read::auth.ts': 0.8, 'edit::user.ts': 0.1, 'read::user.ts': 0.2 },
      scores: {},
    };
  },
};

test('decision selector depends only on DecisionModel abstraction', async () => {
  const selector = new DecisionModelSelector(model, { kind: 'choice+noul', k: 1, tauEdit: 0.5, tauRead: 0.7 });
  const result = await selector.select({ task: 'fix auth', candidates, alreadyLoaded: [], budget: { maxItems: 2, maxTokens: 100 } });
  assert.equal(result.selected[0], 'auth.ts');
  assert.equal(result.scores.find(({ id }) => id === 'auth.ts')!.p, 0.9);
});

test('choice selection handles singleton candidate sets without an invalid model request', async () => {
  let calls = 0;
  const selector = new DecisionModelSelector({ async ask() { calls++; throw new Error('must not call'); } }, {
    kind: 'choice', k: 1, tauEdit: 0.5, tauRead: 0.5,
  });
  const result = await selector.select({
    task: 'fix auth', candidates: candidates.slice(0, 1), alreadyLoaded: [], budget: { maxItems: 1, maxTokens: 100 },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.selected, ['auth.ts']);
  assert.equal(result.scores[0]!.p, 1);
});

test('choice selection ignores unknown provider probability keys', async () => {
  const unsafeModel: DecisionModel = {
    async ask(): Promise<DecisionResult> {
      return {
        model: 'fixture', usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0, cacheHit: false,
        raw: { model: 'fixture', usage: { input_tokens: 0, output_tokens: 0 }, answers: {} },
        choices: { most_important: { choice: 'unknown', probabilities: { unknown: 1, 'auth.ts': 0.8, 'user.ts': 0.2 }, confidence: 1 } },
        nouls: {}, scores: {},
      };
    },
  };
  const selector = new DecisionModelSelector(unsafeModel, { kind: 'choice', k: 1, tauEdit: 0.5, tauRead: 0.5 });
  const result = await selector.select({ task: 'fix auth', candidates, alreadyLoaded: [], budget: { maxItems: 1, maxTokens: 100 } });
  assert.deepEqual(result.selected, ['auth.ts']);
  assert.equal(result.scores.some(({ id }) => id === 'unknown'), false);
});
