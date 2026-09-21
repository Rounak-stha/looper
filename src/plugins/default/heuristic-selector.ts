import type { ScoredCandidate, Selector } from '../../core/types.js';
import { applyBudget } from '../../selection/policy.js';

const segment = new Intl.Segmenter('en', { granularity: 'word' });

export class HeuristicSelector implements Selector {
  async select(input: Parameters<Selector['select']>[0]): ReturnType<Selector['select']> {
    const taskTerms = new Set(terms(input.task));
    const raw = input.candidates.map((candidate) => {
      const pathTerms = new Set(terms(candidate.path));
      const summaryTerms = new Set(terms(candidate.summary ?? ''));
      const pathOverlap = [...taskTerms].filter((term) => pathTerms.has(term)).length;
      const summaryOverlap = [...taskTerms].filter((term) => summaryTerms.has(term)).length;
      const testBonus = candidate.kind === 'test' && /test|spec|fail/.test(input.task.toLowerCase()) ? 0.5 : 0;
      return { id: candidate.id, raw: pathOverlap * 2 + summaryOverlap + testBonus };
    });
    const max = Math.max(...raw.map(({ raw: value }) => value), 1);
    const scores: ScoredCandidate[] = raw.map(({ id, raw: value }) => ({ id, p: value / max, via: 'heuristic' }));
    return { ...applyBudget(input.candidates, scores, input.budget), scores, meta: { kind: 'heuristic' } };
  }
}

function terms(text: string): string[] {
  return [...segment.segment(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase())]
    .filter(({ isWordLike }) => isWordLike).map(({ segment: value }) => value);
}
