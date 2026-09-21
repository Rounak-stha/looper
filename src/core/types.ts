export type CandidateId = string;

export interface ContextCandidate {
  id: CandidateId;
  kind: 'file' | 'symbol' | 'test' | 'git_change';
  path: string;
  symbol?: string;
  summary?: string;
  relations?: CandidateId[];
  approxTokens: number;
}

export interface ContextProvider {
  search(query: string, opts: { limit: number }): Promise<ContextCandidate[]>;
  load(id: CandidateId): Promise<{ id: CandidateId; text: string; tokens: number }>;
}

export interface ScoredCandidate {
  id: CandidateId;
  p: number;
  via: 'choice' | 'noul' | 'bm25' | 'heuristic' | 'llm' | 'oracle';
}

export interface Selector {
  select(input: {
    task: string;
    candidates: ContextCandidate[];
    alreadyLoaded: CandidateId[];
    budget: { maxItems: number; maxTokens: number };
  }): Promise<{
    selected: CandidateId[];
    scores: ScoredCandidate[];
    unselected: CandidateId[];
    meta: Record<string, unknown>;
  }>;
}

export type AgentAction = 'reason' | 'retrieve_context' | 'read_file' | 'run_tests' | 'stop';

export interface RouterState {
  task: string;
  phase: 'start' | 'context_loaded' | 'post_edit' | 'post_test';
  loaded: 'none' | 'few' | 'many';
  unloadedCandidates: 'none' | 'some';
  tests: { lastRun: 'never' | 'passed' | 'failed'; dirtySinceLastRun: boolean };
  completionPolicy?: 'visible_tests' | 'submission';
  hasSuccessfulEdit?: boolean;
  lastActions: AgentAction[];
}

export interface Router {
  route(input: { state: RouterState; feasible: AgentAction[] }): Promise<{
    action: AgentAction;
    args?: { target?: CandidateId; query?: string };
    probs?: Record<string, number>;
    source: 'rule' | 'decision_model' | 'llm' | 'fallback';
  }>;
}

export interface ModelSelector {
  pick(input: {
    role: string;
    task?: string;
    features?: Record<string, string>;
  }): Promise<{ tier: string }>;
}
