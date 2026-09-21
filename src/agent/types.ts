import type { ContextCandidate } from '../core/types.js';

export type AgentToolCall =
  | { name: 'read_file'; path: string; startLine?: number; endLine?: number }
  | { name: 'write_file'; path: string; content: string }
  | { name: 'replace_text'; path: string; oldText: string; newText: string }
  | { name: 'search'; query: string }
  | { name: 'run_tests' };

export interface AgentDecision {
  thought?: string;
  tool?: AgentToolCall;
  done?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AgentObservation {
  action: string;
  ok: boolean;
  output: string;
}

export interface AgentTurnInput {
  task: string;
  selectedContext: Array<{ candidate: ContextCandidate; text: string }>;
  additionalContext: Array<{ source: 'read_file' | 'search'; target: string; text: string }>;
  unselectedManifest: string[];
  observations: AgentObservation[];
  tests: { lastRun: 'never' | 'passed' | 'failed'; dirtySinceLastRun: boolean };
}

/** Structured coding decisions avoid parsing provider-specific prose/tool formats in the loop. */
export interface CodingReasoner {
  /** Every call reports provider usage; deterministic/local implementations report zeros. */
  decide(input: AgentTurnInput): Promise<AgentDecision & { usage: { inputTokens: number; outputTokens: number } }>;
}

/** Supplies closed arguments for router actions without coupling the loop to retrieval or model APIs. */
export interface ActionPlanner {
  retrievalQuery(input: AgentTurnInput): Promise<string>;
  readTarget(input: AgentTurnInput): Promise<string | undefined>;
}
