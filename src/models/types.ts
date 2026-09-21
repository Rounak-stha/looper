export interface ReasoningMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ReasoningRequest {
  role: string;
  messages: ReasoningMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}

export interface ReasoningResult {
  content: string;
  model: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

/** Provider-neutral generative model boundary. */
export interface ReasoningModel {
  complete(request: ReasoningRequest): Promise<ReasoningResult>;
}

export interface ModelTier {
  id: string;
  model: ReasoningModel;
  priceInPerM: number;
  priceOutPerM: number;
  defaultReasoningEffort?: string;
}

export interface RoleModelRegistry {
  get(role: string): ModelTier;
}
