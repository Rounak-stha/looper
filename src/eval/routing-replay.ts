import type { AgentAction, Router, RouterState } from '../core/types.js';

export interface LabeledRoutingState {
  id: string;
  state: RouterState;
  feasible: AgentAction[];
  candidatePaths?: Record<string, string>;
  labels: {
    shouldStop?: boolean;
    needsRetrieval?: boolean;
    validReadTargets?: string[];
  };
}

export interface RoutingReplayMetrics {
  decisions: number;
  stopNegativeDecisions: number;
  stopPositiveDecisions: number;
  retrievalPositiveDecisions: number;
  falseStopRate: number;
  falseContinueRate: number;
  missedRetrievalRate: number;
  invalidDecisionRate: number;
  readDecisions: number;
  invalidReadTargetRate: number;
  fallbackRate: number;
}

export async function evaluateRouter(router: Router, cases: LabeledRoutingState[]): Promise<RoutingReplayMetrics> {
  let stopNegatives = 0; let falseStops = 0;
  let stopPositives = 0; let falseContinues = 0;
  let retrievalPositives = 0; let missedRetrieval = 0;
  let invalid = 0; let readDecisions = 0; let invalidReadTargets = 0; let fallbacks = 0;

  for (const item of cases) {
    const raw = await router.route({ state: item.state, feasible: item.feasible });
    const result = replayDecision(raw, item.feasible);
    let decisionInvalid = !result.valid || result.action === undefined || !item.feasible.includes(result.action);
    if (result.action === 'read_file') {
      readDecisions++;
      const target = result.target;
      const path = target === undefined ? undefined : item.candidatePaths?.[target];
      if (!path || !item.labels.validReadTargets?.includes(path)) {
        invalidReadTargets++;
        decisionInvalid = true;
      }
    }
    if (decisionInvalid) invalid++;
    if (result.source === 'fallback') fallbacks++;
    if (item.labels.shouldStop !== undefined && item.feasible.includes('stop')) {
      if (item.labels.shouldStop) {
        stopPositives++;
        if (result.action !== 'stop') falseContinues++;
      } else {
        stopNegatives++;
        if (result.action === 'stop') falseStops++;
      }
    }
    if (item.labels.needsRetrieval !== undefined
      && item.feasible.some((action) => action === 'retrieve_context' || action === 'read_file')) {
      if (item.labels.needsRetrieval) {
        retrievalPositives++;
        if (!result.action || !['retrieve_context', 'read_file'].includes(result.action)) missedRetrieval++;
      }
    }
  }

  return {
    decisions: cases.length,
    stopNegativeDecisions: stopNegatives,
    stopPositiveDecisions: stopPositives,
    retrievalPositiveDecisions: retrievalPositives,
    falseStopRate: ratio(falseStops, stopNegatives),
    falseContinueRate: ratio(falseContinues, stopPositives),
    missedRetrievalRate: ratio(missedRetrieval, retrievalPositives),
    invalidDecisionRate: ratio(invalid, cases.length),
    readDecisions,
    invalidReadTargetRate: ratio(invalidReadTargets, readDecisions),
    fallbackRate: ratio(fallbacks, cases.length),
  };
}

function replayDecision(value: unknown, feasible: AgentAction[]): {
  action?: AgentAction; target?: string; source?: string; valid: boolean;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
  const record = value as Record<string, unknown>;
  const actions: AgentAction[] = ['reason', 'retrieve_context', 'read_file', 'run_tests', 'stop'];
  const action = actions.includes(record.action as AgentAction) ? record.action as AgentAction : undefined;
  const sources = ['rule', 'decision_model', 'llm', 'fallback'];
  const source = typeof record.source === 'string' ? record.source : undefined;
  let valid = action !== undefined && feasible.includes(action) && source !== undefined && sources.includes(source);
  let target: string | undefined;
  if (record.args !== undefined) {
    if (!record.args || typeof record.args !== 'object' || Array.isArray(record.args)) valid = false;
    else {
      const args = record.args as Record<string, unknown>;
      if (args.target !== undefined) {
        if (typeof args.target !== 'string' || !args.target.trim()) valid = false;
        else target = args.target;
      }
      if (args.query !== undefined && (typeof args.query !== 'string' || !args.query.trim())) valid = false;
    }
  }
  if (record.probs !== undefined) {
    if (!record.probs || typeof record.probs !== 'object' || Array.isArray(record.probs)) valid = false;
    else {
      const entries = Object.entries(record.probs as Record<string, unknown>);
      const total = entries.reduce((sum, [, probability]) => sum + (typeof probability === 'number' ? probability : 0), 0);
      if (!entries.length || entries.some(([key, probability]) => !feasible.includes(key as AgentAction)
        || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1)
        || Math.abs(total - 1) > 1e-6) valid = false;
    }
  }
  return { ...(action ? { action } : {}), ...(target ? { target } : {}), ...(source ? { source } : {}), valid };
}

function ratio(value: number, total: number): number { return total ? value / total : 0; }
