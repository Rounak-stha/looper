import type { ContextCandidate } from '../core/types.js';

export interface AgentExperimentConfig {
  configId: string;
  datasetVersion: string;
  selector: string;
  candidateLimit: number;
  poolCandidates?: number;
  candidateKinds?: ContextCandidate['kind'][];
  selectionBudget: { maxItems: number; maxTokens: number };
  initialContextMaxTokens: number;
  dynamicContextMaxTokens: number;
  sessionBudgets: { maxSteps: number; maxReasoningTokens: number; wallClockMs: number };
  runsPerTask: number;
  seed: number;
  estimatedCostPerRunUsd?: number;
  budget?: { capUsd: number; reservePct: number; runCapUsd?: number; ledgerPath: string; minimumTasks?: number };
  modelIds: string[];
  decisionModelIds: string[];
  reporting?: Record<string, string>;
  eventsPath: string;
  environmentId?: string;
}

export function parseAgentExperimentConfig(value: unknown): AgentExperimentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent config must be an object');
  const config = value as Record<string, unknown>;
  const selection = object(config.selectionBudget, 'selectionBudget');
  const session = object(config.sessionBudgets, 'sessionBudgets');
  const budget = config.budget === undefined ? undefined : object(config.budget, 'budget');
  return {
    configId: string(config.configId, 'configId'),
    datasetVersion: string(config.datasetVersion, 'datasetVersion'),
    selector: string(config.selector, 'selector'),
    candidateLimit: positiveInteger(config.candidateLimit, 'candidateLimit'),
    ...(config.poolCandidates === undefined ? {} : { poolCandidates: positiveInteger(config.poolCandidates, 'poolCandidates') }),
    ...(config.candidateKinds === undefined ? {} : { candidateKinds: candidateKinds(config.candidateKinds) }),
    selectionBudget: {
      maxItems: positiveInteger(selection.maxItems, 'selectionBudget.maxItems'),
      maxTokens: positiveInteger(selection.maxTokens, 'selectionBudget.maxTokens'),
    },
    initialContextMaxTokens: config.initialContextMaxTokens === undefined
      ? positiveInteger(selection.maxTokens, 'selectionBudget.maxTokens')
      : positiveInteger(config.initialContextMaxTokens, 'initialContextMaxTokens'),
    dynamicContextMaxTokens: config.dynamicContextMaxTokens === undefined
      ? positiveInteger(selection.maxTokens, 'selectionBudget.maxTokens')
      : positiveInteger(config.dynamicContextMaxTokens, 'dynamicContextMaxTokens'),
    sessionBudgets: {
      maxSteps: positiveInteger(session.maxSteps, 'sessionBudgets.maxSteps'),
      maxReasoningTokens: positiveInteger(session.maxReasoningTokens, 'sessionBudgets.maxReasoningTokens'),
      wallClockMs: positiveInteger(session.wallClockMs, 'sessionBudgets.wallClockMs'),
    },
    runsPerTask: positiveInteger(config.runsPerTask, 'runsPerTask'),
    seed: integer(config.seed, 'seed'),
    ...(config.estimatedCostPerRunUsd === undefined ? {} : {
      estimatedCostPerRunUsd: nonNegative(config.estimatedCostPerRunUsd, 'estimatedCostPerRunUsd'),
    }),
    ...(budget === undefined ? {} : { budget: {
      capUsd: positive(budget.capUsd, 'budget.capUsd'),
      reservePct: percentage(budget.reservePct ?? 0, 'budget.reservePct'),
      ...(budget.runCapUsd === undefined ? {} : { runCapUsd: positive(budget.runCapUsd, 'budget.runCapUsd') }),
      ledgerPath: string(budget.ledgerPath, 'budget.ledgerPath'),
      ...(budget.minimumTasks === undefined ? {} : { minimumTasks: positiveInteger(budget.minimumTasks, 'budget.minimumTasks') }),
    } }),
    modelIds: strings(config.modelIds, 'modelIds'),
    decisionModelIds: strings(config.decisionModelIds, 'decisionModelIds'),
    ...(config.reporting === undefined ? {} : { reporting: stringRecord(config.reporting, 'reporting') }),
    eventsPath: string(config.eventsPath, 'eventsPath'),
    ...(config.environmentId === undefined ? {} : { environmentId: string(config.environmentId, 'environmentId') }),
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function candidateKinds(value: unknown): ContextCandidate['kind'][] {
  const kinds = strings(value, 'candidateKinds');
  const allowed = new Set<ContextCandidate['kind']>(['file', 'symbol', 'test', 'git_change']);
  if (kinds.some((kind) => !allowed.has(kind as ContextCandidate['kind']))) throw new Error('candidateKinds contains an unknown kind');
  return kinds as ContextCandidate['kind'][];
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value as string[];
}
function stringRecord(value: unknown, name: string): Record<string, string> {
  const record = object(value, name);
  if (Object.values(record).some((item) => typeof item !== 'string')) throw new Error(`${name} values must be strings`);
  return record as Record<string, string>;
}
function nonNegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}
function positive(value: unknown, name: string): number {
  const number = nonNegative(value, name);
  if (number === 0) throw new Error(`${name} must be positive`);
  return number;
}
function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
function positiveInteger(value: unknown, name: string): number {
  const number = integer(value, name);
  if (number < 1) throw new Error(`${name} must be positive`);
  return number;
}
function percentage(value: unknown, name: string): number {
  const number = nonNegative(value, name);
  if (number >= 100) throw new Error(`${name} must be below 100`);
  return number;
}
