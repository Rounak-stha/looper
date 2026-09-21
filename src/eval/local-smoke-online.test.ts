import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RunEvent } from '../core/events.js';
import { SpendLedger } from '../core/ledger.js';
import type { EventSink } from '../core/logger.js';
import plugin from '../plugins/local-smoke/index.js';
import { runAgentTask } from './agent-runner.js';
import { parseTaskDataset } from './tasks.js';

const baseTask = parseTaskDataset(await readFile('examples/local-smoke-task.jsonl', 'utf8'))[0]!;

test('local plugin runs an OpenAI-compatible reasoner end to end', async () => {
  assert.ok(plugin.tools && plugin.evaluator && plugin.agent && plugin.selectors);
  let calls = 0;
  const server = createServer((_request, response) => {
    calls++;
    const malformed = calls === 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      model: 'mock-coder',
      choices: [{ finish_reason: 'stop', message: { content: malformed ? 'not json' : JSON.stringify({
        thought: 'correct addition',
        tool: { name: 'write_file', path: 'math.js', content: 'export function add(a, b) { return a + b; }\n' },
      }) } }],
      usage: malformed ? { prompt_tokens: 2, completion_tokens: 1 } : { prompt_tokens: 10, completion_tokens: 8 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock server address');
  const root = await mkdtemp(join(tmpdir(), 'local-smoke-online-'));
  const task = {
    ...baseTask,
    source: { ...baseTask.source, data: { ...baseTask.source.data, snapshotDirectory: join(root, 'snapshots') } },
  };
  const events: RunEvent[] = [];
  const sink: EventSink = { async write(event) { events.push(event); } };
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'), 1);
  const providerConfig = {
    reasoningProvider: {
      endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, model: 'mock-coder', tier: 'mock',
      timeoutMs: 1_000, maxOutputTokens: 100, jsonMode: true,
      priceInPerM: 0, priceOutPerM: 0, estimatedMaxCostUsd: 0,
    },
  };
  try {
    const result = await runAgentTask(task, {
      workspaces: plugin.workspaces, context: plugin.context, tools: plugin.tools, evaluator: plugin.evaluator,
      events: sink,
      selectorFor(publicTask) { return plugin.selectors!.create('heuristic', { task: publicTask })!; },
      controllerFor(publicTask, context) {
        return plugin.agent!.create({ task: publicTask, ...context, ledger, runCapUsd: 1, config: providerConfig });
      },
    }, {
      runId: 'online-smoke', configId: 'online-smoke', candidateLimit: 10,
      selectionBudget: { maxItems: 2, maxTokens: 1_000 }, dynamicContextMaxTokens: 1_000,
      sessionBudgets: { maxSteps: 6, maxReasoningTokens: 1_000, wallClockMs: 10_000 },
      manifest: { datasetVersion: 'smoke', configHash: 'fixture', modelIds: ['mock-coder'], decisionModelIds: [] },
    });
    assert.equal(result.outcome, 'passed');
    assert.equal(result.visibleOutcome, 'passed');
    assert.equal(result.reasoningTokens, 21);
    assert.equal(events.filter(({ type }) => type === 'llm_call').length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
