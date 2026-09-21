import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SpendLedger } from '../core/ledger.js';
import { MeteredReasoningModel } from '../models/metered.js';
import type { ReasoningModel } from '../models/types.js';
import { JsonCodingDecisionCodec } from './json-codec.js';
import { ConsumedReasoningError, MeteredCodingReasoner } from './reasoning-adapter.js';

const turn = {
  task: 'fix auth', selectedContext: [], additionalContext: [], unselectedManifest: ['auth.ts'], observations: [],
  tests: { lastRun: 'never' as const, dirtySinceLastRun: false },
};

test('metered coding adapter validates JSON and propagates usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reasoner-'));
  const provider: ReasoningModel = { async complete(request) {
    assert.equal(request.role, 'coder');
    return {
      content: '{"tool":{"name":"read_file","path":"auth.ts"}}', model: 'fixture', finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1,
    };
  } };
  const metered = new MeteredReasoningModel(
    { id: 'cheap', model: provider, priceInPerM: 1, priceOutPerM: 2 },
    new SpendLedger(join(root, 'ledger.jsonl'), 1),
  );
  const reasoner = new MeteredCodingReasoner(metered, new JsonCodingDecisionCodec(), {
    current: () => ({ runId: 'run', taskId: 'task', step: 1 }),
    estimatedMaxCostUsd: () => 0.01,
  });
  const result = await reasoner.decide(turn);
  assert.deepEqual(result.tool, { name: 'read_file', path: 'auth.ts' });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
});

test('metered coding adapter repairs malformed decisions and aggregates usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reasoner-repair-'));
  let calls = 0;
  const model = new MeteredReasoningModel({
    id: 'cheap', priceInPerM: 0, priceOutPerM: 0,
    model: { async complete(request) {
      calls++;
      if (calls === 2) assert.match(request.messages.at(-1)!.content, /was rejected/);
      return {
        content: calls === 1 ? 'bad' : '{"tool":{"name":"run_tests"}}', model: 'fixture', finishReason: 'stop',
        usage: { inputTokens: calls, outputTokens: 1 }, latencyMs: 1,
      };
    } },
  }, new SpendLedger(join(root, 'ledger.jsonl'), 1));
  const reasoner = new MeteredCodingReasoner(model, new JsonCodingDecisionCodec(), {
    current: () => ({ runId: 'run', taskId: 'task', step: 1 }), estimatedMaxCostUsd: () => 0,
  }, 'coder', 1);
  const result = await reasoner.decide(turn);
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2 });
  assert.equal(result.tool?.name, 'run_tests');
});

test('decode repair omits the original large user context', () => {
  const codec = new JsonCodingDecisionCodec();
  const original = codec.request({ ...turn, task: 'x'.repeat(20_000) });
  const repaired = codec.repair!(original, {
    content: '{"tool":{"read_file":{"path":"auth.ts"}}}', model: 'fixture', finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
  }, new Error('Unknown or invalid tool call'));
  assert.equal(repaired.messages.length, 3);
  assert.ok(!repaired.messages.some(({ content }) => content.includes('x'.repeat(100))));
  assert.match(repaired.messages.at(-1)!.content, /Unknown or invalid tool call/);
});

test('metered coding adapter exposes consumed usage after decode failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reasoner-failure-'));
  const model = new MeteredReasoningModel({
    id: 'cheap', priceInPerM: 0, priceOutPerM: 0,
    model: { async complete() { return {
      content: 'bad', model: 'fixture', finishReason: 'stop',
      usage: { inputTokens: 4, outputTokens: 2 }, latencyMs: 1,
    }; } },
  }, new SpendLedger(join(root, 'ledger.jsonl'), 1));
  const reasoner = new MeteredCodingReasoner(model, new JsonCodingDecisionCodec(), {
    current: () => ({ runId: 'run', taskId: 'task', step: 1 }), estimatedMaxCostUsd: () => 0,
  });
  await assert.rejects(reasoner.decide(turn), (error) => {
    assert.ok(error instanceof ConsumedReasoningError);
    assert.equal(error.incurredReasoningTokens, 6);
    return true;
  });
});

test('metered model rejects malformed provider accounting before ledger append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reasoner-invalid-'));
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'), 1);
  const model = new MeteredReasoningModel({
    id: 'cheap', priceInPerM: 1, priceOutPerM: 1,
    model: { async complete() { return {
      content: '{}', model: 'fixture', finishReason: 'stop',
      usage: { inputTokens: -1, outputTokens: 0 }, latencyMs: 1,
    }; } },
  }, ledger);
  await assert.rejects(model.complete({ role: 'coder', messages: [] }, {
    runId: 'r', taskId: 't', step: 0,
  }, 0.01), /invalid token usage/);
  assert.equal(await ledger.spent(), 0);
});

test('JSON codec accepts bounded read ranges and rejects inverted ranges', () => {
  const codec = new JsonCodingDecisionCodec();
  const base = { model: 'fixture', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
  assert.deepEqual(codec.decode({ ...base, content: '{"tool":{"name":"read_file","path":"auth.ts","startLine":10,"endLine":20}}' }).tool,
    { name: 'read_file', path: 'auth.ts', startLine: 10, endLine: 20 });
  assert.throws(() => codec.decode({ ...base, content: '{"tool":{"name":"read_file","path":"auth.ts","startLine":20,"endLine":10}}' }), /greater than or equal/);
});

test('JSON codec accepts exact text replacement', () => {
  const codec = new JsonCodingDecisionCodec();
  const result = codec.decode({
    content: '{"tool":{"name":"replace_text","path":"auth.ts","oldText":"before","newText":"after"}}',
    model: 'fixture', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
  });
  assert.deepEqual(result.tool, { name: 'replace_text', path: 'auth.ts', oldText: 'before', newText: 'after' });
});

test('JSON codec rejects arbitrary tool names', () => {
  assert.throws(() => new JsonCodingDecisionCodec().decode({
    content: '{"tool":{"name":"delete_everything"}}', model: 'fixture', finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
  }), /Unknown or invalid tool call/);
});
