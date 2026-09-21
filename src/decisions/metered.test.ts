import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RunEvent } from '../core/events.js';
import { BudgetExceededError, SpendLedger } from '../core/ledger.js';
import { RunLogger } from '../core/logger.js';
import { MeteredDecisionModel } from './metered.js';
import type { DecisionModel } from './types.js';

const provider = (cacheHit = false): DecisionModel => ({ async ask() { return {
  model: 'decision-v1', nouls: { relevant: 0.9 }, choices: {}, scores: {},
  usage: { input_tokens: 1_000, output_tokens: 500 }, raw: { model: 'decision-v1', answers: {}, usage: { input_tokens: 1_000, output_tokens: 500 } },
  latencyMs: 2, cacheHit,
}; } });

test('meters decision calls into the shared ledger and run event stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metered-decision-'));
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'), 10);
  const events: RunEvent[] = [];
  const logger = new RunLogger({ async write(event) { events.push(event); } }, { run_id: 'r', task_id: 't', config_id: 'c' });
  const model = new MeteredDecisionModel(provider(), { tier: 'decision', priceInPerM: 2, priceOutPerM: 4 }, ledger, logger, {
    runId: 'r', taskId: 't', runCapUsd: 1, currentStep: () => 3, estimatedMaxCostUsd: () => 0.1,
  });
  await model.ask('state', { q: { type: 'noul', instructions: 'yes?' } }, { purpose: 'route' });
  assert.equal(await ledger.spent({ runId: 'r' }), 0.004);
  assert.equal(events[0]!.type, 'decision_call');
  assert.equal(events[0]!.step, 3);
});

test('cached decisions are logged but not charged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metered-decision-cache-'));
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'), 10);
  const model = new MeteredDecisionModel(provider(true), { tier: 'decision', priceInPerM: 2, priceOutPerM: 4 }, ledger,
    new RunLogger({ async write() {} }, { run_id: 'r', task_id: 't', config_id: 'c' }), {
      runId: 'r', taskId: 't', currentStep: () => 0, estimatedMaxCostUsd: () => 0,
    });
  await model.ask('state', { q: { type: 'noul', instructions: 'yes?' } });
  assert.equal(await ledger.spent(), 0);
});

test('rejects malformed provider accounting before ledger append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metered-decision-invalid-'));
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'), 10);
  const malformed: DecisionModel = { async ask() { return {
    model: 'decision-v1', nouls: {}, choices: {}, scores: {},
    usage: { input_tokens: -1, output_tokens: 0 }, raw: { model: 'decision-v1', answers: {}, usage: { input_tokens: -1, output_tokens: 0 } },
    latencyMs: 1, cacheHit: false,
  }; } };
  const model = new MeteredDecisionModel(malformed, { tier: 'decision', priceInPerM: 1, priceOutPerM: 1 }, ledger,
    new RunLogger({ async write() {} }, { run_id: 'r', task_id: 't', config_id: 'c' }), {
      runId: 'r', taskId: 't', currentStep: () => 0, estimatedMaxCostUsd: () => 0.1,
    });
  await assert.rejects(model.ask('state', { q: { type: 'noul', instructions: 'yes?' } }), /invalid token usage/);
  assert.equal(await ledger.spent(), 0);
});

test('records and logs actual spend that exceeds the post-call cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metered-decision-overrun-'));
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'), 0.003);
  const events: RunEvent[] = [];
  const model = new MeteredDecisionModel(provider(), { tier: 'decision', priceInPerM: 2, priceOutPerM: 4 }, ledger,
    new RunLogger({ async write(event) { events.push(event); } }, { run_id: 'r', task_id: 't', config_id: 'c' }), {
      runId: 'r', taskId: 't', currentStep: () => 0, estimatedMaxCostUsd: () => 0.001,
    });
  await assert.rejects(model.ask('state', { q: { type: 'noul', instructions: 'yes?' } }), BudgetExceededError);
  assert.equal(await ledger.spent(), 0.004);
  assert.equal(events[0]?.payload.budget_exceeded, true);
});

test('decision preflight enforces the per-run cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metered-decision-cap-'));
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'), 10);
  const model = new MeteredDecisionModel(provider(), { tier: 'decision', priceInPerM: 0, priceOutPerM: 0 }, ledger,
    new RunLogger({ async write() {} }, { run_id: 'r', task_id: 't', config_id: 'c' }), {
      runId: 'r', taskId: 't', runCapUsd: 0.05, currentStep: () => 0, estimatedMaxCostUsd: () => 0.1,
    });
  await assert.rejects(model.ask('state', { q: { type: 'noul', instructions: 'yes?' } }), BudgetExceededError);
});
