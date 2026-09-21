import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateTasks } from './task-validation.js';
import type { EvaluationTask } from './tasks.js';

const task: EvaluationTask = {
  id: 'fixture', type: 'T-fix', task: 'fix it', goldFiles: ['a.ts'], testFiles: ['a.test.ts'],
  source: { kind: 'anything', data: {} },
};

test('task validation delegates execution entirely to the plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-validation-'));
  const inputPath = join(root, 'input.jsonl');
  const validPath = join(root, 'valid.jsonl');
  const resultsPath = join(root, 'results.jsonl');
  await writeFile(inputPath, `${JSON.stringify(task)}\n`);
  const summary = await validateTasks({
    inputPath, validPath, resultsPath,
    validator: { async validate() {
      return {
        before: { passed: false, exitCode: 1, durationMs: 2, output: 'secret failure' },
        after: { passed: true, exitCode: 0, durationMs: 3, output: 'secret pass' },
      };
    } },
  });
  assert.deepEqual(summary, { total: 1, valid: 1, invalid: 0 });
  assert.match(await readFile(validPath, 'utf8'), /"fixture"/);
  const evidence = JSON.parse((await readFile(resultsPath, 'utf8')).trim()) as { before: Record<string, unknown> };
  assert.equal(evidence.before.output, undefined);
  assert.equal(evidence.before.outputChars, 14);
  assert.match(String(evidence.before.outputHash), /^[a-f0-9]{64}$/);
});

test('task validation rejects contradictory plugin evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-validation-evidence-'));
  const inputPath = join(root, 'input.jsonl');
  const validPath = join(root, 'valid.jsonl');
  const resultsPath = join(root, 'results.jsonl');
  await writeFile(inputPath, `${JSON.stringify(task)}\n`);
  const summary = await validateTasks({
    inputPath, validPath, resultsPath,
    validator: { async validate() {
      return {
        before: { passed: true, exitCode: 0, durationMs: 1 }, after: { passed: true, exitCode: 0, durationMs: 1 },
        reason: 'plugin_claimed_something_else',
      };
    } },
  });
  assert.deepEqual(summary, { total: 1, valid: 0, invalid: 1 });
  const evidence = await readFile(resultsPath, 'utf8');
  assert.match(evidence, /tests_passed_before_patch/);
  assert.doesNotMatch(evidence, /plugin_claimed_something_else/);
});

test('task validation replaces stale evidence and hashes validator exceptions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-validation-error-'));
  const inputPath = join(root, 'input.jsonl');
  const validPath = join(root, 'valid.jsonl');
  const resultsPath = join(root, 'results.jsonl');
  await writeFile(inputPath, `${JSON.stringify(task)}\n`);
  await writeFile(resultsPath, '{"stale":true}\n');
  await validateTasks({
    inputPath, validPath, resultsPath,
    validator: { async validate() { throw new Error('privileged output must not persist'); } },
  });
  const evidence = await readFile(resultsPath, 'utf8');
  assert.doesNotMatch(evidence, /stale|privileged output/);
  const parsed = JSON.parse(evidence) as { error: Record<string, unknown> };
  assert.match(String(parsed.error.messageHash), /^[a-f0-9]{64}$/);
  assert.equal(parsed.error.messageChars, 34);
});
