import type { ScoredCandidate, Selector } from '../core/types.js';
import { applyBudget } from './policy.js';

export class OracleSelector implements Selector {
  constructor(private readonly goldFiles: ReadonlySet<string>) {}

  async select(input: Parameters<Selector['select']>[0]): ReturnType<Selector['select']> {
    const scores: ScoredCandidate[] = input.candidates.map(({ id, path }) => ({
      id, p: this.goldFiles.has(path) ? 1 : 0, via: 'oracle',
    }));
    return { ...applyBudget(input.candidates, scores.filter(({ p }) => p > 0), input.budget), scores, meta: { kind: 'oracle' } };
  }
}
