export type DecisionState = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface DecisionRequest {
  state: DecisionState;
  model: string;
  questions: DecisionQuestions;
}

export interface NoulAnswer { type: 'noul'; noul: number }
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities: Record<string, number> | number[];
  legend?: Record<string, string> | string[];
  confidence: number;
}
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface DecisionResult {
  model: string;
  nouls: Record<string, number>;
  choices: Record<string, Omit<ChoiceAnswer, 'type'>>;
  scores: Record<string, Omit<ScoreAnswer, 'type'>>;
  usage: DecisionResponse['usage'];
  raw: DecisionResponse;
  latencyMs: number;
  cacheHit: boolean;
}

export interface DecisionCallOptions {
  purpose?: 'select' | 'route' | 'stop_gate' | 'tier' | 'characterize';
  cache?: 'use' | 'bypass';
}

/** Provider-neutral contract for typed, non-generative decision models. */
export interface DecisionModel {
  ask(
    state: DecisionState,
    questions: DecisionQuestions,
    options?: DecisionCallOptions,
  ): Promise<DecisionResult>;
}
