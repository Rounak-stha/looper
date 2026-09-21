import type { DecisionRequest, DecisionResponse } from './types.js';

export class DecisionValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DecisionValidationError';
    this.code = code;
  }
}

export class DecisionTokenBudgetError extends DecisionValidationError {
  readonly estimatedTokens: number;
  readonly limit: number;
  constructor(estimatedTokens: number, limit: number) {
    super('TOKEN_BUDGET', `Estimated request size ${estimatedTokens} exceeds limit ${limit}`);
    this.name = 'DecisionTokenBudgetError';
    this.estimatedTokens = estimatedTokens;
    this.limit = limit;
  }
}

// Phase 0 calibration: chars/4 under-estimated a 50-option request by 29%.
// The 1.6 safety factor makes local rejection conservative until T2 yields
// measurements near the actual token limit.
export function estimateTokens(value: unknown): number {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  return Math.ceil((bytes / 4) * 1.6);
}

export function validateRequest(request: DecisionRequest, maxInputTokens: number): void {
  if (request.state === null || request.state === undefined) {
    throw new DecisionValidationError('NULL_STATE', 'Decision state must not be null');
  }
  if (!request.model.trim()) throw new DecisionValidationError('MODEL', 'Decision model is required');

  const entries = Object.entries(request.questions);
  if (entries.length === 0) throw new DecisionValidationError('QUESTIONS', 'At least one question is required');

  for (const [id, question] of entries) {
    if (!id.trim()) throw new DecisionValidationError('QUESTION_ID', 'Question ids must not be empty');
    if (!question.instructions.trim()) {
      throw new DecisionValidationError('INSTRUCTIONS', `Question ${id} requires instructions`);
    }
    if (question.type === 'choice') {
      const count = Object.keys(question.criteria).length;
      if (count < 2 || count > 255) {
        throw new DecisionValidationError('CHOICE_OPTIONS', `Choice ${id} must have 2–255 options; got ${count}`);
      }
    }
    if (question.type === 'score') {
      const count = question.criteria.length;
      if (count < 2 || count > 10) {
        throw new DecisionValidationError('SCORE_LEVELS', `Score ${id} must have 2–10 levels; got ${count}`);
      }
    }
  }

  const estimated = estimateTokens(request);
  if (estimated > maxInputTokens) throw new DecisionTokenBudgetError(estimated, maxInputTokens);
}

export function validateResponse(response: DecisionResponse, request: DecisionRequest): void {
  if (!response || typeof response.model !== 'string' || typeof response.answers !== 'object') {
    throw new DecisionValidationError('RESPONSE_SHAPE', 'Invalid decision-model response envelope');
  }
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id];
    if (!answer || answer.type !== question.type) {
      throw new DecisionValidationError('ANSWER_SHAPE', `Missing or mismatched answer for ${id}`);
    }
  }
}
