import type { CandidateId, ContextCandidate, ScoredCandidate } from '../core/types.js';

export interface SelectionBudget { maxItems: number; maxTokens: number }

export function applyBudget(
  candidates: ContextCandidate[], scores: ScoredCandidate[], budget: SelectionBudget,
): { selected: CandidateId[]; unselected: CandidateId[] } {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ranked = [...scores].sort((a, b) => b.p - a.p || a.id.localeCompare(b.id));
  const selected: CandidateId[] = [];
  let tokens = 0;
  for (const score of ranked) {
    const candidate = byId.get(score.id);
    if (!candidate || selected.length >= budget.maxItems) continue;
    if (tokens + candidate.approxTokens > budget.maxTokens) continue;
    selected.push(candidate.id);
    tokens += candidate.approxTokens;
  }
  const selectedSet = new Set(selected);
  return { selected, unselected: candidates.map(({ id }) => id).filter((id) => !selectedSet.has(id)) };
}
