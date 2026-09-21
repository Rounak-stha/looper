import type { Router } from '../core/types.js';
import { deterministicRoute, feasibleActions, type RuntimeFacts } from './feasible.js';

export class RulesRouter implements Router {
  constructor(private readonly facts: (state: Parameters<Router['route']>[0]['state']) => RuntimeFacts = () => ({})) {}

  async route(input: Parameters<Router['route']>[0]): ReturnType<Router['route']> {
    const stateFacts: RuntimeFacts = {
      ...(input.state.completionPolicy === undefined ? {} : { completionPolicy: input.state.completionPolicy }),
      ...(input.state.hasSuccessfulEdit === undefined ? {} : { hasSuccessfulEdit: input.state.hasSuccessfulEdit }),
    };
    const facts = { ...stateFacts, ...this.facts(input.state) };
    const allowed = new Set(feasibleActions(input.state, facts));
    const feasible = input.feasible.filter((action) => allowed.has(action));
    const preferred = deterministicRoute(input.state, facts);
    return { action: feasible.includes(preferred) ? preferred : feasible[0]!, source: 'rule' };
  }
}
