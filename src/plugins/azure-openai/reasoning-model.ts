import type { ReasoningModel, ReasoningRequest, ReasoningResult } from '../../models/types.js';
import { OpenAICompatibleReasoningModel } from '../openai-compatible/reasoning-model.js';

export interface AzureOpenAIReasoningOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  /** Optional compatibility mode for the legacy deployment-based Azure API. */
  deployment?: string;
  apiVersion?: string;
  timeoutMs?: number;
  defaultMaxOutputTokens?: number;
  jsonMode?: boolean;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
  includeTemperature?: boolean;
}

/** Azure OpenAI adapter supporting both the current /openai/v1 API and legacy deployment API. */
export class AzureOpenAIReasoningModel implements ReasoningModel {
  private readonly delegate: OpenAICompatibleReasoningModel;

  constructor(options: AzureOpenAIReasoningOptions) {
    const legacy = options.deployment !== undefined || options.apiVersion !== undefined;
    if (legacy && (!options.deployment || !options.apiVersion)) {
      throw new Error('Legacy Azure mode requires both deployment and apiVersion');
    }
    const endpoint = legacy
      ? legacyAzureEndpoint(options.endpoint, options.deployment!, options.apiVersion!)
      : v1AzureEndpoint(options.endpoint);
    this.delegate = new OpenAICompatibleReasoningModel({
      endpoint, model: text(options.model, 'model'), includeModel: !legacy,
      headers: { 'api-key': text(options.apiKey, 'apiKey') },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.defaultMaxOutputTokens === undefined ? {} : { defaultMaxOutputTokens: options.defaultMaxOutputTokens }),
      ...(options.jsonMode === undefined ? {} : { jsonMode: options.jsonMode }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: options.retryBaseDelayMs }),
      ...(options.tokenParameter === undefined ? {} : { tokenParameter: options.tokenParameter }),
      ...(options.includeTemperature === undefined ? {} : { includeTemperature: options.includeTemperature }),
    });
  }

  complete(request: ReasoningRequest): Promise<ReasoningResult> { return this.delegate.complete(request); }
}

function v1AzureEndpoint(value: unknown): string {
  const endpoint = baseEndpoint(value);
  const path = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return endpoint.href;
}

function legacyAzureEndpoint(resourceEndpoint: unknown, deploymentValue: unknown, apiVersionValue: unknown): string {
  const endpoint = baseEndpoint(resourceEndpoint);
  if (endpoint.search) throw new Error('Legacy Azure endpoint must not contain a query');
  const deployment = text(deploymentValue, 'deployment');
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
  endpoint.searchParams.set('api-version', text(apiVersionValue, 'apiVersion'));
  return endpoint.href;
}

function baseEndpoint(value: unknown): URL {
  const endpoint = new URL(text(value, 'endpoint'));
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') throw new Error('endpoint must use http or https');
  if (endpoint.username || endpoint.password || endpoint.hash) throw new Error('Azure endpoint must not contain credentials or fragment');
  return endpoint;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
