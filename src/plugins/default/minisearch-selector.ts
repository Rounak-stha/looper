import MiniSearch from 'minisearch';
import type { ScoredCandidate, Selector } from '../../core/types.js';
import { applyBudget } from '../../selection/policy.js';

interface CandidateDocument { id: string; path: string; symbol: string; summary: string }

/** S1 adapter backed by MiniSearch's BM25 implementation. */
export class Bm25Selector implements Selector {
  async select(input: Parameters<Selector['select']>[0]): ReturnType<Selector['select']> {
    const index = new MiniSearch<CandidateDocument>({
      fields: ['path', 'symbol', 'summary'],
      searchOptions: { boost: { path: 2, symbol: 1.5 }, prefix: true, fuzzy: 0.2 },
    });
    index.addAll(input.candidates.map((candidate) => ({
      id: candidate.id, path: candidate.path,
      symbol: candidate.symbol ?? '', summary: candidate.summary ?? '',
    })));
    const results = index.search(input.task);
    const raw = new Map(results.map((result) => [String(result.id), result.score]));
    const max = Math.max(...raw.values(), 1);
    const scores: ScoredCandidate[] = input.candidates.map(({ id }) => ({
      id, p: (raw.get(id) ?? 0) / max, via: 'bm25',
    }));
    return { ...applyBudget(input.candidates, scores, input.budget), scores, meta: { kind: 'bm25', engine: 'minisearch' } };
  }
}
