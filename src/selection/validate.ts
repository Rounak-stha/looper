import { canonicalJson } from '../core/manifest.js';
import type { ContextCandidate, Selector } from '../core/types.js';

type SelectionResult = Awaited<ReturnType<Selector['select']>>;

export function validateContextCandidates(candidates: unknown, limit?: number): asserts candidates is ContextCandidate[] {
  if (!Array.isArray(candidates)) throw new Error('Context provider must return a candidate array');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error('Candidate limit must be a non-negative integer');
  if (limit !== undefined && candidates.length > limit) {
    throw new Error(`Context provider exceeded candidate limit: returned ${candidates.length}, maximum ${limit}`);
  }
  const ids = new Set<string>();
  const kinds = new Set(['file', 'symbol', 'test', 'git_change']);
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Context provider returned invalid candidate at index ${index}`);
    }
    const value = candidate as Record<string, unknown>;
    if (typeof value.id !== 'string' || !value.id.trim() || typeof value.path !== 'string' || !value.path.trim()) {
      throw new Error('Context provider returned a candidate without an ID or path');
    }
    if (ids.has(value.id)) throw new Error('Context provider returned duplicate candidate IDs');
    ids.add(value.id);
    if (!kinds.has(String(value.kind))) throw new Error(`Context provider returned invalid kind for '${value.id}'`);
    if (!Number.isInteger(value.approxTokens) || (value.approxTokens as number) < 0) {
      throw new Error(`Context provider returned invalid token estimate for '${value.id}'`);
    }
    if (value.symbol !== undefined && typeof value.symbol !== 'string') throw new Error(`Context provider returned invalid symbol for '${value.id}'`);
    if (value.summary !== undefined && typeof value.summary !== 'string') throw new Error(`Context provider returned invalid summary for '${value.id}'`);
    if (value.relations !== undefined && (!Array.isArray(value.relations)
      || value.relations.some((id) => typeof id !== 'string' || !id.trim()))) {
      throw new Error(`Context provider returned invalid relations for '${value.id}'`);
    }
  }
}

export function validateSelectionResult(
  candidates: readonly ContextCandidate[],
  result: SelectionResult,
  budget?: { maxItems: number; maxTokens: number },
): void {
  validateContextCandidates(candidates);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Array.isArray(result.selected) || result.selected.some((id) => typeof id !== 'string')
    || !Array.isArray(result.unselected) || result.unselected.some((id) => typeof id !== 'string')
    || !Array.isArray(result.scores)
    || !result.meta || typeof result.meta !== 'object' || Array.isArray(result.meta)) {
    throw new Error('Selector returned an invalid result envelope');
  }
  try { canonicalJson(result.meta); } catch (error) {
    throw new Error(`Selector metadata must be reproducible JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const known = new Set(candidates.map(({ id }) => id));
  assertUnique(result.selected, 'selected');
  assertUnique(result.unselected, 'unselected');
  const selected = new Set(result.selected);
  for (const id of [...result.selected, ...result.unselected]) {
    if (!known.has(id)) throw new Error(`Selector returned unknown candidate '${id}'`);
  }
  for (const id of result.unselected) {
    if (selected.has(id)) throw new Error(`Selector returned candidate '${id}' as both selected and unselected`);
  }
  const returned = new Set([...result.selected, ...result.unselected]);
  for (const id of known) {
    if (!returned.has(id)) throw new Error(`Selector omitted candidate '${id}' from its partition`);
  }
  if (budget) {
    if (!Number.isInteger(budget.maxItems) || budget.maxItems < 0
      || !Number.isInteger(budget.maxTokens) || budget.maxTokens < 0) {
      throw new Error('Selection budget must contain non-negative integer limits');
    }
    if (result.selected.length > budget.maxItems) {
      throw new Error(`Selector exceeded item budget: selected ${result.selected.length}, maximum ${budget.maxItems}`);
    }
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const tokens = result.selected.reduce((sum, id) => sum + byId.get(id)!.approxTokens, 0);
    if (tokens > budget.maxTokens) {
      throw new Error(`Selector exceeded token budget: selected ${tokens}, maximum ${budget.maxTokens}`);
    }
  }
  const scored = new Set<string>();
  const scoreKinds = new Set(['choice', 'noul', 'bm25', 'heuristic', 'llm', 'oracle']);
  for (const score of result.scores) {
    if (!score || typeof score !== 'object' || Array.isArray(score) || typeof score.id !== 'string') {
      throw new Error('Selector returned an invalid score');
    }
    if (!known.has(score.id)) throw new Error(`Selector scored unknown candidate '${score.id}'`);
    if (scored.has(score.id)) throw new Error(`Selector returned duplicate score for '${score.id}'`);
    scored.add(score.id);
    if (!scoreKinds.has(String(score.via))) throw new Error(`Selector returned invalid score source for '${score.id}'`);
    if (!Number.isFinite(score.p) || score.p < 0 || score.p > 1) {
      throw new Error(`Selector returned invalid score for '${score.id}'`);
    }
  }
}

function assertUnique(ids: readonly string[], name: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Selector returned duplicate ${name} candidate IDs`);
}
