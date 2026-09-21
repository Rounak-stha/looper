import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunEvent, RunEventType } from './events.js';

export interface EventSink {
  write<T extends Record<string, unknown>>(event: RunEvent<T>): Promise<void>;
}

export class JsonlEventSink implements EventSink {
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly reservedRunIds = new Set<string>();
  constructor(private readonly path: string) {}

  write<T extends Record<string, unknown>>(event: RunEvent<T>): Promise<void> {
    const operation = this.queue.then(async () => {
      await this.initialize();
      if (event.type === 'run_start' && this.reservedRunIds.has(event.run_id)) {
        throw new Error(`Run '${event.run_id}' already exists in event log`);
      }
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(event)}\n`);
      if (event.type === 'run_start') this.reservedRunIds.add(event.run_id);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const content = await readFile(this.path, 'utf8');
      for (const [index, line] of content.split('\n').entries()) {
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch {
          throw new Error(`Existing event log has invalid JSON at line ${index + 1}`);
        }
        if (!value || typeof value !== 'object' || typeof (value as Partial<RunEvent>).run_id !== 'string') {
          throw new Error(`Existing event log has invalid event at line ${index + 1}`);
        }
        this.reservedRunIds.add((value as RunEvent).run_id);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }
}

export class RunLogger {
  constructor(
    private readonly sink: EventSink,
    private readonly envelope: Pick<RunEvent, 'run_id' | 'task_id' | 'config_id'>,
  ) {}

  emit<T extends Record<string, unknown>>(type: RunEventType, step: number, payload: T): Promise<void> {
    return this.sink.write({ ...this.envelope, step, ts: new Date().toISOString(), type, payload });
  }
}
