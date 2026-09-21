import { readFile } from 'node:fs/promises';
import type { AgentAction, RouterState } from '../core/types.js';
import { evaluateRouter, type LabeledRoutingState, type RoutingReplayMetrics } from './routing-replay.js';
import type { Router } from '../core/types.js';

export async function evaluateRoutingReplayFile(path: string, router: Router): Promise<RoutingReplayMetrics> {
  const cases = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(parseRoutingCase);
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate routing replay id '${item.id}'`);
    ids.add(item.id);
  }
  return evaluateRouter(router, cases);
}

export function parseRoutingCase(line: string): LabeledRoutingState {
  const value = JSON.parse(line) as Partial<LabeledRoutingState>;
  const actions: AgentAction[] = ['reason', 'retrieve_context', 'read_file', 'run_tests', 'stop'];
  if (typeof value.id !== 'string' || !value.id || !validState(value.state)
    || !Array.isArray(value.feasible) || value.feasible.length === 0
    || value.feasible.some((action) => !actions.includes(action))
    || new Set(value.feasible).size !== value.feasible.length
    || !value.labels || typeof value.labels !== 'object') {
    throw new Error('Invalid routing replay record');
  }
  if (value.candidatePaths !== undefined && (!value.candidatePaths || typeof value.candidatePaths !== 'object'
    || Array.isArray(value.candidatePaths) || Object.entries(value.candidatePaths).some(([id, path]) => !id || typeof path !== 'string' || !path))) {
    throw new Error('Invalid routing candidate path map');
  }
  const labels = value.labels;
  if ((labels.shouldStop !== undefined && typeof labels.shouldStop !== 'boolean')
    || (labels.needsRetrieval !== undefined && typeof labels.needsRetrieval !== 'boolean')
    || (labels.validReadTargets !== undefined && (!Array.isArray(labels.validReadTargets)
      || labels.validReadTargets.some((path) => typeof path !== 'string' || !path)
      || new Set(labels.validReadTargets).size !== labels.validReadTargets.length))) {
    throw new Error('Invalid routing labels');
  }
  return {
    id: value.id, state: value.state, feasible: value.feasible,
    ...(value.candidatePaths ? { candidatePaths: value.candidatePaths } : {}), labels,
  };
}

function validState(value: unknown): value is RouterState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<RouterState>;
  return typeof state.task === 'string'
    && ['start', 'context_loaded', 'post_edit', 'post_test'].includes(String(state.phase))
    && ['none', 'few', 'many'].includes(String(state.loaded))
    && ['none', 'some'].includes(String(state.unloadedCandidates))
    && !!state.tests && ['never', 'passed', 'failed'].includes(String(state.tests.lastRun))
    && typeof state.tests.dirtySinceLastRun === 'boolean'
    && (state.completionPolicy === undefined || ['visible_tests', 'submission'].includes(state.completionPolicy))
    && (state.hasSuccessfulEdit === undefined || typeof state.hasSuccessfulEdit === 'boolean')
    && Array.isArray(state.lastActions)
    && state.lastActions.length <= 3
    && state.lastActions.every((action) => ['reason', 'retrieve_context', 'read_file', 'run_tests', 'stop'].includes(action));
}
