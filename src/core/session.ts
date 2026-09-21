import type { RunLogger } from './logger.js';
import type { ToolRuntime } from './plugins.js';
import type { AgentAction, RouterState } from './types.js';

export interface SessionBudgets {
  maxSteps: number;
  maxReasoningTokens: number;
  wallClockMs: number;
}

export class SessionBudgetError extends Error {
  constructor(readonly reason: 'steps' | 'reasoning_tokens' | 'wall_clock') {
    super(`Session ${reason} budget exceeded`);
    this.name = 'SessionBudgetError';
  }
}

export class Session {
  readonly startedAt = performance.now();
  step = 0;
  reasoningTokens = 0;
  readonly lastActions: AgentAction[] = [];

  constructor(
    readonly runId: string,
    readonly taskId: string,
    readonly tools: ToolRuntime,
    readonly logger: RunLogger,
    readonly budgets: SessionBudgets,
  ) {
    if (!Number.isInteger(budgets.maxSteps) || budgets.maxSteps < 1) throw new Error('maxSteps must be a positive integer');
    if (!Number.isInteger(budgets.maxReasoningTokens) || budgets.maxReasoningTokens < 1) {
      throw new Error('maxReasoningTokens must be a positive integer');
    }
    if (!Number.isFinite(budgets.wallClockMs) || budgets.wallClockMs <= 0) throw new Error('wallClockMs must be positive');
  }

  assertBudget(additionalReasoningTokens = 0): void {
    if (this.step >= this.budgets.maxSteps) throw new SessionBudgetError('steps');
    this.assertRuntimeBudget(additionalReasoningTokens);
  }

  assertRuntimeBudget(additionalReasoningTokens = 0): void {
    if (!Number.isInteger(additionalReasoningTokens) || additionalReasoningTokens < 0) {
      throw new Error('Additional reasoning tokens must be a non-negative integer');
    }
    if (this.reasoningTokens + additionalReasoningTokens > this.budgets.maxReasoningTokens) {
      throw new SessionBudgetError('reasoning_tokens');
    }
    if (performance.now() - this.startedAt > this.budgets.wallClockMs) throw new SessionBudgetError('wall_clock');
  }

  recordAction(action: AgentAction): void {
    this.step++;
    this.lastActions.push(action);
    if (this.lastActions.length > 3) this.lastActions.shift();
  }

  addReasoningTokens(tokens: number): void {
    if (!Number.isInteger(tokens) || tokens < 0) throw new Error('Additional reasoning tokens must be a non-negative integer');
    this.reasoningTokens += tokens;
    if (this.reasoningTokens > this.budgets.maxReasoningTokens) throw new SessionBudgetError('reasoning_tokens');
    if (performance.now() - this.startedAt > this.budgets.wallClockMs) throw new SessionBudgetError('wall_clock');
  }

  routerState(input: Omit<RouterState, 'lastActions'>): RouterState {
    return { ...input, lastActions: [...this.lastActions] };
  }
}
