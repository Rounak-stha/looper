import type { ActionPlanner, CodingReasoner } from '../agent/types.js';
import type { AgentTask, EvaluationTask } from '../eval/tasks.js';
import type { SpendLedger } from './ledger.js';
import type { RunLogger } from './logger.js';
import type { ContextProvider, Router, Selector } from './types.js';

export interface TaskMineOptions {
  limit?: number;
  maxSourceFiles?: number;
  maxChangedLines?: number;
}

/** Produces task candidates. The harness does not prescribe Git or any forge. */
export interface TaskSource {
  mine(location: string, options?: TaskMineOptions): Promise<EvaluationTask[]>;
}

/** Provides an immutable task workspace. It may use worktrees, containers, archives, or remote sandboxes. */
export interface WorkspaceLease {
  path: string;
  /** Optional opaque environment state owned and interpreted only by the supplying plugin. */
  environment?: unknown;
  release(): Promise<void>;
}

export interface WorkspaceProvider {
  acquire(task: EvaluationTask): Promise<WorkspaceLease>;
}

/** Builds a context implementation for an acquired workspace. */
export interface ContextProviderFactory {
  create(input: { workspacePath: string; task: AgentTask }): Promise<ContextProvider>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  durationMs: number;
  exitCode?: number;
}

/** Agent-side effects are supplied by the environment plugin, not implemented by the harness. */
export interface ToolRuntime {
  readFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<ToolResult>;
  writeFile(path: string, content: string): Promise<ToolResult>;
  /** Atomically replaces one exact, unique text occurrence; optional for legacy runtimes. */
  replaceText?(path: string, oldText: string, newText: string): Promise<ToolResult>;
  search(query: string): Promise<ToolResult>;
  runTests(): Promise<ToolResult>;
  runCommand?(command: string, args: string[]): Promise<ToolResult>;
  snapshot(): Promise<{ id: string }>;
}

export interface ToolRuntimeFactory {
  create(input: { workspace: WorkspaceLease; task: AgentTask }): Promise<ToolRuntime>;
}

export interface TaskEvaluationResult {
  passed: boolean;
  exitCode: number;
  durationMs: number;
  output?: string;
  metadata?: Record<string, unknown>;
}

/** Runs the authoritative evaluation for an agent-modified workspace. */
export interface TaskEvaluator {
  evaluate(input: { task: EvaluationTask; workspace: WorkspaceLease }): Promise<TaskEvaluationResult>;
}

/** Evaluates a durable, opaque repository snapshot after a run for routing replay labels. */
export interface SnapshotEvaluator {
  evaluate(input: { task: EvaluationTask; runId: string; snapshotId: string }): Promise<TaskEvaluationResult>;
}

export interface SelectorFactory {
  kinds(): string[];
  create(kind: string, input: {
    task: AgentTask;
    /** Characterization-only override; production selectors sanitize by default. */
    sanitizeSummaries?: boolean;
  }): Selector | undefined;
}

export interface ReplayRouterFactory {
  kinds(): string[];
  create(kind: string, input: { config: Record<string, unknown> }): Promise<Router>;
}

export interface AgentControllerFactory {
  create(input: {
    task: AgentTask;
    runId: string;
    configId: string;
    logger: RunLogger;
    ledger: SpendLedger;
    runCapUsd?: number;
    config: Record<string, unknown>;
    currentStep(): number;
  }): Promise<{ router: Router; reasoner: CodingReasoner; planner?: ActionPlanner }>;
}

export interface TaskValidationResult {
  before: { passed: boolean; exitCode: number; durationMs: number; output?: string };
  after: { passed: boolean; exitCode: number; durationMs: number; output?: string };
  reason?: string;
  metadata?: Record<string, unknown>;
}

/** Validation execution is plugin-owned; the harness only consumes pass/fail evidence. */
export interface TaskValidator {
  validate(task: EvaluationTask): Promise<TaskValidationResult>;
}

export interface HarnessPlugin {
  name: string;
  taskSource?: TaskSource;
  workspaces: WorkspaceProvider;
  context: ContextProviderFactory;
  selectors?: SelectorFactory;
  tools?: ToolRuntimeFactory;
  agent?: AgentControllerFactory;
  replayRouters?: ReplayRouterFactory;
  evaluator?: TaskEvaluator;
  snapshots?: SnapshotEvaluator;
  validator?: TaskValidator;
}

export function assertHarnessPlugin(value: unknown): asserts value is HarnessPlugin {
  if (!value || typeof value !== 'object') throw new Error('Plugin must export an object');
  const plugin = value as Partial<HarnessPlugin>;
  if (!plugin.name || typeof plugin.workspaces?.acquire !== 'function' || typeof plugin.context?.create !== 'function') {
    throw new Error('Plugin must provide name, workspaces.acquire(), and context.create()');
  }
  if (plugin.selectors && (typeof plugin.selectors.kinds !== 'function' || typeof plugin.selectors.create !== 'function')) {
    throw new Error('Plugin selectors must provide kinds() and create()');
  }
  if (plugin.tools && typeof plugin.tools.create !== 'function') {
    throw new Error('Plugin tools must provide create()');
  }
  if (plugin.agent && typeof plugin.agent.create !== 'function') {
    throw new Error('Plugin agent must provide create()');
  }
  if (plugin.replayRouters && (typeof plugin.replayRouters.kinds !== 'function'
    || typeof plugin.replayRouters.create !== 'function')) {
    throw new Error('Plugin replayRouters must provide kinds() and create()');
  }
  if (plugin.evaluator && typeof plugin.evaluator.evaluate !== 'function') {
    throw new Error('Plugin evaluator must provide evaluate()');
  }
  if (plugin.snapshots && typeof plugin.snapshots.evaluate !== 'function') {
    throw new Error('Plugin snapshots must provide evaluate()');
  }
  if (plugin.validator && typeof plugin.validator.validate !== 'function') {
    throw new Error('Plugin validator must provide validate()');
  }
}
