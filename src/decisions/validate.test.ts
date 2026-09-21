import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionRequest } from './types.js';
import { DecisionTokenBudgetError, DecisionValidationError, validateRequest } from './validate.js';

const valid: DecisionRequest = {
  model: 'jev-1.13.0',
  state: { task: 'fix it' },
  questions: { relevant: { type: 'noul', instructions: 'Is this relevant?' } },
};

test('accepts a valid request', () => assert.doesNotThrow(() => validateRequest(valid, 1_000)));

test('rejects null state', () => {
  const request = { ...valid, state: null } as unknown as DecisionRequest;
  assert.throws(() => validateRequest(request, 1_000), (error: unknown) =>
    error instanceof DecisionValidationError && error.code === 'NULL_STATE');
});

test('rejects more than 255 choice options', () => {
  const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`c${index}`, 'candidate']));
  const request: DecisionRequest = {
    ...valid,
    questions: { pick: { type: 'choice', instructions: 'Pick one', criteria } },
  };
  assert.throws(() => validateRequest(request, 100_000), (error: unknown) =>
    error instanceof DecisionValidationError && error.code === 'CHOICE_OPTIONS');
});

test('rejects score outside 2–10 levels', () => {
  const request: DecisionRequest = {
    ...valid,
    questions: { score: { type: 'score', instructions: 'Score it', criteria: ['only'] } },
  };
  assert.throws(() => validateRequest(request, 1_000), (error: unknown) =>
    error instanceof DecisionValidationError && error.code === 'SCORE_LEVELS');
});

test('rejects estimated token overflow', () => {
  assert.throws(() => validateRequest({ ...valid, state: 'x'.repeat(1_000) }, 10), DecisionTokenBudgetError);
});
