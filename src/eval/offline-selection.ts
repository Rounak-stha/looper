import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ContextProviderFactory, WorkspaceProvider } from '../core/plugins.js';
import type { Selector } from '../core/types.js';
import type { AgentTask, EvaluationTask } from './tasks.js';
import { agentTask, parseTaskDataset } from './tasks.js';
import { selectionMetrics } from './metrics.js';
import { validateContextCandidates, validateSelectionResult } from '../selection/validate.js';

export interface OfflineSelectionOptions {
  tasksPath: string;
  outputPath: string;
  selectorId: string;
  selectorFor(task: AgentTask): Selector;
  workspaces: WorkspaceProvider;
  context: ContextProviderFactory;
  candidates: number;
  maxItems: number;
  maxTokens: number;
}

export async function evaluateOfflineSelection(options: OfflineSelectionOptions): Promise<Record<string, unknown>> {
  const tasks = parseTaskDataset(await readFile(options.tasksPath, 'utf8'));
  await mkdir(dirname(options.outputPath), { recursive: true });
  const temporaryPath = `${options.outputPath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, '');
  const results: Array<{ recall: number; precision: number; allGoldSelected: boolean; candidateRecall: number }> = [];

  try {
    for (const task of tasks) {
    const workspace = await options.workspaces.acquire(task);
    try {
      const publicTask = agentTask(task);
      const provider = await options.context.create({ workspacePath: workspace.path, task: publicTask });
      const candidateStarted = performance.now();
      const candidates = await provider.search(task.task, { limit: options.candidates });
      validateContextCandidates(candidates, options.candidates);
      const candidateGenerationMs = performance.now() - candidateStarted;
      const selector = options.selectorFor(publicTask);
      const started = performance.now();
      const selection = await selector.select({
        task: task.task, candidates, alreadyLoaded: [],
        budget: { maxItems: options.maxItems, maxTokens: options.maxTokens },
      });
      validateSelectionResult(candidates, selection, { maxItems: options.maxItems, maxTokens: options.maxTokens });
      const metrics = selectionMetrics(selection.selected, task.goldFiles, candidates);
      const candidatePaths = new Set(candidates.map(({ path }) => path));
      const candidateRecall = task.goldFiles.filter((path) => candidatePaths.has(path)).length / task.goldFiles.length;
      results.push({ ...metrics, candidateRecall });
      await appendFile(temporaryPath, `${JSON.stringify({
        type: 'selection_eval', task_id: task.id, selector: options.selectorId,
        candidates: candidates.map(({ id }) => id), selected: selection.selected,
        scores: selection.scores, metrics: { ...metrics, candidateRecall },
        candidate_generation_ms: candidateGenerationMs, latency_ms: performance.now() - started,
      })}\n`);
      } finally {
        await workspace.release();
      }
    }
    await rename(temporaryPath, options.outputPath);
    return {
      tasks: results.length,
      selector: options.selectorId,
      candidate_recall: mean(results.map(({ candidateRecall }) => candidateRecall)),
      recall: mean(results.map(({ recall }) => recall)),
      precision: mean(results.map(({ precision }) => precision)),
      all_gold_selected_rate: mean(results.map(({ allGoldSelected }) => Number(allGoldSelected))),
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
