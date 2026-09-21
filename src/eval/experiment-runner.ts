import { BudgetExceededError } from '../core/ledger.js';
import type { AgentRunDependencies, AgentRunOptions, AgentTaskResult } from './agent-runner.js';
import { runAgentTask } from './agent-runner.js';
import { assertUniqueTaskIds, type EvaluationTask } from './tasks.js';

export interface RunAdmissionController {
  admit(input: { task: EvaluationTask; repetition: number; estimatedCostUsd: number }): Promise<void>;
}

export interface AgentExperimentOptions extends Omit<AgentRunOptions, 'runId'> {
  runsPerTask: number;
  seed: number;
  estimatedCostPerRunUsd?: number;
  admission?: RunAdmissionController;
}

export interface AgentExperimentResult {
  completed: AgentTaskResult[];
  errors: Array<{ taskId: string; repetition: number; error: string }>;
}

/** Runs an arm sequentially to avoid workspace collisions and preserve deterministic ordering. */
export async function runAgentExperiment(
  tasks: EvaluationTask[],
  dependencies: AgentRunDependencies,
  options: AgentExperimentOptions,
): Promise<AgentExperimentResult> {
  assertUniqueTaskIds(tasks);
  if (!tasks.length) throw new Error('Agent experiment requires at least one task');
  if (!Number.isInteger(options.runsPerTask) || options.runsPerTask < 1) {
    throw new Error('runsPerTask must be a positive integer');
  }
  if (options.estimatedCostPerRunUsd !== undefined
    && (options.estimatedCostPerRunUsd < 0 || !Number.isFinite(options.estimatedCostPerRunUsd))) {
    throw new Error('estimatedCostPerRunUsd must be a finite non-negative number');
  }
  if (options.admission && options.estimatedCostPerRunUsd === undefined) {
    throw new Error('estimatedCostPerRunUsd is required when admission is configured');
  }

  const schedule = shuffle(
    tasks.flatMap((task) => Array.from({ length: options.runsPerTask }, (_, repetition) => ({ task, repetition }))),
    mulberry32(options.seed),
  );
  const completed: AgentTaskResult[] = [];
  const errors: AgentExperimentResult['errors'] = [];

  for (const { task, repetition } of schedule) {
    try {
      if (options.admission) {
        await options.admission.admit({ task, repetition, estimatedCostUsd: options.estimatedCostPerRunUsd! });
      }
      completed.push(await runAgentTask(task, dependencies, {
        ...options, runId: experimentRunId(options.configId, options.seed, task.id, repetition),
      }));
    } catch (error) {
      errors.push({
        taskId: task.id, repetition,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      if (error instanceof BudgetExceededError) break;
    }
  }
  return { completed, errors };
}

export class SpendLedgerAdmission implements RunAdmissionController {
  constructor(private readonly assertCanSpend: (estimatedUsd: number) => Promise<void>) {}
  admit(input: { estimatedCostUsd: number }): Promise<void> {
    return this.assertCanSpend(input.estimatedCostUsd);
  }
}

export function experimentRunId(configId: string, seed: number, taskId: string, repetition: number): string {
  return `run_${encodeURIComponent(configId)}_${seed}_${encodeURIComponent(taskId)}_${repetition}`;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}
