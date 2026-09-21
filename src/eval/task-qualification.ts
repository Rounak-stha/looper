import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskSource, TaskValidator } from '../core/plugins.js';
import { writeTaskSplits } from '../tasks/io.js';
import { splitTasks } from '../tasks/split.js';
import { qualifyTask } from './task-validation.js';
import { assertUniqueTaskIds, parseTaskDataset, type EvaluationTask } from './tasks.js';

export interface QualifyMinedTasksOptions {
  source: TaskSource;
  validator: TaskValidator;
  location: string;
  limit: number;
  seed?: number;
  testFraction?: number;
  candidatesPath: string;
  validPath: string;
  devPath: string;
  testPath: string;
  resultsPath: string;
}

export interface TaskQualificationSummary {
  mined: number;
  valid: number;
  invalid: number;
  dev: number;
  test: number;
  reasons: Record<string, number>;
}

/** Mines plugin-owned candidates, qualifies them, then assigns frozen splits only to valid tasks. */
export async function qualifyMinedTasks(options: QualifyMinedTasksOptions): Promise<TaskQualificationSummary> {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('Task qualification limit must be a positive integer');
  const mined = validateMinedTasks(await options.source.mine(options.location, { limit: options.limit }));
  await Promise.all([
    mkdir(dirname(options.candidatesPath), { recursive: true }),
    mkdir(dirname(options.validPath), { recursive: true }),
    mkdir(dirname(options.resultsPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(options.candidatesPath, jsonl(mined)),
    writeFile(options.resultsPath, ''),
  ]);

  const valid: EvaluationTask[] = [];
  const reasons: Record<string, number> = {};
  for (const task of mined) {
    const result = await qualifyTask(task, options.validator);
    if (result.valid) valid.push(task);
    else {
      const reason = typeof result.evidence.reason === 'string' ? result.evidence.reason : 'validation_error';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    await appendFile(options.resultsPath, `${JSON.stringify(result.evidence)}\n`);
  }

  const split = splitTasks(valid, options.testFraction ?? 0.5, options.seed ?? 1);
  await Promise.all([
    writeFile(options.validPath, jsonl(split)),
    writeTaskSplits(split, options.devPath, options.testPath),
  ]);
  return {
    mined: mined.length, valid: valid.length, invalid: mined.length - valid.length,
    dev: split.filter((task) => task.split === 'dev').length,
    test: split.filter((task) => task.split === 'test').length,
    reasons: Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function validateMinedTasks(tasks: EvaluationTask[]): EvaluationTask[] {
  if (!Array.isArray(tasks)) throw new Error('Task source returned an invalid task list');
  assertUniqueTaskIds(tasks);
  // Reuse the durable dataset parser so plugin-produced records meet the same strict schema as files.
  return parseTaskDataset(jsonl(tasks));
}

function jsonl(tasks: EvaluationTask[]): string {
  return tasks.map((task) => JSON.stringify(task)).join('\n') + (tasks.length ? '\n' : '');
}
