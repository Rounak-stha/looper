import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ContextProviderFactory, WorkspaceProvider } from '../core/plugins.js';
import type { ContextCandidate, Selector } from '../core/types.js';
import { validateContextCandidates, validateSelectionResult } from '../selection/validate.js';
import { selectionMetrics } from './metrics.js';
import { agentTask, parseTaskDataset, type AgentTask } from './tasks.js';

export interface SelectionSweepArm {
  id: string;
  selector: string;
  candidates: number;
  maxItems: number;
  maxTokens: number;
  candidateKinds?: ContextCandidate['kind'][];
  /** Retrieval pool scanned before kind filtering; defaults to candidates. */
  poolCandidates?: number;
}

export interface SelectionSweepOptions {
  tasksPath: string;
  outputPath: string;
  arms: SelectionSweepArm[];
  selectorFor(selector: string, task: AgentTask): Selector;
  workspaces: WorkspaceProvider;
  context: ContextProviderFactory;
}

export async function evaluateSelectionSweep(options: SelectionSweepOptions): Promise<{
  tasks: number; arms: number; evaluations: number;
}> {
  validateArms(options.arms);
  const tasks = parseTaskDataset(await readFile(options.tasksPath, 'utf8'));
  await mkdir(dirname(options.outputPath), { recursive: true });
  const temporaryPath = `${options.outputPath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, '');
  const orderedArms = [...options.arms].sort((a, b) => a.id.localeCompare(b.id));
  try {
    for (const task of tasks) {
    const workspace = await options.workspaces.acquire(task);
    try {
      const publicTask = agentTask(task);
      const provider = await options.context.create({ workspacePath: workspace.path, task: publicTask });
      const startedCandidates = performance.now();
      const candidateLimit = Math.max(...orderedArms.map(({ candidates, poolCandidates }) => poolCandidates ?? candidates));
      const allCandidates = await provider.search(task.task, { limit: candidateLimit });
      validateContextCandidates(allCandidates, candidateLimit);
      const candidateGenerationMs = performance.now() - startedCandidates;
      for (const arm of orderedArms) {
        const eligibleCandidates = arm.candidateKinds
          ? allCandidates.filter(({ kind }) => arm.candidateKinds!.includes(kind))
          : allCandidates;
        const candidates = eligibleCandidates.slice(0, arm.candidates);
        const started = performance.now();
        const selection = await options.selectorFor(arm.selector, publicTask).select({
          task: task.task, candidates, alreadyLoaded: [],
          budget: { maxItems: arm.maxItems, maxTokens: arm.maxTokens },
        });
        validateSelectionResult(candidates, selection, { maxItems: arm.maxItems, maxTokens: arm.maxTokens });
        const metrics = selectionMetrics(selection.selected, task.goldFiles, candidates);
        const paths = new Set(candidates.map(({ path }) => path));
        const candidateRecall = task.goldFiles.filter((path) => paths.has(path)).length / task.goldFiles.length;
        await appendFile(temporaryPath, `${JSON.stringify({
          type: 'selection_eval', task_id: task.id, selector: arm.id,
          selector_kind: arm.selector, parameters: {
            candidates: arm.candidates, max_items: arm.maxItems, max_tokens: arm.maxTokens,
            ...(arm.candidateKinds ? { candidate_kinds: arm.candidateKinds } : {}),
            ...(arm.poolCandidates ? { pool_candidates: arm.poolCandidates } : {}),
          },
          candidates: candidates.map(({ id }) => id), selected: selection.selected, scores: selection.scores,
          metrics: { ...metrics, candidateRecall }, candidate_generation_ms: candidateGenerationMs,
          latency_ms: performance.now() - started, selector_meta: selection.meta,
        })}\n`);
      }
      } finally {
        await workspace.release();
      }
    }
    await rename(temporaryPath, options.outputPath);
    return { tasks: tasks.length, arms: orderedArms.length, evaluations: tasks.length * orderedArms.length };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function parseSelectionSweepConfig(value: unknown): SelectionSweepArm[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>).arms)) {
    throw new Error('Selection sweep config requires an arms array');
  }
  return ((value as Record<string, unknown>).arms as unknown[]).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Selection arm ${index} must be an object`);
    const arm = item as Record<string, unknown>;
    return {
      id: text(arm.id, `arms[${index}].id`), selector: text(arm.selector, `arms[${index}].selector`),
      candidates: positiveInteger(arm.candidates, `arms[${index}].candidates`),
      maxItems: positiveInteger(arm.maxItems, `arms[${index}].maxItems`),
      maxTokens: positiveInteger(arm.maxTokens, `arms[${index}].maxTokens`),
      ...(arm.candidateKinds === undefined ? {} : { candidateKinds: candidateKinds(arm.candidateKinds, index) }),
      ...(arm.poolCandidates === undefined ? {} : { poolCandidates: positiveInteger(arm.poolCandidates, `arms[${index}].poolCandidates`) }),
    };
  });
}

function candidateKinds(value: unknown, index: number): ContextCandidate['kind'][] {
  const allowed = new Set<ContextCandidate['kind']>(['file', 'symbol', 'test', 'git_change']);
  if (!Array.isArray(value) || !value.length || value.some((kind) => typeof kind !== 'string' || !allowed.has(kind as ContextCandidate['kind']))) {
    throw new Error(`arms[${index}].candidateKinds must be a non-empty array of known candidate kinds`);
  }
  const kinds = value as ContextCandidate['kind'][];
  if (new Set(kinds).size !== kinds.length) throw new Error(`arms[${index}].candidateKinds must be unique`);
  return kinds;
}

function validateArms(arms: SelectionSweepArm[]): void {
  if (!arms.length) throw new Error('Selection sweep requires at least one arm');
  if (new Set(arms.map(({ id }) => id)).size !== arms.length) throw new Error('Selection sweep arm IDs must be unique');
  for (const arm of arms) {
    if (!arm.id || !arm.selector || ![arm.candidates, arm.maxItems, arm.maxTokens].every((value) => Number.isInteger(value) && value > 0)) {
      throw new Error(`Invalid selection sweep arm '${arm.id}'`);
    }
    if (arm.poolCandidates !== undefined && arm.poolCandidates < arm.candidates) {
      throw new Error(`Selection sweep arm '${arm.id}' poolCandidates must be at least candidates`);
    }
  }
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
