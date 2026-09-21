import { createHash } from 'node:crypto';
import { BudgetExceededError } from '../core/ledger.js';
import type { ToolResult } from '../core/plugins.js';
import type { Session } from '../core/session.js';
import type { ContextCandidate, Router } from '../core/types.js';
import { feasibleActions } from '../routing/feasible.js';
import { ConsumedReasoningError } from './reasoning-adapter.js';
import type { ActionPlanner, AgentDecision, AgentObservation, AgentTurnInput, CodingReasoner } from './types.js';

export interface AgentLoopInput {
  task: string;
  selectedContext: Array<{ candidate: ContextCandidate; text: string }>;
  unselectedManifest: string[];
}

export interface AgentLoopOptions {
  maxDynamicContextTokens: number;
  charsPerToken?: number;
  /** T-fix requires passing visible tests; T-issue submits an edited tree for hidden evaluation. */
  completionPolicy?: 'visible_tests' | 'submission';
}

export interface AgentLoopResult {
  outcome: 'passed' | 'failed' | 'unknown';
  termination: 'stop' | 'budget' | 'error';
  steps: number;
  reasoningTokens: number;
}

export class AgentLoop {
  constructor(
    private readonly session: Session,
    private readonly reasoner: CodingReasoner,
    private readonly router: Router,
    private readonly planner: ActionPlanner = defaultPlanner,
    private readonly options: AgentLoopOptions = { maxDynamicContextTokens: 30_000 },
  ) {
    if (!Number.isInteger(options.maxDynamicContextTokens) || options.maxDynamicContextTokens < 1) {
      throw new Error('maxDynamicContextTokens must be a positive integer');
    }
    if (options.charsPerToken !== undefined && (!Number.isFinite(options.charsPerToken) || options.charsPerToken <= 0)) {
      throw new Error('charsPerToken must be positive');
    }
  }

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const observations: AgentObservation[] = [];
    const additionalContext: AgentTurnInput['additionalContext'] = [];
    const remainingManifest = new Set(input.unselectedManifest);
    let dynamicContextChars = 0;
    let loadedCount = input.selectedContext.length;
    let phase: 'start' | 'context_loaded' | 'post_edit' | 'post_test' = loadedCount ? 'context_loaded' : 'start';
    let lastRun: 'never' | 'passed' | 'failed' = 'never';
    let dirtySinceLastRun = false;
    let hasSuccessfulEdit = false;
    let outcome: AgentLoopResult['outcome'] = 'unknown';

    try {
      while (true) {
        this.session.assertBudget();
        const state = this.session.routerState({
          task: input.task, phase,
          loaded: loadedCount > 8 ? 'many' : loadedCount ? 'few' : 'none',
          unloadedCandidates: remainingManifest.size ? 'some' : 'none',
          tests: { lastRun, dirtySinceLastRun },
          completionPolicy: this.options.completionPolicy ?? 'visible_tests', hasSuccessfulEdit,
        });
        const completionPolicy = this.options.completionPolicy ?? 'visible_tests';
        const feasible = feasibleActions(state, { completionPolicy, hasSuccessfulEdit });
        const route = await this.router.route({ state, feasible });
        this.session.assertRuntimeBudget();
        validateRoute(route, feasible);
        if (!feasible.includes(route.action)) {
          throw new Error(`Router returned infeasible action '${route.action}'`);
        }
        await this.session.logger.emit('route', this.session.step, { state, feasible, ...route });
        this.session.recordAction(route.action);

        if (route.action === 'stop') {
          outcome = completionPolicy === 'visible_tests' && lastRun === 'passed' && !dirtySinceLastRun ? 'passed' : 'unknown';
          return await this.finish(outcome, 'stop');
        }
        const turnInput: AgentTurnInput = {
          task: input.task, selectedContext: input.selectedContext, additionalContext: [...additionalContext],
          unselectedManifest: [...remainingManifest], observations, tests: { lastRun, dirtySinceLastRun },
        };
        if (route.action === 'run_tests') {
          const result = await this.session.tools.runTests();
          validateToolResult(result, 'run_tests');
          const context = this.contextSlice(result.output, dynamicContextChars);
          dynamicContextChars += context.text.length;
          lastRun = result.ok ? 'passed' : 'failed'; dirtySinceLastRun = false; phase = 'post_test';
          observations.push({ action: 'run_tests', ok: result.ok, output: context.text });
          await this.logTool('run_tests', {}, result, context);
          await this.logSnapshot();
          this.session.assertRuntimeBudget();
          continue;
        }
        if (route.action === 'retrieve_context') {
          const query = await this.planner.retrievalQuery(turnInput);
          this.session.assertRuntimeBudget();
          if (typeof query !== 'string' || !query.trim()) throw new Error('Action planner supplied an invalid retrieval query');
          const result = await this.executeDecision(
            { tool: { name: 'search', query } }, observations, remainingManifest, additionalContext, dynamicContextChars,
          );
          dynamicContextChars += result.contextChars;
          if (result.ok) { loadedCount++; phase = 'context_loaded'; }
          continue;
        }
        if (route.action === 'read_file') {
          const path = await this.planner.readTarget(turnInput);
          this.session.assertRuntimeBudget();
          if (typeof path !== 'string' || !path.trim()) {
            throw new Error('Router selected read_file but the action planner supplied no valid target');
          }
          if (!remainingManifest.has(path)) throw new Error(`Action planner supplied unknown read target '${path}'`);
          const result = await this.executeDecision(
            { tool: { name: 'read_file', path } }, observations, remainingManifest, additionalContext, dynamicContextChars,
          );
          dynamicContextChars += result.contextChars;
          if (result.ok) { loadedCount++; phase = 'context_loaded'; }
          continue;
        }

        const decision = await this.reasoner.decide(turnInput);
        validateAgentDecision(decision);
        this.session.addReasoningTokens(decision.usage!.inputTokens + decision.usage!.outputTokens);
        const toolResult = await this.executeDecision(
          decision, observations, remainingManifest, additionalContext, dynamicContextChars,
        );
        dynamicContextChars += toolResult.contextChars;
        if (['write_file', 'replace_text'].includes(decision.tool?.name ?? '') && toolResult.ok) {
          dirtySinceLastRun = true; hasSuccessfulEdit = true; phase = 'post_edit';
        }
        if (toolResult.ok && ['read_file', 'search'].includes(decision.tool?.name ?? '')) {
          loadedCount++; phase = 'context_loaded';
        }
        if (decision.tool?.name === 'run_tests') {
          const latest = observations.at(-1)!;
          lastRun = latest.ok ? 'passed' : 'failed'; dirtySinceLastRun = false; phase = 'post_test';
        }
      }
    } catch (error) {
      const incurredTokens = error instanceof BudgetExceededError ? error.incurredReasoningTokens
        : error instanceof ConsumedReasoningError ? error.incurredReasoningTokens : undefined;
      let accountingExceededBudget = false;
      if (incurredTokens !== undefined) {
        try { this.session.addReasoningTokens(incurredTokens); } catch (accountingError) {
          accountingExceededBudget = accountingError instanceof Error && accountingError.name === 'SessionBudgetError';
        }
      }
      const budget = accountingExceededBudget || error instanceof BudgetExceededError
        || (error instanceof Error && error.name === 'SessionBudgetError');
      await this.session.logger.emit('agent_end', this.session.step, {
        visible_outcome: outcome, totals: { steps: this.session.step, reasoning_tokens: this.session.reasoningTokens },
        termination_reason: budget ? 'budget' : 'error', error: error instanceof Error ? error.message : String(error),
      });
      return { outcome, termination: budget ? 'budget' : 'error', steps: this.session.step, reasoningTokens: this.session.reasoningTokens };
    }
  }

  private async executeDecision(
    decision: AgentDecision,
    observations: AgentObservation[],
    manifest: Set<string>,
    additionalContext: AgentTurnInput['additionalContext'],
    dynamicContextChars: number,
  ): Promise<{ ok: boolean; contextChars: number }> {
    const tool = decision.tool;
    if (!tool) {
      observations.push({ action: 'reason', ok: true, output: decision.thought ?? '' });
      return { ok: true, contextChars: 0 };
    }
    const result = tool.name === 'read_file' ? await this.session.tools.readFile(tool.path, {
      ...(tool.startLine === undefined ? {} : { startLine: tool.startLine }),
      ...(tool.endLine === undefined ? {} : { endLine: tool.endLine }),
    })
      : tool.name === 'write_file' ? await this.session.tools.writeFile(tool.path, tool.content)
      : tool.name === 'replace_text' ? await this.replaceText(tool.path, tool.oldText, tool.newText)
      : tool.name === 'search' ? await this.session.tools.search(tool.query)
      : tool.name === 'run_tests' ? await this.session.tools.runTests()
      : unreachableTool(tool);
    validateToolResult(result, tool.name);
    const context = this.contextSlice(result.output, dynamicContextChars);
    const contextual = ['read_file', 'search'].includes(tool.name);
    observations.push({
      action: tool.name, ok: result.ok,
      output: contextual && result.ok ? `[retained in additionalContext: ${context.text.length} chars]` : context.text,
    });
    await this.logTool(tool.name, tool, result, context);
    const escapedManifest = tool.name === 'read_file' && manifest.has(tool.path);
    if (result.ok && tool.name === 'read_file') {
      additionalContext.push({ source: 'read_file', target: tool.path, text: context.text });
      manifest.delete(tool.path);
    } else if (result.ok && tool.name === 'search') {
      additionalContext.push({ source: 'search', target: tool.query, text: context.text });
    }
    if (escapedManifest || tool.name === 'search') {
      await this.session.logger.emit('escape', this.session.step, {
        tool: tool.name, target: tool.name === 'read_file' ? tool.path : tool.query,
        in_unselected_manifest: escapedManifest,
      });
    }
    await this.logSnapshot();
    this.session.assertRuntimeBudget();
    return {
      ok: result.ok,
      contextChars: context.text.length,
    };
  }

  private async replaceText(path: string, oldText: string, newText: string): Promise<ToolResult> {
    if (this.session.tools.replaceText) return this.session.tools.replaceText(path, oldText, newText);
    return { ok: false, durationMs: 0, output: 'replace_text is not supported by this tool runtime' };
  }

  private contextSlice(output: string, usedChars: number): { text: string; originalChars: number; truncated: boolean } {
    const maxChars = Math.floor(this.options.maxDynamicContextTokens * (this.options.charsPerToken ?? 4));
    const text = output.slice(0, Math.max(0, maxChars - usedChars));
    return { text, originalChars: output.length, truncated: text.length < output.length };
  }

  private async logSnapshot(): Promise<void> {
    const snapshot = await this.session.tools.snapshot();
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.id !== 'string' || !snapshot.id.trim()) {
      throw new Error('Tool runtime returned an invalid snapshot id');
    }
    await this.session.logger.emit('snapshot', this.session.step, { id: snapshot.id });
  }

  private logTool(
    name: string, args: object,
    result: { ok: boolean; output: string; durationMs: number; exitCode?: number },
    context = this.contextSlice(result.output, 0),
  ): Promise<void> {
    return this.session.logger.emit('tool_call', this.session.step, {
      name, args: boundedToolArgs(name, args), exit_code: result.exitCode, duration_ms: result.durationMs, ok: result.ok,
      output_hash: createHash('sha256').update(result.output).digest('hex'),
      output_chars: result.output.length, context_chars: context.text.length, context_truncated: context.truncated,
    });
  }

  private async finish(outcome: AgentLoopResult['outcome'], termination: AgentLoopResult['termination']): Promise<AgentLoopResult> {
    const result = { outcome, termination, steps: this.session.step, reasoningTokens: this.session.reasoningTokens };
    await this.session.logger.emit('agent_end', this.session.step, {
      visible_outcome: outcome, totals: { steps: result.steps, reasoning_tokens: result.reasoningTokens }, termination_reason: termination,
    });
    return result;
  }
}

function validateRoute(value: unknown, feasible: string[]): asserts value is Awaited<ReturnType<Router['route']>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Router returned an invalid result');
  const route = value as Record<string, unknown>;
  if (typeof route.action !== 'string') throw new Error('Router returned an invalid action');
  if (!['rule', 'decision_model', 'llm', 'fallback'].includes(String(route.source))) {
    throw new Error('Router returned an invalid source');
  }
  if (route.args !== undefined) {
    if (!route.args || typeof route.args !== 'object' || Array.isArray(route.args)) throw new Error('Router returned invalid arguments');
    const args = route.args as Record<string, unknown>;
    if (args.target !== undefined && (typeof args.target !== 'string' || !args.target.trim())) throw new Error('Router returned an invalid target');
    if (args.query !== undefined && (typeof args.query !== 'string' || !args.query.trim())) throw new Error('Router returned an invalid query');
  }
  if (route.probs !== undefined) {
    if (!route.probs || typeof route.probs !== 'object' || Array.isArray(route.probs)) throw new Error('Router returned invalid probabilities');
    const entries = Object.entries(route.probs as Record<string, unknown>);
    if (!entries.length || entries.some(([action, probability]) => !feasible.includes(action)
      || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1)) {
      throw new Error('Router returned invalid probabilities');
    }
    const total = entries.reduce((sum, [, probability]) => sum + (probability as number), 0);
    if (Math.abs(total - 1) > 1e-6) throw new Error('Router probabilities must sum to 1');
  }
}

function boundedToolArgs(name: string, args: object): object {
  const record = args as Record<string, unknown>;
  if (name === 'write_file' && typeof record.content === 'string') return {
    name, path: record.path, content_hash: createHash('sha256').update(record.content).digest('hex'), content_chars: record.content.length,
  };
  if (name === 'replace_text' && typeof record.oldText === 'string' && typeof record.newText === 'string') return {
    name, path: record.path,
    old_text_hash: createHash('sha256').update(record.oldText).digest('hex'), old_text_chars: record.oldText.length,
    new_text_hash: createHash('sha256').update(record.newText).digest('hex'), new_text_chars: record.newText.length,
  };
  return args;
}

function validateToolResult(value: ToolResult, tool: string): void {
  if (!value || typeof value !== 'object') throw new Error(`Tool '${tool}' returned an invalid result`);
  if (typeof value.ok !== 'boolean') throw new Error(`Tool '${tool}' returned invalid ok status`);
  if (typeof value.output !== 'string') throw new Error(`Tool '${tool}' returned invalid output`);
  if (!Number.isFinite(value.durationMs) || value.durationMs < 0) throw new Error(`Tool '${tool}' returned invalid duration`);
  if (value.exitCode !== undefined && !Number.isInteger(value.exitCode)) throw new Error(`Tool '${tool}' returned invalid exit code`);
}

function validateAgentDecision(value: AgentDecision): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Reasoner returned an invalid decision');
  if (value.thought !== undefined && typeof value.thought !== 'string') throw new Error('Reasoner returned an invalid thought');
  if (value.done !== undefined && typeof value.done !== 'boolean') throw new Error('Reasoner returned an invalid done flag');
  if (!value.usage || !Number.isInteger(value.usage.inputTokens) || value.usage.inputTokens < 0
    || !Number.isInteger(value.usage.outputTokens) || value.usage.outputTokens < 0) {
    throw new Error('Reasoner returned invalid token usage');
  }
  const tool = value.tool;
  if (tool === undefined) return;
  if (!tool || typeof tool !== 'object' || !['read_file', 'write_file', 'replace_text', 'search', 'run_tests'].includes(tool.name)) {
    throw new Error('Reasoner returned an unknown or invalid tool');
  }
  if (tool.name === 'read_file') {
    if (typeof tool.path !== 'string' || !tool.path.trim()) throw new Error('Reasoner returned an invalid read path');
    for (const [name, value] of [['startLine', tool.startLine], ['endLine', tool.endLine]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`Reasoner returned an invalid ${name}`);
    }
    if (tool.startLine !== undefined && tool.endLine !== undefined && tool.endLine < tool.startLine) {
      throw new Error('Reasoner returned an invalid line range');
    }
  }
  if (tool.name === 'write_file' && (typeof tool.path !== 'string' || !tool.path.trim() || typeof tool.content !== 'string')) {
    throw new Error('Reasoner returned an invalid write request');
  }
  if (tool.name === 'replace_text' && (typeof tool.path !== 'string' || !tool.path.trim()
    || typeof tool.oldText !== 'string' || !tool.oldText.length || typeof tool.newText !== 'string')) {
    throw new Error('Reasoner returned an invalid replacement request');
  }
  if (tool.name === 'search' && (typeof tool.query !== 'string' || !tool.query.trim())) throw new Error('Reasoner returned an invalid search query');
}

function unreachableTool(value: never): never {
  throw new Error(`Reasoner returned unknown tool '${String((value as { name?: unknown }).name)}'`);
}

const defaultPlanner: ActionPlanner = {
  async retrievalQuery(input) { return input.task; },
  async readTarget(input) { return input.unselectedManifest[0]; },
};
