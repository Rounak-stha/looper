import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventSink } from './logger.js';
import { RunLogger } from './logger.js';
import type { ToolRuntime } from './plugins.js';
import { Session, SessionBudgetError } from './session.js';

const tools = {} as ToolRuntime;
const sink: EventSink = { async write() {} };

function session(maxSteps = 3): Session {
  return new Session('run', 'task', tools, new RunLogger(sink, { run_id: 'run', task_id: 'task', config_id: 'config' }), {
    maxSteps, maxReasoningTokens: 100, wallClockMs: 10_000,
  });
}

test('session retains only the last three actions', () => {
  const value = session(10);
  value.recordAction('reason'); value.recordAction('read_file'); value.recordAction('run_tests'); value.recordAction('reason');
  assert.deepEqual(value.lastActions, ['read_file', 'run_tests', 'reason']);
});

test('session enforces step and reasoning budgets', () => {
  const value = session(1);
  value.recordAction('reason');
  value.addReasoningTokens(10);
  assert.equal(value.reasoningTokens, 10);
  assert.throws(() => value.assertBudget(), SessionBudgetError);
  const tokens = session();
  assert.throws(() => tokens.addReasoningTokens(101), SessionBudgetError);
  assert.equal(tokens.reasoningTokens, 101);
});

test('session rejects invalid budgets and token usage', () => {
  assert.throws(() => session(0), /maxSteps/);
  const value = session();
  assert.throws(() => value.addReasoningTokens(-1), /non-negative integer/);
});
