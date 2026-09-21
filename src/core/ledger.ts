import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LedgerEntry {
  ts: string;
  runId: string;
  taskId: string;
  role: string;
  tier: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class BudgetExceededError extends Error {
  incurredReasoningTokens?: number;
  constructor(readonly spentUsd: number, readonly requestedUsd: number, readonly capUsd: number) {
    super(`Budget exceeded: $${spentUsd.toFixed(6)} spent + $${requestedUsd.toFixed(6)} requested > $${capUsd.toFixed(6)} cap`);
    this.name = 'BudgetExceededError';
  }
}

export function callCost(inputTokens: number, outputTokens: number, priceInPerM: number, priceOutPerM: number): number {
  if ([inputTokens, outputTokens, priceInPerM, priceOutPerM].some((value) => value < 0 || !Number.isFinite(value))) {
    throw new Error('Token counts and prices must be finite non-negative numbers');
  }
  return inputTokens * priceInPerM / 1_000_000 + outputTokens * priceOutPerM / 1_000_000;
}

export class SpendLedger {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, readonly capUsd?: number) {
    if (capUsd !== undefined && (!Number.isFinite(capUsd) || capUsd <= 0)) {
      throw new Error('Budget cap must be finite and positive');
    }
  }

  async entries(): Promise<LedgerEntry[]> {
    try {
      const content = await readFile(this.path, 'utf8');
      return content.split('\n').filter(Boolean).map((line, index) => {
        let value: unknown;
        try { value = JSON.parse(line); } catch {
          throw new Error(`Spend ledger has invalid JSON at line ${index + 1}`);
        }
        validateLedgerEntry(value, `Spend ledger line ${index + 1}`);
        return value;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async spent(filter: { runId?: string; taskId?: string } = {}): Promise<number> {
    const entries = await this.entries();
    return entries.filter((entry) =>
      (filter.runId === undefined || entry.runId === filter.runId)
      && (filter.taskId === undefined || entry.taskId === filter.taskId))
      .reduce((sum, entry) => sum + entry.costUsd, 0);
  }

  async assertCanSpend(estimatedUsd: number): Promise<void> {
    if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) throw new Error('Estimated spend must be finite and non-negative');
    if (this.capUsd === undefined) return;
    const spentUsd = await this.spent();
    if (spentUsd + estimatedUsd > this.capUsd) throw new BudgetExceededError(spentUsd, estimatedUsd, this.capUsd);
  }

  append(entry: LedgerEntry, runCapUsd?: number): Promise<void> {
    const operation = this.queue.then(async () => {
      validateLedgerEntry(entry, 'Ledger entry');
      const spentUsd = await this.spent();
      if (runCapUsd !== undefined && (!Number.isFinite(runCapUsd) || runCapUsd <= 0)) {
        throw new Error('Run budget cap must be finite and positive');
      }
      const runSpentUsd = runCapUsd === undefined ? 0 : await this.spent({ runId: entry.runId });
      const globalExceeded = this.capUsd !== undefined && spentUsd + entry.costUsd > this.capUsd;
      const runExceeded = runCapUsd !== undefined && runSpentUsd + entry.costUsd > runCapUsd;
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(entry)}\n`);
      if (globalExceeded) throw new BudgetExceededError(spentUsd, entry.costUsd, this.capUsd!);
      if (runExceeded) throw new BudgetExceededError(runSpentUsd, entry.costUsd, runCapUsd!);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

function validateLedgerEntry(value: unknown, label: string): asserts value is LedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const entry = value as Record<string, unknown>;
  for (const field of ['runId', 'taskId', 'role', 'tier', 'model'] as const) {
    if (typeof entry[field] !== 'string' || !(entry[field] as string).trim()) throw new Error(`${label}.${field} is invalid`);
  }
  if (typeof entry.ts !== 'string' || !Number.isFinite(Date.parse(entry.ts))) throw new Error(`${label}.ts is invalid`);
  for (const field of ['inputTokens', 'outputTokens'] as const) {
    if (!Number.isInteger(entry[field]) || (entry[field] as number) < 0) throw new Error(`${label}.${field} is invalid`);
  }
  if (typeof entry.costUsd !== 'number' || !Number.isFinite(entry.costUsd) || entry.costUsd < 0) {
    throw new Error(`${label}.costUsd is invalid`);
  }
}
