import type { RunEvent, RunEventType } from './events.js';

const eventTypes = new Set<RunEventType>([
  'run_start', 'candidates', 'decision_call', 'selection', 'route', 'llm_call',
  'tool_call', 'escape', 'snapshot', 'agent_end', 'run_end',
]);

/** Validates the lifecycle and stable envelope of one run in original log order. */
export function validateRunEvents(events: readonly RunEvent[]): void {
  if (!events.length) throw new Error('Run event sequence must not be empty');
  const runId = events[0]!.run_id;
  const taskId = events[0]!.task_id;
  const configId = events[0]!.config_id;
  let starts = 0;
  let agentEnds = 0;
  let ends = 0;
  let agentEnded = false;
  let ended = false;
  let previousStep = -1;

  for (const [index, event] of events.entries()) {
    if (!eventTypes.has(event.type)) throw new Error(`Run '${runId}' has invalid event type at event ${index}`);
    if (!event.run_id || event.run_id !== runId) throw new Error(`Run '${runId}' has inconsistent run_id at event ${index}`);
    if (!event.task_id || event.task_id !== taskId) throw new Error(`Run '${runId}' has inconsistent task_id at event ${index}`);
    if (!event.config_id || event.config_id !== configId) throw new Error(`Run '${runId}' has inconsistent config_id at event ${index}`);
    if (!Number.isInteger(event.step) || event.step < 0) throw new Error(`Run '${runId}' has invalid step at event ${index}`);
    if (typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts))) throw new Error(`Run '${runId}' has invalid timestamp at event ${index}`);
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new Error(`Run '${runId}' has invalid payload at event ${index}`);
    if (event.step < previousStep) throw new Error(`Run '${runId}' has decreasing steps at event ${index}`);
    previousStep = event.step;
    if (ended) throw new Error(`Run '${runId}' has an event after run_end`);
    if (agentEnded && event.type !== 'run_end') throw new Error(`Run '${runId}' has an event after agent_end`);
    if (event.type === 'run_start') {
      starts++;
      if (index !== 0 || starts > 1) throw new Error(`Run '${runId}' has invalid run_start lifecycle`);
    }
    if (event.type === 'agent_end') {
      agentEnds++;
      agentEnded = true;
      if (agentEnds > 1) throw new Error(`Run '${runId}' has duplicate agent_end events`);
    }
    if (event.type === 'run_end') {
      ends++;
      ended = true;
    }
  }
  if (starts !== 1) throw new Error(`Run '${runId}' requires exactly one run_start`);
  if (ends !== 1) throw new Error(`Run '${runId}' requires exactly one run_end`);
  const terminal = events.at(-1)!;
  const hasRoute = events.some(({ type }) => type === 'route');
  if (hasRoute && agentEnds !== 1) throw new Error(`Run '${runId}' requires exactly one agent_end after routing begins`);
  if (!hasRoute && agentEnds === 0
    && !['budget', 'infrastructure_error'].includes(String(terminal.payload.termination_reason))) {
    throw new Error(`Run '${runId}' may omit agent_end only for a pre-agent budget or infrastructure failure`);
  }
}

export function groupAndValidateRunEvents(events: readonly RunEvent[]): Map<string, RunEvent[]> {
  const groups = new Map<string, RunEvent[]>();
  for (const event of events) {
    if (!event || typeof event !== 'object' || typeof event.run_id !== 'string' || !event.run_id) {
      throw new Error('Event requires a non-empty run_id');
    }
    const group = groups.get(event.run_id) ?? [];
    group.push(event);
    groups.set(event.run_id, group);
  }
  for (const group of groups.values()) validateRunEvents(group);
  return groups;
}
