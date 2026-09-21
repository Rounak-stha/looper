import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextCandidate } from '../core/types.js';
import { validateContextCandidates, validateSelectionResult } from './validate.js';

const candidates: ContextCandidate[] = [
  { id: 'a', path: 'a.ts', kind: 'file', approxTokens: 1 },
  { id: 'b', path: 'b.ts', kind: 'file', approxTokens: 1 },
];

test('accepts a complete disjoint selection partition', () => {
  assert.doesNotThrow(() => validateSelectionResult(candidates, {
    selected: ['a'], unselected: ['b'], scores: [{ id: 'a', p: 0.8, via: 'bm25' }], meta: {},
  }));
});

test('rejects unknown, duplicate, overlapping, and omitted candidates', () => {
  assert.throws(() => validateSelectionResult(candidates, { selected: ['x'], unselected: ['a', 'b'], scores: [], meta: {} }), /unknown/);
  assert.throws(() => validateSelectionResult(candidates, { selected: ['a', 'a'], unselected: ['b'], scores: [], meta: {} }), /duplicate/);
  assert.throws(() => validateSelectionResult(candidates, { selected: ['a'], unselected: ['a', 'b'], scores: [], meta: {} }), /both/);
  assert.throws(() => validateSelectionResult(candidates, { selected: ['a'], unselected: [], scores: [], meta: {} }), /omitted/);
});

test('rejects selections exceeding item or token budgets', () => {
  const all = { selected: ['a', 'b'], unselected: [], scores: [], meta: {} };
  assert.throws(() => validateSelectionResult(candidates, all, { maxItems: 1, maxTokens: 10 }), /item budget/);
  assert.throws(() => validateSelectionResult(candidates, all, { maxItems: 2, maxTokens: 1 }), /token budget/);
});

test('rejects invalid provider candidates before selection', () => {
  assert.throws(() => validateContextCandidates([
    { ...candidates[0]!, approxTokens: Number.NaN }, candidates[1]!,
  ]), /token estimate/);
  assert.throws(() => validateContextCandidates([...candidates, { ...candidates[0]!, id: 'c' }], 2), /candidate limit/);
  assert.throws(() => validateContextCandidates([{ ...candidates[0]!, kind: 'unknown' }]), /invalid kind/);
});

test('rejects malformed selection envelopes, duplicate scores, and metadata', () => {
  assert.throws(() => validateSelectionResult(candidates, null as never), /envelope/);
  assert.throws(() => validateSelectionResult(candidates, {
    selected: ['a'], unselected: ['b'], scores: [
      { id: 'a', p: 0.5, via: 'bm25' }, { id: 'a', p: 0.5, via: 'bm25' },
    ], meta: {},
  }), /duplicate score/);
  assert.throws(() => validateSelectionResult(candidates, {
    selected: ['a'], unselected: ['b'], scores: [], meta: { bad: undefined },
  }), /reproducible JSON/);
});
