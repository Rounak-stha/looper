import { BudgetExceededError } from '../core/ledger.js';
import type { AgentAction, Router, RouterState } from '../core/types.js';
import { nextActionChoice, taskCompleteNoul } from '../decisions/questions.js';
import type { DecisionModel } from '../decisions/types.js';
import { feasibleActions, type RuntimeFacts } from './feasible.js';

export interface DecisionRouterOptions { tauRoute: number; tauStop: number }

export class DecisionModelRouter implements Router {
  constructor(
    private readonly model: DecisionModel,
    private readonly options: DecisionRouterOptions,
    private readonly facts: (state: RouterState) => RuntimeFacts = () => ({}),
  ) {}

  async route(input: Parameters<Router['route']>[0]): ReturnType<Router['route']> {
    const stateFacts: RuntimeFacts = {
      ...(input.state.completionPolicy === undefined ? {} : { completionPolicy: input.state.completionPolicy }),
      ...(input.state.hasSuccessfulEdit === undefined ? {} : { hasSuccessfulEdit: input.state.hasSuccessfulEdit }),
    };
    const facts = { ...stateFacts, ...this.facts(input.state) };
    const allowedByRules = new Set(feasibleActions(input.state, facts));
    const feasible = input.feasible.filter((action) => allowedByRules.has(action));
    if (feasible.length === 1) return { action: feasible[0]!, source: 'rule' };
    if (!feasible.length) return { action: 'reason', source: 'fallback' };

    try {
      const result = await this.model.ask(routerState(input.state), nextActionChoice(feasible), { purpose: 'route' });
      const answer = result.choices.next_action;
      if (!answer) return { action: 'reason', source: 'fallback' };
      const action = answer.choice as AgentAction;
      const probability = answer.probabilities[action] ?? 0;
      if (!feasible.includes(action) || probability < this.options.tauRoute) {
        return { action: 'reason', probs: answer.probabilities, source: 'fallback' };
      }
      if (action === 'stop') {
        const deterministicStop = input.state.completionPolicy === 'submission'
          ? input.state.hasSuccessfulEdit === true
          : input.state.tests.lastRun === 'passed' && !input.state.tests.dirtySinceLastRun;
        if (!deterministicStop) return { action: 'reason', probs: answer.probabilities, source: 'fallback' };
        const stop = await this.model.ask(routerState(input.state), taskCompleteNoul, { purpose: 'stop_gate' });
        if ((stop.nouls.task_complete ?? 0) < this.options.tauStop) {
          return { action: 'reason', probs: answer.probabilities, source: 'fallback' };
        }
      }
      return { action, probs: answer.probabilities, source: 'decision_model' };
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error;
      return { action: 'reason', source: 'fallback' };
    }
  }
}

function routerState(state: RouterState): Record<string, unknown> {
  return {
    task: state.task, phase: state.phase, loaded: state.loaded,
    unloaded_candidates: state.unloadedCandidates,
    tests: { last_run: state.tests.lastRun, dirty_since_last_run: state.tests.dirtySinceLastRun },
    completion_policy: state.completionPolicy ?? 'visible_tests',
    has_successful_edit: state.hasSuccessfulEdit ?? false,
    last_actions: state.lastActions.slice(-3),
  };
}
