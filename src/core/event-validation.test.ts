import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunEvent } from './events.js';
import { validateRunEvents } from './event-validation.js';

function event(type: RunEvent['type'], step: number): RunEvent {
  return { run_id: 'r', task_id: 't', config_id: 'c', step, ts: '2026-01-01T00:00:00Z', type, payload: {} };
}

test('accepts one complete ordered lifecycle', () => {
  assert.doesNotThrow(() => validateRunEvents([event('run_start', 0), event('route', 0), event('agent_end', 1), event('run_end', 1)]));
});

test('accepts pre-agent failures without an agent_end', () => {
  const end = event('run_end', 0);
  end.payload = { termination_reason: 'budget' };
  assert.doesNotThrow(() => validateRunEvents([event('run_start', 0), end]));
});

test('rejects incomplete, post-terminal, and decreasing-step logs', () => {
  assert.throws(() => validateRunEvents([event('route', 0), event('run_end', 1)]), /run_start/);
  assert.throws(() => validateRunEvents([event('run_start', 0), event('run_end', 1), event('route', 1)]), /after run_end/);
  assert.throws(() => validateRunEvents([event('run_start', 1), event('route', 0), event('run_end', 1)]), /decreasing/);
  const routedEnd = event('run_end', 1); routedEnd.payload = { termination_reason: 'infrastructure_error' };
  assert.throws(() => validateRunEvents([event('run_start', 0), event('route', 0), routedEnd]), /agent_end/);
  assert.throws(() => validateRunEvents([
    event('run_start', 0), event('agent_end', 1), event('snapshot', 1), event('run_end', 1),
  ]), /after agent_end/);
});
