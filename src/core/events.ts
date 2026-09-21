export type RunEventType =
  | 'run_start' | 'candidates' | 'decision_call' | 'selection' | 'route'
  | 'llm_call' | 'tool_call' | 'escape' | 'snapshot' | 'agent_end' | 'run_end';

export interface RunEvent<T = Record<string, unknown>> {
  run_id: string;
  task_id: string;
  config_id: string;
  step: number;
  ts: string;
  type: RunEventType;
  payload: T;
}

export interface RunManifest {
  gitSha?: string;
  datasetVersion: string;
  configHash: string;
  modelIds: string[];
  decisionModelIds: string[];
  environmentId?: string;
}
