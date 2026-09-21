import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DecisionCache, cacheKey } from '../cache.js';
import { RequestLimiter } from '../limiter.js';
import type {
  DecisionCallOptions, DecisionModel, DecisionQuestions, DecisionRequest,
  DecisionResponse, DecisionResult, DecisionState,
} from '../types.js';
import { DecisionValidationError, validateRequest, validateResponse } from '../validate.js';

export interface TypeSafeSystemOneConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  concurrency?: number;
  maxRequestsPerMinute?: number;
  maxInputTokens?: number;
  cacheDir?: string;
  logPath?: string;
  maxAttempts?: number;
  baseRetryMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class TypeSafeSystemOneHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`TypeSafe System One request failed with HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = 'TypeSafeSystemOneHttpError';
  }
}

/** Adapter for TypeSafe AI's System One HTTP API. Model identity belongs in config. */
export class TypeSafeSystemOneProvider implements DecisionModel {
  private readonly baseUrl: string;
  private readonly maxInputTokens: number;
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly cache: DecisionCache;
  private readonly limiter: RequestLimiter;

  constructor(private readonly config: TypeSafeSystemOneConfig) {
    if (!config.apiKey) throw new DecisionValidationError('API_KEY', 'TypeSafe API key is required');
    if (!config.model.trim()) throw new DecisionValidationError('MODEL', 'A pinned model id is required');
    this.baseUrl = config.baseUrl ?? 'https://api.typesafe.ai/v1/systemone';
    this.maxInputTokens = config.maxInputTokens ?? 30_000;
    this.maxAttempts = config.maxAttempts ?? 4;
    this.baseRetryMs = config.baseRetryMs ?? 250;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.cache = new DecisionCache(config.cacheDir ?? '.cache/decisions/typesafe-system-one');
    this.limiter = new RequestLimiter(config.concurrency ?? 8, config.maxRequestsPerMinute ?? 1_000);
  }

  async ask(
    state: DecisionState,
    questions: DecisionQuestions,
    options: DecisionCallOptions = {},
  ): Promise<DecisionResult> {
    const request: DecisionRequest = { state, model: this.config.model, questions };
    validateRequest(request, this.maxInputTokens);
    const key = cacheKey(request);
    if (options.cache !== 'bypass') {
      const cached = await this.cache.get(key);
      if (cached) {
        validateResponse(cached, request);
        this.assertPinned(cached);
        const result = this.toResult(cached, 0, true);
        await this.log(options.purpose, request, cached, 0, true);
        return result;
      }
    }

    const started = performance.now();
    let response: DecisionResponse;
    try {
      response = await this.limiter.run(() => this.fetchWithRetry(request));
    } catch (error) {
      await this.log(options.purpose, request, undefined, performance.now() - started, false, error);
      throw error;
    }
    const latencyMs = performance.now() - started;
    try {
      validateResponse(response, request);
      this.assertPinned(response);
    } catch (error) {
      await this.log(options.purpose, request, response, latencyMs, false, error);
      throw error;
    }
    if (options.cache !== 'bypass') await this.cache.set(key, response);
    await this.log(options.purpose, request, response, latencyMs, false);
    return this.toResult(response, latencyMs, false);
  }

  private async fetchWithRetry(request: DecisionRequest): Promise<DecisionResponse> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (response.ok) return await response.json() as DecisionResponse;
      const body = await response.text();
      if (![429, 529].includes(response.status) || attempt >= this.maxAttempts) {
        throw new TypeSafeSystemOneHttpError(response.status, body);
      }
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      const exponential = this.baseRetryMs * 2 ** (attempt - 1);
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1_000 : exponential * (0.75 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private assertPinned(response: DecisionResponse): void {
    if (response.model !== this.config.model) {
      throw new DecisionValidationError('MODEL_DRIFT', `Expected ${this.config.model}, received ${response.model}`);
    }
  }

  private toResult(response: DecisionResponse, latencyMs: number, cacheHit: boolean): DecisionResult {
    const result: DecisionResult = {
      model: response.model, nouls: {}, choices: {}, scores: {}, usage: response.usage,
      raw: response, latencyMs, cacheHit,
    };
    for (const [id, answer] of Object.entries(response.answers)) {
      if (answer.type === 'noul') result.nouls[id] = answer.noul;
      else if (answer.type === 'choice') {
        result.choices[id] = { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
      } else {
        const { type: _type, ...score } = answer;
        result.scores[id] = score;
      }
    }
    return result;
  }

  private async log(
    purpose: DecisionCallOptions['purpose'], request: DecisionRequest, response: DecisionResponse | undefined,
    latencyMs: number, cacheHit: boolean, error?: unknown,
  ): Promise<void> {
    if (!this.config.logPath) return;
    await mkdir(dirname(this.config.logPath), { recursive: true });
    const event = {
      ts: new Date().toISOString(), type: 'decision_call',
      payload: {
        provider: 'typesafe-system-one', purpose: purpose ?? 'characterize', request, response,
        latency_ms: Math.round(latencyMs), cache_hit: cacheHit,
        error: error instanceof Error ? { name: error.name, message: error.message } : error,
      },
    };
    await appendFile(this.config.logPath, `${JSON.stringify(event)}\n`);
  }
}
