import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { qualifyMinedTasks } from './task-qualification.js';
import type { EvaluationTask } from './tasks.js';

const tasks: EvaluationTask[] = ['a', 'b', 'c'].map((id) => ({
  id, type: 'T-fix', task: `fix ${id}`, goldFiles: [`${id}.ts`], testFiles: [`${id}.test.ts`],
  source: { kind: 'fixture', data: {} },
}));

test('qualification validates before assigning deterministic splits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-qualification-'));
  const paths = {
    candidatesPath: join(root, 'candidates.jsonl'), validPath: join(root, 'valid.jsonl'), devPath: join(root, 'dev.jsonl'),
    testPath: join(root, 'test.jsonl'), resultsPath: join(root, 'evidence.jsonl'),
  };
  const summary = await qualifyMinedTasks({
    ...paths, location: 'opaque', limit: 3, seed: 7,
    source: { async mine(location, options) {
      assert.equal(location, 'opaque'); assert.equal(options?.limit, 3); return tasks;
    } },
    validator: { async validate(task) {
      if (task.id === 'b') return {
        before: { passed: true, exitCode: 0, durationMs: 1 },
        after: { passed: true, exitCode: 0, durationMs: 1 },
      };
      return {
        before: { passed: false, exitCode: 1, durationMs: 1 },
        after: { passed: true, exitCode: 0, durationMs: 1 },
      };
    } },
  });
  assert.equal(summary.mined, 3);
  assert.equal(summary.valid, 2);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.dev + summary.test, 2);
  assert.deepEqual(summary.reasons, { tests_passed_before_patch: 1 });
  const datasets = `${await readFile(paths.devPath, 'utf8')}\n${await readFile(paths.testPath, 'utf8')}`;
  assert.match(datasets, /"id":"a"/);
  assert.match(datasets, /"id":"c"/);
  assert.doesNotMatch(datasets, /"id":"b"/);
  assert.equal((await readFile(paths.candidatesPath, 'utf8')).trim().split('\n').length, 3);
  assert.equal((await readFile(paths.validPath, 'utf8')).trim().split('\n').length, 2);
  assert.equal((await readFile(paths.resultsPath, 'utf8')).trim().split('\n').length, 3);
});
