import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DecisionRequest, DecisionResponse } from './types.js';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function cacheKey(request: DecisionRequest): string {
  // The configured model is pinned and is therefore the expected resolved model id.
  const canonical = JSON.stringify(stable(request));
  return createHash('sha256').update(canonical).digest('hex');
}

export class DecisionCache {
  constructor(private readonly directory: string) {}

  async get(key: string): Promise<DecisionResponse | undefined> {
    try {
      return JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8')) as DecisionResponse;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async set(key: string, response: DecisionResponse): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${key}.json`);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(response)}\n`, { flag: 'wx' });
    await rename(temporary, target);
  }
}
