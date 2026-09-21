import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { AzureOpenAIReasoningModel } from './azure-openai/reasoning-model.js';
import { OpenAIReasoningModel } from './openai/reasoning-model.js';
import { reasoningProviderFromConfig } from './reasoning-provider.js';

async function fixture(): Promise<{
  base: string; requests: Array<{ url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
  const instance = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      requests.push({ url: incoming.url ?? '', headers: incoming.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ model: 'served', choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return { base: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())) };
}

const request = { role: 'coder', messages: [{ role: 'user' as const, content: 'fix' }], maxOutputTokens: 12 };

test('OpenAI adapter uses bearer authentication and first-party headers', async () => {
  const server = await fixture();
  try {
    const model = new OpenAIReasoningModel({ apiKey: 'openai-secret', model: 'gpt-test', endpoint: `${server.base}/v1/chat/completions`, organization: 'org', project: 'proj' });
    await model.complete(request);
    assert.equal(server.requests[0]?.headers.authorization, 'Bearer openai-secret');
    assert.equal(server.requests[0]?.headers['openai-organization'], 'org');
    assert.equal(server.requests[0]?.headers['openai-project'], 'proj');
    assert.equal(server.requests[0]?.body.model, 'gpt-test');
  } finally { await server.close(); }
});

test('Azure v1 adapter appends chat/completions and sends model with api-key authentication', async () => {
  const server = await fixture();
  try {
    const model = new AzureOpenAIReasoningModel({ apiKey: 'azure-secret', endpoint: `${server.base}/openai/v1`, model: 'gpt-test', tokenParameter: 'max_completion_tokens', includeTemperature: false });
    await model.complete(request);
    assert.equal(server.requests[0]?.url, '/openai/v1/chat/completions');
    assert.equal(server.requests[0]?.headers['api-key'], 'azure-secret');
    assert.equal(server.requests[0]?.headers.authorization, undefined);
    assert.equal(server.requests[0]?.body.model, 'gpt-test');
    assert.equal(server.requests[0]?.body.max_completion_tokens, 12);
    assert.equal(server.requests[0]?.body.temperature, undefined);
  } finally { await server.close(); }
});

test('Azure adapter retains explicit legacy deployment compatibility', async () => {
  const server = await fixture();
  try {
    const model = new AzureOpenAIReasoningModel({ apiKey: 'azure-secret', endpoint: server.base, model: 'model', deployment: 'my deployment', apiVersion: '2024-10-21' });
    await model.complete(request);
    assert.equal(server.requests[0]?.url, '/openai/deployments/my%20deployment/chat/completions?api-version=2024-10-21');
    assert.equal(server.requests[0]?.body.model, undefined);
  } finally { await server.close(); }
});

test('provider factory selects Azure and never accepts an inline credential', () => {
  process.env.TEST_AZURE_KEY = 'secret';
  try {
    const configured = reasoningProviderFromConfig({ provider: 'azure', endpoint: 'https://example.services.ai.azure.com/openai/v1', model: 'model', apiKeyEnv: 'TEST_AZURE_KEY', tier: 'strong', priceInPerM: 1, priceOutPerM: 2, estimatedMaxCostUsd: 3 });
    assert.equal(configured.modelId, 'model');
    assert.equal(configured.tier, 'strong');
    assert.throws(() => reasoningProviderFromConfig({ provider: 'azure', endpoint: 'https://example.openai.azure.com/openai/v1', model: 'm', apiKey: 'inline' }), /apiKey is forbidden/);
  } finally { delete process.env.TEST_AZURE_KEY; }
});
