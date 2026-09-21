import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentExperimentConfig } from './agent-config.js';

const valid = {
  configId: 'arm', datasetVersion: 'v1', selector: 'bm25', candidateLimit: 60,
  selectionBudget: { maxItems: 10, maxTokens: 30_000 },
  sessionBudgets: { maxSteps: 30, maxReasoningTokens: 400_000, wallClockMs: 900_000 },
  runsPerTask: 2, seed: 1, estimatedCostPerRunUsd: 0.1,
  budget: { capUsd: 10, reservePct: 40, runCapUsd: 1, ledgerPath: 'runs/ledger.jsonl' },
  modelIds: ['model'], decisionModelIds: [], eventsPath: 'runs/events.jsonl',
};

test('parses a complete agent experiment config', () => {
  assert.equal(parseAgentExperimentConfig(valid).sessionBudgets.maxSteps, 30);
});

test('parses explicit candidate pool and kind filtering', () => {
  const parsed = parseAgentExperimentConfig({ ...valid, poolCandidates: 1000, candidateKinds: ['file'] });
  assert.equal(parsed.poolCandidates, 1000);
  assert.deepEqual(parsed.candidateKinds, ['file']);
  assert.throws(() => parseAgentExperimentConfig({ ...valid, candidateKinds: ['unknown'] }), /unknown kind/);
});

test('parses a separate initial context loading ceiling', () => {
  const parsed = parseAgentExperimentConfig({ ...valid, initialContextMaxTokens: 2_000 });
  assert.equal(parsed.initialContextMaxTokens, 2_000);
  assert.equal(parseAgentExperimentConfig(valid).initialContextMaxTokens, 30_000);
});

test('accepts an experiment without optional dollar-budget policy', () => {
  const { budget: _budget, estimatedCostPerRunUsd: _estimate, ...unbudgeted } = valid;
  const parsed = parseAgentExperimentConfig(unbudgeted);
  assert.equal(parsed.budget, undefined);
  assert.equal(parsed.estimatedCostPerRunUsd, undefined);
});

test('rejects unsafe or incomplete agent experiment config', () => {
  assert.throws(() => parseAgentExperimentConfig({ ...valid, budget: { ...valid.budget, capUsd: 0 } }), /positive/);
  assert.throws(() => parseAgentExperimentConfig({ ...valid, sessionBudgets: {} }), /maxSteps/);
});
