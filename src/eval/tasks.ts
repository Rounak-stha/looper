export type EvaluationTaskType = 'T-fix' | 'T-issue';

export interface AgentTask {
  id: string;
  type: EvaluationTaskType;
  task: string;
  reporting?: Record<string, string>;
}

export interface EvaluationTask {
  id: string;
  type: EvaluationTaskType;
  task: string;
  goldFiles: string[];
  testFiles: string[];
  /** Opaque to the harness; interpreted only by the selected plugin. */
  source: { kind: string; data: Record<string, unknown> };
  /** Optional ground-truth artifacts are never passed to context providers or agents. */
  gold?: Record<string, unknown>;
  createdAt?: string;
  split?: 'dev' | 'test';
  /** Optional plugin-authored dimensions for reporting, such as repository or language. */
  reporting?: Record<string, string>;
}

export function agentTask(task: EvaluationTask): AgentTask {
  return {
    id: task.id, type: task.type, task: task.task,
    ...(task.reporting ? { reporting: { ...task.reporting } } : {}),
  };
}

export function parseTask(line: string): EvaluationTask {
  const value = JSON.parse(line) as Partial<EvaluationTask>;
  if (!nonempty(value.id) || !['T-fix', 'T-issue'].includes(String(value.type)) || !nonempty(value.task)
    || !value.source || !nonempty(value.source.kind) || !plainObject(value.source.data)) {
    throw new Error('Invalid task record');
  }
  if (!stringList(value.goldFiles) || !value.goldFiles.length || !stringList(value.testFiles) || !value.testFiles.length) {
    throw new Error(`Task ${value.id} requires non-empty source and test file lists`);
  }
  if (new Set(value.goldFiles).size !== value.goldFiles.length || new Set(value.testFiles).size !== value.testFiles.length) {
    throw new Error(`Task ${value.id} has duplicate source or test files`);
  }
  if (value.split !== undefined && value.split !== 'dev' && value.split !== 'test') throw new Error(`Task ${value.id} has invalid split`);
  if (value.createdAt !== undefined && !nonempty(value.createdAt)) throw new Error(`Task ${value.id} has invalid createdAt`);
  if (value.gold !== undefined && !plainObject(value.gold)) throw new Error(`Task ${value.id} has invalid gold data`);
  if (value.reporting !== undefined && (!plainObject(value.reporting)
    || Object.entries(value.reporting).some(([key, item]) => !key || !nonempty(item)))) {
    throw new Error(`Task ${value.id} has invalid reporting dimensions`);
  }
  return value as EvaluationTask;
}

export function parseTaskDataset(content: string): EvaluationTask[] {
  const tasks = content.split('\n').filter((line) => line.trim()).map(parseTask);
  assertUniqueTaskIds(tasks);
  return tasks;
}

export function assertUniqueTaskIds(tasks: readonly Pick<EvaluationTask, 'id'>[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!nonempty(task.id)) throw new Error('Task id must be a non-empty string');
    if (seen.has(task.id)) throw new Error(`Duplicate task id '${task.id}'`);
    seen.add(task.id);
  }
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
