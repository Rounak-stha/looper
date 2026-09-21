import type { RunLogger } from '../core/logger.js';
import { BudgetExceededError, callCost, type SpendLedger } from '../core/ledger.js';
import type { ModelTier, ReasoningRequest, ReasoningResult } from './types.js';

export interface MeteredCallContext { runId: string; taskId: string; step: number; runCapUsd?: number }

export class MeteredReasoningModel {
  constructor(
    private readonly tier: ModelTier,
    private readonly ledger: SpendLedger,
    private readonly logger?: RunLogger,
  ) {
    if (!tier.id.trim()) throw new Error('Reasoning tier id is required');
    if ([tier.priceInPerM, tier.priceOutPerM].some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error('Reasoning prices must be finite non-negative numbers');
    }
  }

  async complete(request: ReasoningRequest, context: MeteredCallContext, estimatedMaxCostUsd: number): Promise<ReasoningResult> {
    if (!Number.isFinite(estimatedMaxCostUsd) || estimatedMaxCostUsd < 0) {
      throw new Error('Estimated reasoning cost must be finite and non-negative');
    }
    await this.ledger.assertCanSpend(estimatedMaxCostUsd);
    if (context.runCapUsd !== undefined) {
      const runSpentUsd = await this.ledger.spent({ runId: context.runId });
      if (runSpentUsd + estimatedMaxCostUsd > context.runCapUsd) {
        throw new BudgetExceededError(runSpentUsd, estimatedMaxCostUsd, context.runCapUsd);
      }
    }
    const result = await this.tier.model.complete({
      ...request,
      ...(request.reasoningEffort === undefined && this.tier.defaultReasoningEffort !== undefined
        ? { reasoningEffort: this.tier.defaultReasoningEffort } : {}),
    });
    validateReasoningResult(result);
    const costUsd = callCost(result.usage.inputTokens, result.usage.outputTokens, this.tier.priceInPerM, this.tier.priceOutPerM);
    let budgetError: BudgetExceededError | undefined;
    try {
      await this.ledger.append({
        ts: new Date().toISOString(), runId: context.runId, taskId: context.taskId,
        role: request.role, tier: this.tier.id, model: result.model,
        inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd,
      }, context.runCapUsd);
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      budgetError = error;
    }
    await this.logger?.emit('llm_call', context.step, {
      role: request.role, tier: this.tier.id, model_id: result.model,
      tokens_in: result.usage.inputTokens, tokens_out: result.usage.outputTokens,
      cost: costUsd, latency_ms: result.latencyMs, finish_reason: result.finishReason,
      budget_exceeded: budgetError !== undefined,
    });
    if (budgetError) {
      budgetError.incurredReasoningTokens = result.usage.inputTokens + result.usage.outputTokens;
      throw budgetError;
    }
    return result;
  }
}

function validateReasoningResult(result: ReasoningResult): void {
  if (!result || typeof result !== 'object') throw new Error('Reasoning provider returned an invalid result');
  if (typeof result.content !== 'string' || typeof result.model !== 'string' || !result.model.trim()
    || typeof result.finishReason !== 'string' || !result.finishReason) {
    throw new Error('Reasoning provider returned invalid text or model metadata');
  }
  if (!result.usage || !Number.isInteger(result.usage.inputTokens) || result.usage.inputTokens < 0
    || !Number.isInteger(result.usage.outputTokens) || result.usage.outputTokens < 0) {
    throw new Error('Reasoning provider returned invalid token usage');
  }
  if (!Number.isFinite(result.latencyMs) || result.latencyMs < 0) {
    throw new Error('Reasoning provider returned invalid latency');
  }
}
