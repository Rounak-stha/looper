import { randomUUID } from 'node:crypto';
import { AgentLoop, type AgentLoopResult } from '../agent/loop.js';
import type { ActionPlanner, CodingReasoner } from '../agent/types.js';
import type { ContextProviderFactory, TaskEvaluator, ToolRuntimeFactory, WorkspaceLease, WorkspaceProvider } from '../core/plugins.js';
import { RunLogger, type EventSink } from '../core/logger.js';
import { Session, type SessionBudgets } from '../core/session.js';
import type { ContextCandidate, Router, Selector } from '../core/types.js';
import type { RunManifest } from '../core/events.js';
import { BudgetExceededError } from '../core/ledger.js';
import { validateContextCandidates, validateSelectionResult } from '../selection/validate.js';
import { agentTask, type AgentTask, type EvaluationTask } from './tasks.js';
import { boundedExecutionEvidence, validateTaskEvaluationResult } from './execution-evidence.js';

export interface AgentRunDependencies {
  workspaces: WorkspaceProvider;
  context: ContextProviderFactory;
  tools: ToolRuntimeFactory;
  evaluator: TaskEvaluator;
  selectorFor(task: AgentTask): Selector;
  controllerFor(task: AgentTask, context: AgentComponentContext): Promise<{
    router: Router;
    reasoner: CodingReasoner;
    planner?: ActionPlanner;
  }>;
  events: EventSink;
}

export interface AgentComponentContext {
  runId: string;
  taskId: string;
  configId: string;
  logger: RunLogger;
  currentStep(): number;
}

export interface AgentRunOptions {
  configId: string;
  candidateLimit: number;
  poolCandidates?: number;
  candidateKinds?: ContextCandidate['kind'][];
  selectionBudget: { maxItems: number; maxTokens: number };
  initialContextMaxTokens?: number;
  dynamicContextMaxTokens?: number;
  sessionBudgets: SessionBudgets;
  manifest: RunManifest;
  reporting?: Record<string, string>;
  runId?: string;
}

export interface AgentTaskResult extends Omit<AgentLoopResult, 'outcome'> {
  runId: string;
  taskId: string;
  outcome: 'passed' | 'failed';
  visibleOutcome: AgentLoopResult['outcome'];
  selected: string[];
  unselected: string[];
}

/** Orchestrates one task while all environment/model choices remain injected. */
export async function runAgentTask(
  task: EvaluationTask,
  dependencies: AgentRunDependencies,
  options: AgentRunOptions,
): Promise<AgentTaskResult> {
  assertManifest(options.manifest);
  const runId = options.runId ?? `r_${randomUUID()}`;
  const runStarted = performance.now();
  const logger = new RunLogger(dependencies.events, { run_id: runId, task_id: task.id, config_id: options.configId });
  let workspace: WorkspaceLease | undefined;
  let terminalLogged = false;
  let session: Session | undefined;
  const reporting = { ...(task.reporting ?? {}), ...(options.reporting ?? {}) };
  await logger.emit('run_start', 0, {
    manifest: options.manifest, task: { type: task.type, reporting },
  });
  try {
    workspace = await dependencies.workspaces.acquire(task);
    const publicTask = agentTask(task);
    const context = await dependencies.context.create({ workspacePath: workspace.path, task: publicTask });
    const poolLimit = options.poolCandidates ?? options.candidateLimit;
    if (poolLimit < options.candidateLimit) throw new Error('poolCandidates must be at least candidateLimit');
    const pool = await context.search(task.task, { limit: poolLimit });
    validateContextCandidates(pool, poolLimit);
    const candidates = (options.candidateKinds
      ? pool.filter(({ kind }) => options.candidateKinds!.includes(kind))
      : pool).slice(0, options.candidateLimit);
    validateContextCandidates(candidates, options.candidateLimit);
    await logger.emit('candidates', 0, {
      task: task.task, query: task.task, N: candidates.length, pool_N: pool.length,
      ...(options.candidateKinds ? { candidate_kinds: options.candidateKinds } : {}),
      candidates: candidates.map(({ id, path, kind, summary, approxTokens }) => ({ id, path, kind, summary, approxTokens })),
    });

    const selection = await dependencies.selectorFor(publicTask).select({
      task: task.task, candidates, alreadyLoaded: [], budget: options.selectionBudget,
    });
    validateSelectionResult(candidates, selection, options.selectionBudget);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const selectedTokens = selection.selected.reduce((sum, id) => sum + byId.get(id)!.approxTokens, 0);
    const selectedContext: Array<{ candidate: (typeof candidates)[number]; text: string }> = [];
    const initialContextMaxChars = (options.initialContextMaxTokens ?? options.selectionBudget.maxTokens) * 4;
    let initialContextChars = 0;
    let loadedContextTokens = 0;
    let initialContextTruncated = false;
    for (const id of selection.selected) {
      const candidate = byId.get(id);
      if (!candidate) throw new Error(`Selector returned unknown candidate: ${id}`);
      const loaded = await context.load(id);
      validateLoadedContext(loaded, id);
      loadedContextTokens += loaded.tokens;
      const text = loaded.text.slice(0, Math.max(0, initialContextMaxChars - initialContextChars));
      initialContextChars += text.length;
      initialContextTruncated ||= text.length < loaded.text.length;
      selectedContext.push({ candidate, text });
    }
    await logger.emit('selection', 0, {
      scores: selection.scores, selected: selection.selected,
      unselected: selection.unselected, meta: selection.meta,
      selected_count: selection.selected.length, context_tokens: selectedTokens,
      loaded_context_tokens: loadedContextTokens,
      presented_context_tokens: Math.ceil(initialContextChars / 4), context_chars: initialContextChars,
      context_truncated: initialContextTruncated,
      budget: { max_items: options.selectionBudget.maxItems, max_tokens: options.selectionBudget.maxTokens },
    });

    const unselectedManifest = [...new Set(selection.unselected.map((id) => {
      const candidate = byId.get(id);
      if (!candidate) throw new Error(`Selector returned unknown unselected candidate: ${id}`);
      return candidate.path;
    }))];

    const tools = await dependencies.tools.create({ workspace, task: publicTask });
    const activeSession = new Session(runId, task.id, tools, logger, options.sessionBudgets);
    session = activeSession;
    const initialSnapshot = await tools.snapshot();
    validateSnapshot(initialSnapshot);
    await logger.emit('snapshot', 0, { id: initialSnapshot.id, initial: true });
    const componentContext: AgentComponentContext = {
      runId, taskId: task.id, configId: options.configId, logger,
      currentStep: () => activeSession.step,
    };
    const controller = await dependencies.controllerFor(publicTask, componentContext);
    const loop = new AgentLoop(activeSession, controller.reasoner, controller.router, controller.planner, {
      maxDynamicContextTokens: options.dynamicContextMaxTokens ?? options.selectionBudget.maxTokens,
      completionPolicy: task.type === 'T-issue' ? 'submission' : 'visible_tests',
    });
    const agentResult = await loop.run({ task: task.task, selectedContext, unselectedManifest });
    const evaluation = await dependencies.evaluator.evaluate({ task, workspace });
    validateTaskEvaluationResult(evaluation, 'Task evaluator');
    const outcome = evaluation.passed ? 'passed' : 'failed';
    await logger.emit('run_end', agentResult.steps, {
      outcome, visible_outcome: agentResult.outcome, termination_reason: agentResult.termination,
      totals: {
        steps: agentResult.steps, reasoning_tokens: agentResult.reasoningTokens,
        wall_clock_ms: performance.now() - runStarted,
      },
      task: { type: task.type, reporting },
      evaluation: boundedExecutionEvidence(evaluation),
    });
    terminalLogged = true;
    return {
      ...agentResult, outcome, visibleOutcome: agentResult.outcome,
      runId, taskId: task.id, selected: selection.selected, unselected: selection.unselected,
    };
  } catch (error) {
    if (!terminalLogged) await logger.emit('run_end', session?.step ?? 0, {
      outcome: 'error', visible_outcome: 'unknown',
      termination_reason: error instanceof BudgetExceededError ? 'budget' : 'infrastructure_error',
      totals: { steps: session?.step ?? 0, reasoning_tokens: session?.reasoningTokens ?? 0, wall_clock_ms: performance.now() - runStarted },
      task: { type: task.type, reporting },
      error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
    });
    throw error;
  } finally {
    await workspace?.release();
  }
}

function validateLoadedContext(value: unknown, requestedId: string): asserts value is { id: string; text: string; tokens: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Context provider returned an invalid load result for '${requestedId}'`);
  const loaded = value as Record<string, unknown>;
  if (loaded.id !== requestedId) throw new Error(`Context provider loaded '${String(loaded.id)}' for requested candidate '${requestedId}'`);
  if (typeof loaded.text !== 'string') throw new Error(`Context provider returned invalid text for '${requestedId}'`);
  if (!Number.isInteger(loaded.tokens) || (loaded.tokens as number) < 0) {
    throw new Error(`Context provider returned invalid token count for '${requestedId}'`);
  }
}

function validateSnapshot(value: unknown): asserts value is { id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof (value as Record<string, unknown>).id !== 'string'
    || !(value as { id: string }).id.trim()) {
    throw new Error('Tool runtime returned an invalid snapshot id');
  }
}

function assertManifest(manifest: RunManifest): void {
  if (!manifest.datasetVersion.trim() || !manifest.configHash.trim()) {
    throw new Error('Run manifest requires datasetVersion and configHash');
  }
  if (!Array.isArray(manifest.modelIds) || !Array.isArray(manifest.decisionModelIds)) {
    throw new Error('Run manifest requires model identity arrays');
  }
}
