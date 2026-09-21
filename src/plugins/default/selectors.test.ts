import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextCandidate } from '../../core/types.js';
import { selectionMetrics } from '../../eval/metrics.js';
import { OracleSelector } from '../../selection/oracle.js';
import { NoneSelector } from '../../selection/none.js';
import { HeuristicSelector } from './heuristic-selector.js';
import { Bm25Selector } from './minisearch-selector.js';

const candidates: ContextCandidate[] = [
  { id: 'src/auth/session.ts', path: 'src/auth/session.ts', kind: 'file', summary: 'validates authentication sessions and expiration', approxTokens: 100 },
  { id: 'src/math.ts', path: 'src/math.ts', kind: 'file', summary: 'arithmetic helpers', approxTokens: 50 },
  { id: 'src/auth/session.test.ts', path: 'src/auth/session.test.ts', kind: 'test', summary: 'authentication session tests', approxTokens: 80 },
];
const input = {
  task: 'Fix expired authentication sessions', candidates, alreadyLoaded: [],
  budget: { maxItems: 1, maxTokens: 1_000 },
};

test('BM25 and heuristic rank a relevant path first', async () => {
  for (const selector of [new Bm25Selector(), new HeuristicSelector()]) {
    const result = await selector.select(input);
    assert.equal(result.selected[0], 'src/auth/session.ts');
  }
});

test('none selector leaves the complete candidate set unloaded', async () => {
  const result = await new NoneSelector().select(input);
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.unselected, candidates.map(({ id }) => id));
  assert.deepEqual(result.scores, []);
});

test('oracle selects gold paths first', async () => {
  const result = await new OracleSelector(new Set(['src/math.ts'])).select(input);
  assert.deepEqual(result.selected, ['src/math.ts']);
});

test('computes selection metrics using candidate paths rather than IDs', () => {
  const metricCandidates: ContextCandidate[] = [
    { id: 'symbol:a', path: 'a', kind: 'symbol', approxTokens: 10 },
    { id: 'symbol:x', path: 'x', kind: 'symbol', approxTokens: 5 },
  ];
  assert.deepEqual(selectionMetrics(['symbol:a', 'symbol:x'], ['a', 'b'], metricCandidates), {
    recall: 0.5, precision: 0.5, allGoldSelected: false, selectedCount: 2, contextTokens: 15,
  });
});
