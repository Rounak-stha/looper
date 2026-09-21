import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BudgetExceededError, callCost, SpendLedger } from './ledger.js';

test('computes token cost', () => {
  assert.equal(callCost(1_000_000, 500_000, 2, 4), 4);
});

test('ledger serializes concurrent appends and enforces cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-'));
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'), 1);
  const entry = { ts: new Date().toISOString(), runId: 'r', taskId: 't', role: 'coder', tier: 'cheap', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.4 };
  await Promise.all([ledger.append(entry), ledger.append(entry)]);
  assert.equal(await ledger.spent(), 0.8);
  assert.equal(await ledger.spent({ runId: 'r' }), 0.8);
  await assert.rejects(ledger.append(entry), BudgetExceededError);
  assert.ok(Math.abs(await ledger.spent() - 1.2) < 1e-12);
});

test('ledger rejects malformed estimates, entries, caps, and persisted rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-invalid-'));
  assert.throws(() => new SpendLedger(join(root, 'ledger.jsonl'), Infinity), /finite and positive/);
  const path = join(root, 'ledger.jsonl');
  const ledger = new SpendLedger(path, 1);
  await assert.rejects(ledger.assertCanSpend(Number.NaN), /finite and non-negative/);
  const entry = { ts: new Date().toISOString(), runId: 'r', taskId: 't', role: 'coder', tier: 'cheap', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: -1 };
  await assert.rejects(ledger.append(entry), /costUsd/);
  await writeFile(path, '{"costUsd":-1}\n');
  await assert.rejects(ledger.spent(), /runId/);
});

test('ledger records usage without enforcing an optional cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-unlimited-'));
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'));
  const entry = { ts: new Date().toISOString(), runId: 'r', taskId: 't', role: 'coder', tier: 'strong', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 4 };
  await ledger.assertCanSpend(100);
  await ledger.append(entry);
  assert.equal(await ledger.spent(), 4);
});

test('ledger enforces a per-run cap independently of the global cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-run-'));
  const ledger = new SpendLedger(join(root, 'ledger.jsonl'), 10);
  const entry = { ts: new Date().toISOString(), runId: 'r', taskId: 't', role: 'coder', tier: 'cheap', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.4 };
  await ledger.append(entry, 0.5);
  await assert.rejects(ledger.append(entry, 0.5), BudgetExceededError);
  await ledger.append({ ...entry, runId: 'other' }, 0.5);
  assert.ok(Math.abs(await ledger.spent() - 1.2) < 1e-12);
  assert.equal(await ledger.spent({ runId: 'r' }), 0.8);
});
