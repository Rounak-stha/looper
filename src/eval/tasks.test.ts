import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTask, parseTaskDataset } from './tasks.js';

const valid = {
  id: 'a', type: 'T-fix', task: 'fix it', goldFiles: ['a.ts'], testFiles: ['a.test.ts'],
  source: { kind: 'fixture', data: {} }, reporting: { repository: 'repo' },
};

test('parses a strict T-fix task record', () => {
  assert.equal(parseTask(JSON.stringify(valid)).id, 'a');
  assert.throws(() => parseTask(JSON.stringify({ ...valid, goldFiles: ['a.ts', 'a.ts'] })), /duplicate/);
  assert.throws(() => parseTask(JSON.stringify({ ...valid, reporting: { repository: 1 } })), /reporting/);
  assert.throws(() => parseTask(JSON.stringify({ ...valid, source: { kind: 'fixture', data: [] } })), /Invalid/);
});

test('parses T-issue separately without exposing privileged provenance to the agent', () => {
  const issue = parseTask(JSON.stringify({ ...valid, type: 'T-issue', gold: { sourcePatch: 'secret' } }));
  assert.equal(issue.type, 'T-issue');
  assert.throws(() => parseTask(JSON.stringify({ ...valid, type: 'T-greenfield' })), /Invalid task record/);
});

test('task datasets reject duplicate stable IDs', () => {
  const line = JSON.stringify(valid);
  assert.throws(() => parseTaskDataset(`${line}\n${line}\n`), /Duplicate task id/);
});
