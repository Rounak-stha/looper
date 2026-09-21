import type { AgentAction, RouterState } from '../core/types.js';

export interface RuntimeFacts {
  lastToolErrored?: boolean;
  pendingFileTargets?: boolean;
  completionPolicy?: 'visible_tests' | 'submission';
  hasSuccessfulEdit?: boolean;
}

/** Hard safety constraints. A router may choose only from this returned set. */
export function feasibleActions(state: RouterState, facts: RuntimeFacts = {}): AgentAction[] {
  if (facts.lastToolErrored) return ['reason'];
  if (state.loaded === 'none') return state.unloadedCandidates === 'some' ? ['retrieve_context'] : ['reason'];
  if (facts.completionPolicy !== 'submission' && state.tests.dirtySinceLastRun) return ['run_tests'];

  const actions: AgentAction[] = ['reason'];
  if (state.unloadedCandidates === 'some') {
    actions.push('retrieve_context');
    if (facts.pendingFileTargets !== false) actions.push('read_file');
  }
  if (state.tests.lastRun === 'failed' || (facts.completionPolicy === 'submission' && state.tests.dirtySinceLastRun)) actions.push('run_tests');
  if (state.tests.lastRun === 'passed' || (facts.completionPolicy === 'submission' && facts.hasSuccessfulEdit)) actions.push('stop');
  return actions;
}

export function deterministicRoute(state: RouterState, facts: RuntimeFacts = {}): AgentAction {
  const feasible = feasibleActions(state, facts);
  if (feasible.includes('stop') && (facts.completionPolicy === 'submission'
    ? facts.hasSuccessfulEdit : state.tests.lastRun === 'passed' && !state.tests.dirtySinceLastRun)) return 'stop';
  return feasible[0]!;
}
