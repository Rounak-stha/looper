import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonlEventSink } from './logger.js';
import type { RunEvent } from './events.js';

function event(runId: string, type: RunEvent['type']): RunEvent {
  return { run_id: runId, task_id: 't', config_id: 'c', step: 0, ts: '2026-01-01T00:00:00Z', type, payload: {} };
}

test('JSONL sink reserves run IDs and rejects duplicate starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'event-sink-'));
  const path = join(root, 'events.jsonl');
  const sink = new JsonlEventSink(path);
  await sink.write(event('a', 'run_start'));
  await sink.write(event('a', 'run_end'));
  await sink.write(event('b', 'run_start'));
  await assert.rejects(sink.write(event('a', 'run_start')), /already exists/);
  assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 3);
});

test('JSONL sink detects an existing run after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'event-sink-restart-'));
  const path = join(root, 'events.jsonl');
  await new JsonlEventSink(path).write(event('a', 'run_start'));
  await assert.rejects(new JsonlEventSink(path).write(event('a', 'run_start')), /already exists/);
});
