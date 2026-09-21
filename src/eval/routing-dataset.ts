import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunEvent } from '../core/events.js';
import { groupAndValidateRunEvents } from '../core/event-validation.js';
import type { SnapshotEvaluator } from '../core/plugins.js';
import type { AgentAction, RouterState } from '../core/types.js';
import type { LabeledRoutingState } from './routing-replay.js';
import type { EvaluationTask } from './tasks.js';
import { validateTaskEvaluationResult } from './execution-evidence.js';

export interface RoutingDatasetOptions {
  eventsPath: string;
  outputPath?: string;
  tasks: EvaluationTask[];
  snapshots?: SnapshotEvaluator;
}

/** Builds offline routing cases without feeding gold files or hidden-test results to the live run. */
export async function buildRoutingDataset(options: RoutingDatasetOptions): Promise<LabeledRoutingState[]> {
  const events = (await readFile(options.eventsPath, 'utf8')).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
  const tasks = new Map(options.tasks.map((task) => [task.id, task]));
  const groups = groupAndValidateRunEvents(events);
  const cases: LabeledRoutingState[] = [];
  const snapshotCache = new Map<string, boolean>();

  for (const [runId, runEvents] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (!runEvents.some(({ type }) => type === 'route')) continue;
    const task = tasks.get(runEvents[0]!.task_id);
    if (!task) throw new Error(`No task metadata for run '${runId}'`);
    const candidatePaths = candidatePathMap(runEvents);
    const loaded = selectedPaths(runEvents, candidatePaths);
    let latestSnapshot: string | undefined;
    let routeIndex = 0;
    for (const event of runEvents) {
      if (event.type === 'snapshot') {
        const id = event.payload.id;
        if (typeof id !== 'string' || !id.trim()) throw new Error(`Run '${runId}' has an invalid snapshot id`);
        latestSnapshot = id;
        continue;
      }
      if (event.type === 'tool_call' && event.payload.name === 'read_file' && event.payload.ok === true) {
        const args = event.payload.args;
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || typeof (args as Record<string, unknown>).path !== 'string'
          || !(args as Record<string, string>).path) {
          throw new Error(`Run '${runId}' has a successful read_file event without a valid path`);
        }
        const path = (args as Record<string, unknown>).path as string;
        loaded.add(path);
        continue;
      }
      if (event.type !== 'route') continue;
      if (options.snapshots && !latestSnapshot) throw new Error(`Run '${runId}' route has no preceding snapshot`);
      const state = parseRouterState(event.payload.state);
      const feasible = parseFeasible(event.payload.feasible);
      const usefulFiles = new Set([...task.goldFiles, ...goldReadFiles(task)]);
      const labels: LabeledRoutingState['labels'] = {
        needsRetrieval: task.goldFiles.some((path) => !loaded.has(path)),
        validReadTargets: [...usefulFiles].sort(),
      };
      if (latestSnapshot && options.snapshots) {
        const cacheKey = `${task.id}\0${runId}\0${latestSnapshot}`;
        let passed = snapshotCache.get(cacheKey);
        if (passed === undefined) {
          const evaluation = await options.snapshots.evaluate({ task, runId, snapshotId: latestSnapshot });
          validateTaskEvaluationResult(evaluation, 'Snapshot evaluator');
          passed = evaluation.passed;
          snapshotCache.set(cacheKey, passed);
        }
        labels.shouldStop = passed;
      }
      cases.push({
        id: `${runId}:${routeIndex++}`, state, feasible,
        candidatePaths: Object.fromEntries([...candidatePaths].sort(([a], [b]) => a.localeCompare(b))), labels,
      });
    }
  }
  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, cases.map((item) => JSON.stringify(item)).join('\n') + (cases.length ? '\n' : ''));
  }
  return cases;
}

function candidatePathMap(events: RunEvent[]): Map<string, string> {
  const candidateEvents = events.filter(({ type }) => type === 'candidates');
  if (candidateEvents.length !== 1) throw new Error('Routing run requires exactly one candidates event');
  const candidates = candidateEvents[0]!.payload.candidates;
  if (!Array.isArray(candidates)) throw new Error('Candidates event has invalid candidates');
  const result = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Candidates event has an invalid candidate');
    const value = candidate as Record<string, unknown>;
    if (typeof value.id !== 'string' || !value.id || typeof value.path !== 'string' || !value.path) {
      throw new Error('Candidates event has an invalid candidate');
    }
    if (result.has(value.id)) throw new Error(`Candidates event has duplicate id '${value.id}'`);
    result.set(value.id, value.path);
  }
  return result;
}

function selectedPaths(events: RunEvent[], paths: Map<string, string>): Set<string> {
  const selectionEvents = events.filter(({ type }) => type === 'selection');
  if (selectionEvents.length !== 1) throw new Error('Routing run requires exactly one selection event');
  const selected = selectionEvents[0]!.payload.selected;
  if (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string')) {
    throw new Error('Selection event has invalid selected ids');
  }
  if (new Set(selected).size !== selected.length) throw new Error('Selection event has duplicate selected ids');
  for (const id of selected) if (!paths.has(id)) throw new Error(`Selection event selected unknown candidate '${id}'`);
  return new Set(selected.map((id) => paths.get(id as string)!));
}

function parseRouterState(value: unknown): RouterState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Route event is missing state');
  const state = value as Partial<RouterState>;
  const actions: AgentAction[] = ['reason', 'retrieve_context', 'read_file', 'run_tests', 'stop'];
  if (typeof state.task !== 'string'
    || !['start', 'context_loaded', 'post_edit', 'post_test'].includes(String(state.phase))
    || !['none', 'few', 'many'].includes(String(state.loaded))
    || !['none', 'some'].includes(String(state.unloadedCandidates))
    || !state.tests || !['never', 'passed', 'failed'].includes(String(state.tests.lastRun))
    || typeof state.tests.dirtySinceLastRun !== 'boolean'
    || (state.completionPolicy !== undefined && !['visible_tests', 'submission'].includes(state.completionPolicy))
    || (state.hasSuccessfulEdit !== undefined && typeof state.hasSuccessfulEdit !== 'boolean')
    || !Array.isArray(state.lastActions) || state.lastActions.length > 3
    || state.lastActions.some((action) => !actions.includes(action))) {
    throw new Error('Route event has invalid state');
  }
  return state as RouterState;
}
function parseFeasible(value: unknown): AgentAction[] {
  const actions: AgentAction[] = ['reason', 'retrieve_context', 'read_file', 'run_tests', 'stop'];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !actions.includes(item as AgentAction))
    || new Set(value).size !== value.length) {
    throw new Error('Route event has invalid feasible actions');
  }
  return value as AgentAction[];
}
function goldReadFiles(task: EvaluationTask): string[] {
  const value = task.gold?.readFiles;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
