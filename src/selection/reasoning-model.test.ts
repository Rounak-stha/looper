import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextCandidate } from '../core/types.js';
import type { ReasoningModel, ReasoningRequest, ReasoningResult } from '../models/types.js';
import { ReasoningModelSelector } from './reasoning-model.js';

const candidates: ContextCandidate[] = [
  { id: 'auth.py', path: 'auth.py', kind: 'file', summary: 'Session checks', approxTokens: 10 },
  { id: 'user.py', path: 'user.py', kind: 'file', summary: 'User model', approxTokens: 10 },
];
const result = (content: string): ReasoningResult => ({
  content, model: 'fixture', finishReason: 'stop', latencyMs: 2,
  usage: { inputTokens: 10, outputTokens: 3 },
});

test('reasoning-model selector decodes a strict listwise ranking', async () => {
  const model: ReasoningModel = { async complete() { return result('{"ranking":[{"id":"auth.py","confidence":0.9}]}'); } };
  const selected = await new ReasoningModelSelector(model, { k: 1, maxOutputTokens: 100 }).select({
    task: 'fix sessions', candidates, alreadyLoaded: [], budget: { maxItems: 1, maxTokens: 100 },
  });
  assert.deepEqual(selected.selected, ['auth.py']);
  assert.equal(selected.scores[0]!.via, 'llm');
  assert.deepEqual(selected.meta.usage, { input_tokens: 10, output_tokens: 3 });
});

test('reasoning-model selector repairs malformed JSON with compact context', async () => {
  const requests: ReasoningRequest[] = [];
  const model: ReasoningModel = { async complete(request) {
    requests.push(request);
    return result(requests.length === 1 ? '{bad' : '{"ranking":[{"id":"auth.py","confidence":0.8}]}');
  } };
  const selected = await new ReasoningModelSelector(model, { k: 1, maxOutputTokens: 100 }).select({
    task: 'fix sessions', candidates, alreadyLoaded: [], budget: { maxItems: 1, maxTokens: 100 },
  });
  assert.equal(selected.meta.repaired, true);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[1]!.messages[1]!.content, /Session checks/);
});

test('reasoning-model selector rejects unknown and duplicate IDs', async () => {
  const model: ReasoningModel = { async complete() { return result('{"ranking":[{"id":"missing.py","confidence":1}]}'); } };
  await assert.rejects(new ReasoningModelSelector(model, { k: 1, maxOutputTokens: 100, maxDecodeRetries: 0 }).select({
    task: 'fix sessions', candidates, alreadyLoaded: [], budget: { maxItems: 1, maxTokens: 100 },
  }), /unknown ID/);
});
