import { BudgetExceededError, callCost, type SpendLedger } from '../core/ledger.js';
import type { RunLogger } from '../core/logger.js';
import type {
  DecisionCallOptions, DecisionModel, DecisionQuestions, DecisionResult, DecisionState,
} from './types.js';

export interface DecisionPricing {
  tier: string;
  priceInPerM: number;
  priceOutPerM: number;
}

export interface DecisionMeterContext {
  runId: string;
  taskId: string;
  runCapUsd?: number;
  currentStep(): number;
  estimatedMaxCostUsd(state: DecisionState, questions: DecisionQuestions): number;
}

/** Adds shared spend enforcement and run-correlated events to any decision provider. */
export class MeteredDecisionModel implements DecisionModel {
  constructor(
    private readonly model: DecisionModel,
    private readonly pricing: DecisionPricing,
    private readonly ledger: SpendLedger,
    private readonly logger: RunLogger,
    private readonly context: DecisionMeterContext,
  ) {
    if (!pricing.tier.trim()) throw new Error('Decision tier is required');
    if ([pricing.priceInPerM, pricing.priceOutPerM].some((value) => value < 0 || !Number.isFinite(value))) {
      throw new Error('Decision prices must be finite non-negative numbers');
    }
  }

  async ask(state: DecisionState, questions: DecisionQuestions, options: DecisionCallOptions = {}): Promise<DecisionResult> {
    const estimate = this.context.estimatedMaxCostUsd(state, questions);
    await this.assertCanSpend(estimate);
    const result = await this.model.ask(state, questions, options);
    validateMeteredDecisionResult(result);
    const costUsd = result.cacheHit ? 0 : callCost(
      result.usage.input_tokens, result.usage.output_tokens,
      this.pricing.priceInPerM, this.pricing.priceOutPerM,
    );
    let budgetError: BudgetExceededError | undefined;
    if (costUsd > 0) {
      try {
        await this.ledger.append({
          ts: new Date().toISOString(), runId: this.context.runId, taskId: this.context.taskId,
          role: options.purpose ?? 'decision', tier: this.pricing.tier, model: result.model,
          inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, costUsd,
        }, this.context.runCapUsd);
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        budgetError = error;
      }
    }
    await this.logger.emit('decision_call', this.context.currentStep(), {
      purpose: options.purpose ?? 'decision', tier: this.pricing.tier, model_id: result.model,
      tokens_in: result.usage.input_tokens, tokens_out: result.usage.output_tokens,
      cost_usd: costUsd, latency_ms: result.latencyMs, cache_hit: result.cacheHit,
      budget_exceeded: budgetError !== undefined,
    });
    if (budgetError) throw budgetError;
    return result;
  }

  private async assertCanSpend(estimate: number): Promise<void> {
    if (!Number.isFinite(estimate) || estimate < 0) throw new Error('Estimated decision cost must be finite and non-negative');
    await this.ledger.assertCanSpend(estimate);
    if (this.context.runCapUsd !== undefined) {
      const spent = await this.ledger.spent({ runId: this.context.runId });
      if (spent + estimate > this.context.runCapUsd) {
        throw new BudgetExceededError(spent, estimate, this.context.runCapUsd);
      }
    }
  }
}

function validateMeteredDecisionResult(result: DecisionResult): void {
  if (!result || typeof result !== 'object' || typeof result.model !== 'string' || !result.model.trim()) {
    throw new Error('Decision provider returned invalid model metadata');
  }
  if (typeof result.cacheHit !== 'boolean') throw new Error('Decision provider returned invalid cache status');
  if (!Number.isFinite(result.latencyMs) || result.latencyMs < 0) throw new Error('Decision provider returned invalid latency');
  if (!result.usage || !Number.isInteger(result.usage.input_tokens) || result.usage.input_tokens < 0
    || !Number.isInteger(result.usage.output_tokens) || result.usage.output_tokens < 0) {
    throw new Error('Decision provider returned invalid token usage');
  }
}
