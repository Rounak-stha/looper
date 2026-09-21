import assert from 'node:assert/strict';
import test from 'node:test';
import { taskFromRow } from './index.js';

const config = {
  dataset: 'SWE-bench/SWE-bench_Verified', split: 'test', cacheDirectory: '/tmp/cache',
  evaluationDirectory: '/tmp/eval', pythonCommand: 'python3', evaluationTimeoutMs: 1000,
};
const row = {
  repo: 'astropy/astropy', instance_id: 'astropy__astropy-12907',
  base_commit: 'd16bfe05a744909de4b27f5875fe0d4ed41ce607',
  patch: 'diff --git a/astropy/modeling/separable.py b/astropy/modeling/separable.py\n--- a/astropy/modeling/separable.py\n+++ b/astropy/modeling/separable.py\n',
  test_patch: 'diff --git a/astropy/modeling/tests/test_separable.py b/astropy/modeling/tests/test_separable.py\n--- a/astropy/modeling/tests/test_separable.py\n+++ b/astropy/modeling/tests/test_separable.py\n',
  problem_statement: 'Nested compound models have an incorrect separability matrix.',
  FAIL_TO_PASS: '["astropy/modeling/tests/test_separable.py::test_nested"]',
  PASS_TO_PASS: '["astropy/modeling/tests/test_separable.py::test_simple"]',
  version: '4.3', difficulty: '15 min - 1 hour', created_at: '2022-03-03T15:14:54Z',
};

test('maps an official SWE-bench row to a separate T-issue task', () => {
  const task = taskFromRow(row, config);
  assert.equal(task.type, 'T-issue');
  assert.equal(task.task, row.problem_statement);
  assert.deepEqual(task.goldFiles, ['astropy/modeling/separable.py']);
  assert.deepEqual(task.testFiles, ['astropy/modeling/tests/test_separable.py']);
  assert.equal(task.source.kind, 'swebench');
  assert.equal(task.source.data.repository, 'astropy/astropy');
  assert.equal(task.gold?.sourcePatch, row.patch);
  assert.deepEqual(task.gold?.failToPass, ['astropy/modeling/tests/test_separable.py::test_nested']);
});

test('rejects malformed official rows rather than creating unverifiable tasks', () => {
  assert.throws(() => taskFromRow({ ...row, FAIL_TO_PASS: 'not-json' }, config));
  assert.throws(() => taskFromRow({ ...row, patch: 'no diff headers' }, config), /no source files/);
});
