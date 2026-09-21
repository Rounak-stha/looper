import type { ReasoningMessage, ReasoningModel, ReasoningRequest, ReasoningResult } from '../../models/types.js';

export interface OpenAICompatibleReasoningOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  defaultMaxOutputTokens?: number;
  jsonMode?: boolean;
  headers?: Record<string, string>;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Some first-party APIs use max_completion_tokens for newer reasoning models. */
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
  /** Azure identifies the model in the URL deployment and does not require it in the body. */
  includeModel?: boolean;
  /** Omit temperature for models that only support their provider default. */
  includeTemperature?: boolean;
}

/** Optional adapter for servers implementing the OpenAI chat-completions wire format. */
export class OpenAICompatibleReasoningModel implements ReasoningModel {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly defaultMaxOutputTokens: number | undefined;
  private readonly jsonMode: boolean;
  private readonly headers: Record<string, string>;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly tokenParameter: 'max_tokens' | 'max_completion_tokens';
  private readonly includeModel: boolean;
  private readonly includeTemperature: boolean;

  constructor(options: OpenAICompatibleReasoningOptions) {
    this.endpoint = httpUrl(options.endpoint, 'endpoint');
    this.model = text(options.model, 'model');
    this.apiKey = options.apiKey;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 120_000, 'timeoutMs');
    this.defaultMaxOutputTokens = options.defaultMaxOutputTokens === undefined
      ? undefined : positiveInteger(options.defaultMaxOutputTokens, 'defaultMaxOutputTokens');
    this.jsonMode = options.jsonMode ?? true;
    if (typeof this.jsonMode !== 'boolean') throw new Error('jsonMode must be boolean');
    this.headers = validateHeaders(options.headers ?? {});
    this.maxRetries = boundedNonnegativeInteger(options.maxRetries ?? 2, 5, 'maxRetries');
    this.retryBaseDelayMs = nonnegativeInteger(options.retryBaseDelayMs ?? 250, 'retryBaseDelayMs');
    this.tokenParameter = options.tokenParameter ?? 'max_tokens';
    if (!['max_tokens', 'max_completion_tokens'].includes(this.tokenParameter)) throw new Error('tokenParameter is invalid');
    this.includeModel = options.includeModel ?? true;
    if (typeof this.includeModel !== 'boolean') throw new Error('includeModel must be boolean');
    this.includeTemperature = options.includeTemperature ?? true;
    if (typeof this.includeTemperature !== 'boolean') throw new Error('includeTemperature must be boolean');
  }

  async complete(request: ReasoningRequest): Promise<ReasoningResult> {
    validateRequest(request);
    const started = performance.now();
    const outputTokens = request.maxOutputTokens ?? this.defaultMaxOutputTokens;
    const body = JSON.stringify({
      ...(this.includeModel ? { model: this.model } : {}),
      messages: request.messages,
      ...(outputTokens ? { [this.tokenParameter]: outputTokens } : {}),
      ...(!this.includeTemperature || request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort }),
      ...(this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST', signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
            ...this.headers,
          },
          body,
        });
        const responseBody = await response.text();
        if (!response.ok) {
          if (TRANSIENT_STATUSES.has(response.status) && attempt < this.maxRetries) {
            await delay(retryDelayMs(response.headers.get('retry-after'), this.retryBaseDelayMs, attempt));
            continue;
          }
          throw new Error(`OpenAI-compatible request failed (${response.status}): ${bounded(responseBody)}`);
        }
        let value: unknown;
        try { value = JSON.parse(responseBody); }
        catch { throw new Error('OpenAI-compatible provider returned invalid JSON'); }
        return parseResponse(value, performance.now() - started);
      } catch (error) {
        if (isTransientTransportError(error) && attempt < this.maxRetries) {
          await delay(retryDelayMs(null, this.retryBaseDelayMs, attempt));
          continue;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`OpenAI-compatible request timed out after ${this.timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  if (error instanceof TypeError && error.message === 'fetch failed') return true;
  const cause = error.cause;
  if (!cause || typeof cause !== 'object') return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

function retryDelayMs(header: string | null, baseMs: number, attempt: number): number {
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return baseMs * 2 ** attempt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseResponse(value: unknown, latencyMs: number): ReasoningResult {
  const root = object(value, 'response');
  const model = text(root.model, 'response.model');
  if (!Array.isArray(root.choices) || root.choices.length < 1) throw new Error('Response requires a non-empty choices array');
  const choice = object(root.choices[0], 'response.choices[0]');
  const message = object(choice.message, 'response.choices[0].message');
  if (typeof message.content !== 'string') throw new Error('Response message content must be a string');
  const usage = object(root.usage, 'response.usage');
  return {
    content: message.content,
    model,
    finishReason: text(choice.finish_reason, 'response.choices[0].finish_reason'),
    usage: {
      inputTokens: nonnegativeInteger(usage.prompt_tokens, 'response.usage.prompt_tokens'),
      outputTokens: nonnegativeInteger(usage.completion_tokens, 'response.usage.completion_tokens'),
    },
    latencyMs,
  };
}

function validateRequest(request: ReasoningRequest): void {
  if (!request || typeof request !== 'object') throw new Error('request must be an object');
  text(request.role, 'request.role');
  if (!Array.isArray(request.messages) || !request.messages.length) throw new Error('request.messages must be non-empty');
  request.messages.forEach((message, index) => validateMessage(message, index));
  if (request.maxOutputTokens !== undefined) positiveInteger(request.maxOutputTokens, 'request.maxOutputTokens');
  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0)) {
    throw new Error('request.temperature must be finite and non-negative');
  }
  if (request.reasoningEffort !== undefined) text(request.reasoningEffort, 'request.reasoningEffort');
}
function validateMessage(message: ReasoningMessage, index: number): void {
  if (!message || typeof message !== 'object' || !['system', 'user', 'assistant', 'tool'].includes(message.role)
    || typeof message.content !== 'string' || (message.name !== undefined && !message.name.trim())) {
    throw new Error(`request.messages[${index}] is invalid`);
  }
}
function validateHeaders(value: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, item]) => !key.trim() || typeof item !== 'string')) {
    throw new Error('headers must map non-empty names to strings');
  }
  const forbidden = Object.keys(value).find((key) => ['authorization', 'content-type'].includes(key.toLowerCase()));
  if (forbidden) throw new Error(`Header '${forbidden}' is managed by the adapter`);
  return { ...value };
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}
function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
  return value as number;
}
function boundedNonnegativeInteger(value: unknown, max: number, name: string): number {
  const parsed = nonnegativeInteger(value, name);
  if (parsed > max) throw new Error(`${name} must be at most ${max}`);
  return parsed;
}
function httpUrl(value: unknown, name: string): string {
  const parsed = new URL(text(value, name));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must use http or https`);
  return parsed.href;
}
function bounded(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.slice(0, 500) + (compact.length > 500 ? '…' : '');
}
