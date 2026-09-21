import type { ContextCandidate } from '../core/types.js';

export interface SelectionMetrics {
  recall: number;
  precision: number;
  allGoldSelected: boolean;
  selectedCount: number;
  contextTokens: number;
}

/** Scores selected candidate IDs against gold file paths without assuming IDs are paths. */
export function selectionMetrics(
  selected: string[], goldFiles: string[], candidates: readonly ContextCandidate[],
): SelectionMetrics {
  const gold = new Set(goldFiles);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selectedIds = new Set(selected);
  const selectedPaths = new Set([...selectedIds].map((id) => byId.get(id)?.path).filter((path): path is string => path !== undefined));
  const truePositives = [...selectedPaths].filter((path) => gold.has(path)).length;
  return {
    recall: gold.size ? truePositives / gold.size : 1,
    precision: selectedPaths.size ? truePositives / selectedPaths.size : 0,
    allGoldSelected: [...gold].every((path) => selectedPaths.has(path)),
    selectedCount: selectedIds.size,
    contextTokens: [...selectedIds].reduce((sum, id) => sum + (byId.get(id)?.approxTokens ?? 0), 0),
  };
}
