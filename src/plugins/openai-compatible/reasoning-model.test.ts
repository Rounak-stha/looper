import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { OpenAICompatibleReasoningModel } from './reasoning-model.js';

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    close: () => new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())),
  };
}

test('OpenAI-compatible adapter translates requests and usage', async () => {
  let request: Record<string, unknown> | undefined;
  let authorization = '';
  const fixture = await server((incoming, response) => {
    authorization = String(incoming.headers.authorization ?? '');
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        model: 'served-model', choices: [{ message: { content: '{"thought":"ok"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }));
    });
  });
  try {
    const model = new OpenAICompatibleReasoningModel({ endpoint: fixture.url, model: 'requested-model', apiKey: 'secret' });
    const result = await model.complete({ role: 'coder', messages: [{ role: 'user', content: 'fix it' }], temperature: 0 });
    assert.equal(authorization, 'Bearer secret');
    assert.equal(request?.model, 'requested-model');
    assert.deepEqual(request?.response_format, { type: 'json_object' });
    assert.equal(result.model, 'served-model');
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 });
  } finally { await fixture.close(); }
});

test('OpenAI-compatible adapter retries transient status responses', async () => {
  let calls = 0;
  const fixture = await server((_incoming, response) => {
    calls++;
    if (calls === 1) {
      response.statusCode = 429;
      response.setHeader('retry-after', '0');
      response.end('slow down');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      model: 'm', choices: [{ message: { content: '{"thought":"ok"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  try {
    const model = new OpenAICompatibleReasoningModel({ endpoint: fixture.url, model: 'm', maxRetries: 1, retryBaseDelayMs: 0 });
    assert.equal((await model.complete({ role: 'coder', messages: [{ role: 'user', content: 'x' }] })).model, 'm');
    assert.equal(calls, 2);
  } finally { await fixture.close(); }
});

test('OpenAI-compatible adapter retries transient transport failures', async () => {
  const model = new OpenAICompatibleReasoningModel({
    endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', maxRetries: 1, retryBaseDelayMs: 0,
  });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
    return new Response(JSON.stringify({
      model: 'm', choices: [{ message: { content: '{"thought":"ok"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal((await model.complete({ role: 'coder', messages: [{ role: 'user', content: 'x' }] })).model, 'm');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI-compatible adapter bounds provider errors and times out', async () => {
  const failed = await server((_incoming, response) => { response.statusCode = 500; response.end('x'.repeat(600)); });
  try {
    const model = new OpenAICompatibleReasoningModel({ endpoint: failed.url, model: 'm', maxRetries: 0 });
    await assert.rejects(model.complete({ role: 'coder', messages: [{ role: 'user', content: 'x' }] }), /request failed \(500\).+…/);
  } finally { await failed.close(); }

  const slow = await server(() => {});
  try {
    const model = new OpenAICompatibleReasoningModel({ endpoint: slow.url, model: 'm', timeoutMs: 20 });
    await assert.rejects(model.complete({ role: 'coder', messages: [{ role: 'user', content: 'x' }] }), /timed out/);
  } finally { await slow.close(); }
});
