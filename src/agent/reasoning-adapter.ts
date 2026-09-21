import type { MeteredCallContext, MeteredReasoningModel } from '../models/metered.js';
import type { ReasoningRequest, ReasoningResult } from '../models/types.js';
import type { AgentDecision, AgentTurnInput, CodingReasoner } from './types.js';

export interface CodingDecisionCodec {
  request(input: AgentTurnInput): Omit<ReasoningRequest, 'role'>;
  decode(result: ReasoningResult): AgentDecision;
  repair?(request: Omit<ReasoningRequest, 'role'>, result: ReasoningResult, error: Error): Omit<ReasoningRequest, 'role'>;
}

export class ConsumedReasoningError extends Error {
  constructor(readonly cause: Error, readonly incurredReasoningTokens: number) {
    super(cause.message);
    this.name = 'ConsumedReasoningError';
  }
}

export interface CodingReasonerCallContext {
  current(): MeteredCallContext;
  estimatedMaxCostUsd(input: AgentTurnInput): number;
}

/** Bridges the generic metered text model to structured coding decisions via an injected codec. */
export class MeteredCodingReasoner implements CodingReasoner {
  constructor(
    private readonly model: MeteredReasoningModel,
    private readonly codec: CodingDecisionCodec,
    private readonly context: CodingReasonerCallContext,
    private readonly role = 'coder',
    private readonly maxDecodeRetries = 0,
  ) {
    if (!Number.isInteger(maxDecodeRetries) || maxDecodeRetries < 0 || maxDecodeRetries > 3) {
      throw new Error('maxDecodeRetries must be an integer between 0 and 3');
    }
  }

  async decide(input: AgentTurnInput): Promise<AgentDecision & { usage: { inputTokens: number; outputTokens: number } }> {
    let request = this.codec.request(input);
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; ; attempt++) {
      let result: ReasoningResult;
      try {
        result = await this.model.complete(
          { ...request, role: this.role },
          this.context.current(),
          this.context.estimatedMaxCostUsd(input),
        );
      } catch (error) {
        if (error instanceof Error && 'incurredReasoningTokens' in error
          && Number.isInteger(error.incurredReasoningTokens) && (error.incurredReasoningTokens as number) >= 0) {
          error.incurredReasoningTokens = inputTokens + outputTokens + (error.incurredReasoningTokens as number);
          throw error;
        }
        if (inputTokens + outputTokens > 0) {
          throw new ConsumedReasoningError(error instanceof Error ? error : new Error(String(error)), inputTokens + outputTokens);
        }
        throw error;
      }
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      try {
        const decision = this.codec.decode(result);
        return { ...decision, usage: { inputTokens, outputTokens } };
      } catch (error) {
        const decodeError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= this.maxDecodeRetries || !this.codec.repair) {
          throw new ConsumedReasoningError(decodeError, inputTokens + outputTokens);
        }
        try {
          request = this.codec.repair(request, result, decodeError);
        } catch (repairError) {
          throw new ConsumedReasoningError(
            repairError instanceof Error ? repairError : new Error(String(repairError)),
            inputTokens + outputTokens,
          );
        }
      }
    }
  }
}
