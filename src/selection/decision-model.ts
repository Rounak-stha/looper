import type { ContextCandidate, ScoredCandidate, Selector } from '../core/types.js';
import { sanitizeSummary, selectionChoice, selectionNouls } from '../decisions/questions.js';
import type { DecisionModel } from '../decisions/types.js';
import { applyBudget } from './policy.js';

export type DecisionSelectionKind = 'choice' | 'noul' | 'choice+noul';

export interface DecisionSelectorOptions {
  kind: DecisionSelectionKind;
  k: number;
  tauEdit: number;
  tauRead: number;
  cache?: 'use' | 'bypass';
  sanitizeSummaries?: boolean;
}

export class DecisionModelSelector implements Selector {
  constructor(private readonly model: DecisionModel, private readonly options: DecisionSelectorOptions) {}

  async select(input: Parameters<Selector['select']>[0]): ReturnType<Selector['select']> {
    const state = { task: input.task };
    const callOptions = { purpose: 'select' as const, ...(this.options.cache === undefined ? {} : { cache: this.options.cache }) };
    const choice = this.options.kind.includes('choice') && input.candidates.length >= 2
      ? await this.model.ask(state, selectionChoice(input.candidates, this.options.sanitizeSummaries !== false), callOptions) : undefined;
    const noul = this.options.kind.includes('noul')
      ? await this.model.ask(
        { task: input.task, candidates: candidateMap(input.candidates, this.options.sanitizeSummaries !== false) },
        selectionNouls(input.candidates), callOptions,
      ) : undefined;

    const known = new Set(input.candidates.map(({ id }) => id));
    const rawChoiceProbabilities = choice?.choices.most_important?.probabilities ?? {};
    const choiceProbabilities: Record<string, number> = Object.fromEntries(Object.entries(rawChoiceProbabilities)
      .filter(([id]) => known.has(id)));
    if (this.options.kind.includes('choice') && input.candidates.length === 1) {
      choiceProbabilities[input.candidates[0]!.id] = 1;
    }
    const rankedChoice = Object.entries(choiceProbabilities).sort((a, b) => b[1] - a[1]).slice(0, this.options.k);
    const selectedIds = new Set(rankedChoice.map(([id]) => id));
    for (const candidate of input.candidates) {
      if ((noul?.nouls[`edit::${candidate.id}`] ?? 0) >= this.options.tauEdit) selectedIds.add(candidate.id);
      if ((noul?.nouls[`read::${candidate.id}`] ?? 0) >= this.options.tauRead) selectedIds.add(candidate.id);
    }

    const scores: ScoredCandidate[] = input.candidates.map(({ id }) => ({
      id,
      p: Math.max(choiceProbabilities[id] ?? 0, noul?.nouls[`edit::${id}`] ?? 0, noul?.nouls[`read::${id}`] ?? 0),
      via: choiceProbabilities[id] !== undefined ? 'choice' as const : 'noul' as const,
    })).sort((a, b) => Number(selectedIds.has(b.id)) - Number(selectedIds.has(a.id)) || b.p - a.p);
    const budgeted = applyBudget(input.candidates, scores.filter(({ id }) => selectedIds.has(id)), input.budget);
    return {
      ...budgeted, scores,
      meta: {
        kind: this.options.kind, k: this.options.k, tauEdit: this.options.tauEdit, tauRead: this.options.tauRead,
        ...(choice === undefined ? {} : {
          choiceUsage: choice.usage, choiceLatencyMs: choice.latencyMs, choiceModel: choice.model, choiceCacheHit: choice.cacheHit,
        }),
        ...(noul === undefined ? {} : {
          noulUsage: noul.usage, noulLatencyMs: noul.latencyMs, noulModel: noul.model, noulCacheHit: noul.cacheHit,
        }),
      },
    };
  }
}

function candidateMap(candidates: ContextCandidate[], sanitize: boolean): Record<string, string> {
  return Object.fromEntries(candidates.map((candidate) => [candidate.id,
    `${candidate.path} | ${candidate.kind} | ${sanitize
      ? sanitizeSummary(candidate.summary ?? 'No summary available')
      : candidate.summary ?? 'No summary available'}`]));
}
