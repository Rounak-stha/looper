import { createHash } from 'node:crypto';
import type { TaskEvaluationResult } from '../core/plugins.js';
import { canonicalJson } from '../core/manifest.js';

export function validateTaskEvaluationResult(value: TaskEvaluationResult, label: string): void {
  if (!value || typeof value !== 'object') throw new Error(`${label} must return an object`);
  if (typeof value.passed !== 'boolean') throw new Error(`${label}.passed must be boolean`);
  if (!Number.isInteger(value.exitCode)) throw new Error(`${label}.exitCode must be an integer`);
  if (!Number.isFinite(value.durationMs) || value.durationMs < 0) throw new Error(`${label}.durationMs must be finite and non-negative`);
  if (value.output !== undefined && typeof value.output !== 'string') throw new Error(`${label}.output must be a string`);
  if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata))) {
    throw new Error(`${label}.metadata must be an object`);
  }
  if (value.metadata !== undefined) {
    try { canonicalJson(value.metadata); } catch (error) {
      throw new Error(`${label}.metadata must be reproducible JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function boundedExecutionEvidence(value: TaskEvaluationResult): Record<string, unknown> {
  return {
    passed: value.passed, exitCode: value.exitCode, durationMs: value.durationMs,
    ...(value.output !== undefined ? {
      outputHash: createHash('sha256').update(value.output).digest('hex'),
      outputChars: value.output.length,
    } : {}),
    ...(value.metadata ? boundedValue(value.metadata, 'metadata') : {}),
  };
}

function boundedValue(value: unknown, prefix: string): Record<string, unknown> {
  const encoded = canonicalJson(value);
  return {
    [`${prefix}Hash`]: createHash('sha256').update(encoded).digest('hex'),
    [`${prefix}Chars`]: encoded.length,
  };
}
