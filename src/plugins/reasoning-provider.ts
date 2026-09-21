import type { ReasoningModel } from '../models/types.js';
import { AzureOpenAIReasoningModel } from './azure-openai/reasoning-model.js';
import { OpenAICompatibleReasoningModel } from './openai-compatible/reasoning-model.js';
import { OpenAIReasoningModel } from './openai/reasoning-model.js';

export interface ConfiguredReasoningProvider {
  model: ReasoningModel;
  modelId: string;
  tier: string;
  priceInPerM: number;
  priceOutPerM: number;
  estimatedMaxCostUsd: number;
  maxDecodeRetries: number;
  maxOutputTokens: number;
}

/** Constructs an optional provider adapter from plugin-owned experiment configuration. */
export function reasoningProviderFromConfig(value: unknown): ConfiguredReasoningProvider {
  const record = object(value, 'reasoningProvider');
  if (record.apiKey !== undefined) throw new Error('reasoningProvider.apiKey is forbidden; use apiKeyEnv');
  const provider = optionalText(record.provider) ?? 'openai-compatible';
  const modelName = requiredText(record.model ?? record.deployment, 'reasoningProvider.model');
  const apiKeyEnv = optionalText(record.apiKeyEnv) ?? (provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'azure' ? 'AZURE_OPENAI_API_KEY' : undefined);
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !apiKey) throw new Error(`Set ${apiKeyEnv} for the configured reasoning provider`);
  const tokenParameter = record.tokenParameter === undefined ? undefined : tokenParameterValue(record.tokenParameter);
  const includeTemperature = optionalBoolean(record.includeTemperature, true, 'reasoningProvider.includeTemperature');
  const common = {
    timeoutMs: positiveInteger(record.timeoutMs ?? 120_000, 'reasoningProvider.timeoutMs'),
    defaultMaxOutputTokens: positiveInteger(record.maxOutputTokens ?? 2_000, 'reasoningProvider.maxOutputTokens'),
    jsonMode: optionalBoolean(record.jsonMode, true, 'reasoningProvider.jsonMode'),
    maxRetries: boundedInteger(record.maxRetries ?? 2, 0, 5, 'reasoningProvider.maxRetries'),
    retryBaseDelayMs: boundedInteger(record.retryBaseDelayMs ?? 250, 0, 60_000, 'reasoningProvider.retryBaseDelayMs'),
  };
  let model: ReasoningModel;
  if (provider === 'openai') {
    model = new OpenAIReasoningModel({
      apiKey: requiredText(apiKey, 'reasoningProvider API key'), model: modelName,
      ...(optionalText(record.endpoint) ? { endpoint: optionalText(record.endpoint)! } : {}),
      ...(optionalText(record.organization) ? { organization: optionalText(record.organization)! } : {}),
      ...(optionalText(record.project) ? { project: optionalText(record.project)! } : {}),
      ...(tokenParameter ? { tokenParameter } : {}), includeTemperature, ...common,
    });
  } else if (provider === 'azure') {
    const deployment = optionalText(record.deployment);
    const apiVersion = optionalText(record.apiVersion);
    model = new AzureOpenAIReasoningModel({
      apiKey: requiredText(apiKey, 'reasoningProvider API key'),
      endpoint: requiredText(record.endpoint, 'reasoningProvider.endpoint'), model: modelName,
      ...(deployment ? { deployment } : {}), ...(apiVersion ? { apiVersion } : {}),
      ...(tokenParameter ? { tokenParameter } : {}), includeTemperature, ...common,
    });
  } else if (provider === 'openai-compatible') {
    model = new OpenAICompatibleReasoningModel({
      endpoint: requiredText(record.endpoint, 'reasoningProvider.endpoint'), model: modelName,
      ...(apiKey ? { apiKey } : {}), headers: stringHeaders(record.headers),
      ...(tokenParameter ? { tokenParameter } : {}), includeTemperature, ...common,
    });
  } else throw new Error(`Unknown reasoning provider '${provider}'`);
  return {
    model, modelId: modelName, tier: requiredText(record.tier ?? modelName, 'reasoningProvider.tier'),
    priceInPerM: nonnegative(record.priceInPerM ?? 0, 'reasoningProvider.priceInPerM'),
    priceOutPerM: nonnegative(record.priceOutPerM ?? 0, 'reasoningProvider.priceOutPerM'),
    estimatedMaxCostUsd: nonnegative(record.estimatedMaxCostUsd ?? 0, 'reasoningProvider.estimatedMaxCostUsd'),
    maxDecodeRetries: boundedInteger(record.maxDecodeRetries ?? 1, 0, 3, 'reasoningProvider.maxDecodeRetries'),
    maxOutputTokens: common.defaultMaxOutputTokens,
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value;
}
function optionalText(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`); return value as number;
}
function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`); return value as number;
}
function nonnegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`); return value;
}
function optionalBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`); return value;
}
function tokenParameterValue(value: unknown): 'max_tokens' | 'max_completion_tokens' {
  if (value !== 'max_tokens' && value !== 'max_completion_tokens') throw new Error('reasoningProvider.tokenParameter is invalid');
  return value;
}
function stringHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, item]) => !key.trim() || typeof item !== 'string')) {
    throw new Error('reasoningProvider.headers must map non-empty names to strings');
  }
  return value as Record<string, string>;
}
