import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskValidator } from '../core/plugins.js';
import { parseTaskDataset, type EvaluationTask } from './tasks.js';
import { boundedExecutionEvidence, validateTaskEvaluationResult } from './execution-evidence.js';

export interface ValidateTasksOptions {
  inputPath: string;
  validPath: string;
  resultsPath: string;
  validator: TaskValidator;
}

export interface TaskQualificationResult {
  valid: boolean;
  evidence: Record<string, unknown>;
}

export async function qualifyTask(task: EvaluationTask, validator: TaskValidator): Promise<TaskQualificationResult> {
  const started = performance.now();
  try {
    const result = await validator.validate(task);
    validateTaskEvaluationResult(result.before, 'Task validator before evidence');
    validateTaskEvaluationResult(result.after, 'Task validator after evidence');
    const valid = !result.before.passed && result.after.passed;
    return {
      valid,
      evidence: {
        type: 'task_validation', task_id: task.id,
        before: boundedExecutionEvidence(result.before), after: boundedExecutionEvidence(result.after),
        ...(result.metadata ? boundedValidationMetadata(result.metadata) : {}),
        valid,
        reason: valid ? result.reason : evidenceFailureReason(result),
        totalDurationMs: performance.now() - started,
      },
    };
  } catch (error) {
    return {
      valid: false,
      evidence: {
        type: 'task_validation', task_id: task.id, valid: false,
        error: boundedValidationError(error),
        totalDurationMs: performance.now() - started,
      },
    };
  }
}

export async function validateTasks(options: ValidateTasksOptions): Promise<Record<string, number>> {
  const tasks = parseTaskDataset(await readFile(options.inputPath, 'utf8'));
  await Promise.all([mkdir(dirname(options.validPath), { recursive: true }), mkdir(dirname(options.resultsPath), { recursive: true })]);
  await writeFile(options.resultsPath, '');
  const valid: EvaluationTask[] = [];
  for (const task of tasks) {
    const qualification = await qualifyTask(task, options.validator);
    if (qualification.valid) valid.push(task);
    await appendFile(options.resultsPath, `${JSON.stringify(qualification.evidence)}\n`);
  }
  await writeFile(options.validPath, valid.map((task) => JSON.stringify(task)).join('\n') + (valid.length ? '\n' : ''));
  return { total: tasks.length, valid: valid.length, invalid: tasks.length - valid.length };
}

function boundedValidationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundedExecutionEvidence({ passed: true, exitCode: 0, durationMs: 0, metadata });
  return { metadataHash: bounded.metadataHash, metadataChars: bounded.metadataChars };
}

function boundedValidationError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    messageHash: createHash('sha256').update(message).digest('hex'),
    messageChars: message.length,
  };
}

function evidenceFailureReason(result: Awaited<ReturnType<TaskValidator['validate']>>): string {
  if (result.before.passed) return 'tests_passed_before_patch';
  if (!result.after.passed) return 'tests_failed_after_patch';
  return 'invalid_validation_evidence';
}
