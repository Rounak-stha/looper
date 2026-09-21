import type { ReasoningModel, ReasoningRequest, ReasoningResult } from '../../models/types.js';
import { OpenAICompatibleReasoningModel } from '../openai-compatible/reasoning-model.js';

export interface OpenAIReasoningOptions {
  apiKey: string;
  model: string;
  endpoint?: string;
  organization?: string;
  project?: string;
  timeoutMs?: number;
  defaultMaxOutputTokens?: number;
  jsonMode?: boolean;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
  includeTemperature?: boolean;
}

/** First-party OpenAI chat-completions adapter with bearer authentication. */
export class OpenAIReasoningModel implements ReasoningModel {
  private readonly delegate: OpenAICompatibleReasoningModel;

  constructor(options: OpenAIReasoningOptions) {
    const apiKey = text(options.apiKey, 'apiKey');
    const headers: Record<string, string> = {};
    if (options.organization !== undefined) headers['OpenAI-Organization'] = text(options.organization, 'organization');
    if (options.project !== undefined) headers['OpenAI-Project'] = text(options.project, 'project');
    this.delegate = new OpenAICompatibleReasoningModel({
      endpoint: options.endpoint ?? 'https://api.openai.com/v1/chat/completions',
      model: text(options.model, 'model'), apiKey, headers,
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

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
