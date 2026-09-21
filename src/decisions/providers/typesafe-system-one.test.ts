import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TypeSafeSystemOneProvider } from './typesafe-system-one.js';
import { DecisionValidationError } from '../validate.js';

const answer = {
  model: 'jev-1.13.0',
  answers: { relevant: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 1 },
};

test('returns typed results and caches identical requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decision-model-test-'));
  let calls = 0;
  const fetch = async () => {
    calls++;
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new TypeSafeSystemOneProvider({ model: 'jev-1.13.0', apiKey: 'test', cacheDir: directory, fetch });
  const questions = { relevant: { type: 'noul' as const, instructions: 'Is it relevant?' } };
  const first = await client.ask('state', questions);
  const second = await client.ask('state', questions);
  assert.equal(first.nouls.relevant, 0.9);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});

test('cache bypass makes repeated live requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decision-model-test-'));
  let calls = 0;
  const fetch = async () => {
    calls++;
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  const client = new TypeSafeSystemOneProvider({ model: 'jev-1.13.0', apiKey: 'test', cacheDir: directory, fetch });
  const questions = { relevant: { type: 'noul' as const, instructions: 'Relevant?' } };
  await client.ask('state', questions, { cache: 'bypass' });
  await client.ask('state', questions, { cache: 'bypass' });
  assert.equal(calls, 2);
});

test('retries 429 and then succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decision-model-test-'));
  let calls = 0;
  const fetch = async () => {
    calls++;
    return calls === 1 ? new Response('limited', { status: 429 }) : new Response(JSON.stringify(answer), { status: 200 });
  };
  const client = new TypeSafeSystemOneProvider({ model: 'jev-1.13.0', apiKey: 'test', cacheDir: directory, fetch, baseRetryMs: 1 });
  await client.ask('state', { relevant: { type: 'noul', instructions: 'Relevant?' } });
  assert.equal(calls, 2);
});

test('uses exponential fallback when retry-after is absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decision-model-test-'));
  let calls = 0;
  const fetch = async () => {
    calls++;
    return calls === 1 ? new Response('unavailable', { status: 529 }) : new Response(JSON.stringify(answer), { status: 200 });
  };
  const client = new TypeSafeSystemOneProvider({ model: 'jev-1.13.0', apiKey: 'test', cacheDir: directory, fetch, baseRetryMs: 1 });
  const started = performance.now();
  await client.ask('state', { relevant: { type: 'noul', instructions: 'Relevant?' } });
  assert.equal(calls, 2);
  assert.ok(performance.now() - started >= 0.5);
});

test('fails on resolved model drift before caching', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decision-model-test-'));
  const fetch = async () => new Response(JSON.stringify({ ...answer, model: 'jev-preview' }), { status: 200 });
  const client = new TypeSafeSystemOneProvider({ model: 'jev-1.13.0', apiKey: 'test', cacheDir: directory, fetch });
  await assert.rejects(
    client.ask('state', { relevant: { type: 'noul', instructions: 'Relevant?' } }),
    (error: unknown) => error instanceof DecisionValidationError && error.code === 'MODEL_DRIFT',
  );
});

test('writes complete JSONL call logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decision-model-test-'));
  const logPath = join(directory, 'events.jsonl');
  const fetch = async () => new Response(JSON.stringify(answer), { status: 200 });
  const client = new TypeSafeSystemOneProvider({ model: 'jev-1.13.0', apiKey: 'test', cacheDir: join(directory, 'cache'), logPath, fetch });
  await client.ask('state', { relevant: { type: 'noul', instructions: 'Relevant?' } }, { purpose: 'select' });
  const event = JSON.parse((await readFile(logPath, 'utf8')).trim()) as { type: string; payload: { purpose: string } };
  assert.equal(event.type, 'decision_call');
  assert.equal(event.payload.purpose, 'select');
});
