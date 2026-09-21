import { createHash } from 'node:crypto';
import type { RunManifest } from './events.js';

export interface ManifestInput {
  config: unknown;
  datasetVersion: string;
  modelIds: string[];
  decisionModelIds: string[];
  gitSha?: string;
  environmentId?: string;
}

export function createRunManifest(input: ManifestInput): RunManifest {
  if (!input.datasetVersion.trim()) throw new Error('datasetVersion is required');
  if (input.modelIds.some((id) => !id.trim()) || input.decisionModelIds.some((id) => !id.trim())) {
    throw new Error('Manifest model IDs must be non-empty');
  }
  return {
    datasetVersion: input.datasetVersion,
    configHash: canonicalHash(input.config),
    modelIds: [...input.modelIds].sort(),
    decisionModelIds: [...input.decisionModelIds].sort(),
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
  };
}

/** Stable across object key order; rejects values JSON cannot reproduce faithfully. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Configuration numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new Error(`Configuration value '${key}' is undefined`);
      return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
    }).join(',')}}`;
  }
  throw new Error(`Unsupported configuration value: ${typeof value}`);
}
