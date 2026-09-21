import assert from 'node:assert/strict';
import test from 'node:test';
import type { Router, RouterState } from '../core/types.js';
import { evaluateRouter } from './routing-replay.js';

const state: RouterState = {
  task: 'fix', phase: 'post_test', loaded: 'few', unloadedCandidates: 'none',
  tests: { lastRun: 'passed', dirtySinceLastRun: false }, lastActions: ['run_tests'],
};

test('computes objective routing error rates', async () => {
  let count = 0;
  const router: Router = { async route() {
    count++;
    return count === 1 ? { action: 'stop', source: 'decision_model' } : { action: 'reason', source: 'fallback' };
  } };
  const metrics = await evaluateRouter(router, [
    { id: 'false-stop', state, feasible: ['reason', 'stop'], labels: { shouldStop: false } },
    { id: 'miss', state, feasible: ['reason', 'retrieve_context'], labels: { needsRetrieval: true } },
  ]);
  assert.deepEqual(metrics, {
    decisions: 2, stopNegativeDecisions: 1, stopPositiveDecisions: 0,
    retrievalPositiveDecisions: 1, falseStopRate: 1, falseContinueRate: 0,
    missedRetrievalRate: 1, invalidDecisionRate: 0,
    readDecisions: 0, invalidReadTargetRate: 0, fallbackRate: 0.5,
  });
});

test('counts malformed router results as invalid decisions', async () => {
  const metrics = await evaluateRouter({ async route() {
    return { action: 'reason', source: 'invalid' } as never;
  } }, [{ id: 'bad', state, feasible: ['reason'], labels: {} }]);
  assert.equal(metrics.decisions, 1);
  assert.equal(metrics.invalidDecisionRate, 1);
  assert.equal(metrics.fallbackRate, 0);
});

test('validates opaque read targets through the candidate path map', async () => {
  let count = 0;
  const metrics = await evaluateRouter({ async route() {
    return { action: 'read_file', args: { target: count++ ? 'other-id' : 'auth-id' }, source: 'decision_model' };
  } }, [
    { id: 'valid', state, feasible: ['read_file'], candidatePaths: { 'auth-id': 'auth.ts' }, labels: { validReadTargets: ['auth.ts'] } },
    { id: 'invalid', state, feasible: ['read_file'], candidatePaths: { 'other-id': 'other.ts' }, labels: { validReadTargets: ['auth.ts'] } },
  ]);
  assert.equal(metrics.readDecisions, 2);
  assert.equal(metrics.invalidReadTargetRate, 0.5);
  assert.equal(metrics.invalidDecisionRate, 0.5);
});
