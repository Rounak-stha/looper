#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SpendLedger } from '../core/ledger.js';
import { JsonlEventSink } from '../core/logger.js';
import { createRunManifest } from '../core/manifest.js';
import { loadHarnessPlugin } from '../core/plugin-loader.js';
import type { HarnessPlugin } from '../core/plugins.js';
import { TypeSafeSystemOneProvider } from '../decisions/providers/typesafe-system-one.js';
import { parseAgentExperimentConfig } from '../eval/agent-config.js';
import { planOnlineBudget } from '../eval/budget-plan.js';
import { runCoreCharacterization, runSmoke } from '../eval/characterize-system-one.js';
import { characterizeRealSelection } from '../eval/characterize-real-selection.js';
import { runAgentExperiment, SpendLedgerAdmission } from '../eval/experiment-runner.js';
import { calibrationReportFromFile, evaluateGateManifest } from '../eval/evidence-report.js';
import { analyzeModelHeadroom, tierObservationsFromRuns } from '../eval/model-headroom.js';
import { evaluateOfflineSelection } from '../eval/offline-selection.js';
import { aggregateRuns, compareRuns, pairedPassRateInterval, summarizeRunLog } from '../eval/report.js';
import { buildRoutingDataset } from '../eval/routing-dataset.js';
import { evaluateRoutingReplayFile } from '../eval/routing-replay-io.js';
import { compareSelectionRecords, loadSelectionLog, summarizeSelectionLog } from '../eval/selection-report.js';
import { evaluateSelectionSweep, parseSelectionSweepConfig } from '../eval/selection-sweep.js';
import { validateTasks } from '../eval/task-validation.js';
import { qualifyMinedTasks } from '../eval/task-qualification.js';
import { parseTaskDataset, type AgentTask } from '../eval/tasks.js';
import { defaultPlugin } from '../plugins/default/index.js';
import { OracleSelector } from '../selection/oracle.js';
import { writeTaskSplits } from '../tasks/io.js';
import { splitTasks } from '../tasks/split.js';

// Local credentials remain outside configuration and source control. Existing shell values win.
try { process.loadEnvFile?.('.env'); } catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}

function usage(exitCode = 2): never {
  const message = 'Usage:\n  npm run cli -- characterize <smoke|core>\n  npm run cli -- characterize real-selection <tasks.jsonl> [output.json]\n  npm run cli -- tasks mine <source> [limit]\n  npm run cli -- tasks qualify <source> [limit]\n  npm run cli -- tasks validate <tasks.jsonl> [output.jsonl]\n  npm run cli -- eval selection <tasks.jsonl> <selector>\n  npm run cli -- eval selection-sweep <tasks.jsonl> <config.json>\n  npm run cli -- eval agent <tasks.jsonl> <config.json>\n  npm run cli -- replay build <events.jsonl> <tasks.jsonl>\n  npm run cli -- replay evaluate <cases.jsonl> <router>\n  npm run cli -- report selection <selection.jsonl>\n  npm run cli -- report selection-compare <baseline.jsonl> <arm.jsonl>\n  npm run cli -- report summary <events.jsonl>\n  npm run cli -- report compare <baseline.jsonl> <arm.jsonl>\n  npm run cli -- report headroom <events.jsonl> <cheap,mid,strong>\n  npm run cli -- report gate <manifest.json>\n  npm run cli -- report calibration <observations.jsonl>';
  (exitCode === 0 ? console.log : console.error)(message);
  process.exit(exitCode);
}

async function configuredPlugin(): Promise<HarnessPlugin> {
  return process.env.HARNESS_PLUGIN ? loadHarnessPlugin(process.env.HARNESS_PLUGIN) : defaultPlugin;
}

function positiveEnvironment(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function decisionModelFromEnvironment(): TypeSafeSystemOneProvider {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('Set TYPESAFE_API_KEY before running live characterization');
  return new TypeSafeSystemOneProvider({
    apiKey,
    model: process.env.TYPESAFE_SYSTEM_ONE_MODEL ?? 'jev-1.13.0',
    logPath: 'runs/characterize.jsonl',
  });
}

const [, , command, subcommand, argument, limitArgument] = process.argv;
if (command === 'help' || command === '--help' || command === '-h') usage(0);
if (command === 'characterize' && subcommand === 'real-selection' && argument) {
  const plugin = await configuredPlugin();
  const selectorId = process.env.REAL_SELECTION_SELECTOR ?? 'system-one-choice';
  const candidateLimit = positiveEnvironment('REAL_SELECTION_CANDIDATES', 60);
  const poolCandidates = positiveEnvironment('REAL_SELECTION_POOL_CANDIDATES', candidateLimit);
  const maxItems = positiveEnvironment('REAL_SELECTION_MAX_ITEMS', 5);
  const candidateKinds = process.env.REAL_SELECTION_CANDIDATE_KINDS?.split(',').map((kind) => kind.trim()).filter(Boolean);
  console.log(JSON.stringify(await characterizeRealSelection({
    tasksPath: argument, outputPath: limitArgument ?? 'runs/real-selection-characterization.jsonl',
    selectorId, candidateLimit, poolCandidates, maxItems, repetitions: positiveEnvironment('REAL_SELECTION_REPETITIONS', 3),
    shuffles: positiveEnvironment('REAL_SELECTION_SHUFFLES', 3), seed: positiveEnvironment('REAL_SELECTION_SEED', 7),
    ...(candidateKinds ? { candidateKinds: candidateKinds as Array<'file' | 'symbol' | 'test' | 'git_change'> } : {}),
    selectorFor(task, sanitizeSummaries) {
      const selector = plugin.selectors?.create(selectorId, { task, sanitizeSummaries });
      if (!selector) throw new Error(`Plugin ${plugin.name} does not provide selector '${selectorId}'`);
      return selector;
    },
    workspaces: plugin.workspaces, context: plugin.context,
  }), null, 2));
} else if (command === 'tasks' && subcommand === 'mine' && argument) {
  const limit = limitArgument ? Number(limitArgument) : 100;
  const plugin = await configuredPlugin();
  if (!plugin.taskSource) throw new Error(`Plugin ${plugin.name} does not provide taskSource`);
  const tasks = splitTasks(await plugin.taskSource.mine(argument, { limit }));
  await writeTaskSplits(tasks, 'tasks/dev.jsonl', 'tasks/test.jsonl');
  console.log(JSON.stringify({ mined: tasks.length, dev: tasks.filter(({ split }) => split === 'dev').length, test: tasks.filter(({ split }) => split === 'test').length }, null, 2));
} else if (command === 'tasks' && subcommand === 'qualify' && argument) {
  const limit = limitArgument ? Number(limitArgument) : 100;
  const plugin = await configuredPlugin();
  if (!plugin.taskSource || !plugin.validator) {
    throw new Error(`Plugin ${plugin.name} must provide taskSource and task validation`);
  }
  const outputDirectory = process.env.HARNESS_TASK_OUTPUT_DIR ?? 'tasks';
  console.log(JSON.stringify(await qualifyMinedTasks({
    source: plugin.taskSource, validator: plugin.validator, location: argument, limit,
    candidatesPath: join(outputDirectory, 'candidates.jsonl'), validPath: join(outputDirectory, 'validated.jsonl'),
    devPath: join(outputDirectory, 'dev.jsonl'), testPath: join(outputDirectory, 'test.jsonl'),
    resultsPath: process.env.HARNESS_TASK_VALIDATION_LOG ?? 'runs/task-validation.jsonl',
  }), null, 2));
} else if (command === 'tasks' && subcommand === 'validate' && argument) {
  const plugin = await configuredPlugin();
  if (!plugin.validator) throw new Error(`Plugin ${plugin.name} does not provide task validation`);
  const output = limitArgument ?? 'tasks/validated.jsonl';
  console.log(JSON.stringify(await validateTasks({
    inputPath: argument, validPath: output, resultsPath: 'runs/task-validation.jsonl', validator: plugin.validator,
  }), null, 2));
} else if (command === 'eval' && subcommand === 'selection' && argument && limitArgument) {
  const selectorId = limitArgument;
  const plugin = await configuredPlugin();
  const taskGold = new Map(parseTaskDataset(await readFile(argument, 'utf8'))
    .map((task) => [task.id, task.goldFiles]));
  const selectorFor = (task: AgentTask) => {
    if (selectorId === 'oracle') return new OracleSelector(new Set(taskGold.get(task.id) ?? []));
    const selector = plugin.selectors?.create(selectorId, { task });
    if (!selector) throw new Error(`Plugin ${plugin.name} does not provide selector '${selectorId}'`);
    return selector;
  };
  const summary = await evaluateOfflineSelection({
    tasksPath: argument, selectorId, selectorFor, outputPath: `runs/e1a-${selectorId}.jsonl`,
    candidates: 60, maxItems: 10, maxTokens: 30_000,
    workspaces: plugin.workspaces, context: plugin.context,
  });
  console.log(JSON.stringify(summary, null, 2));
} else if (command === 'eval' && subcommand === 'selection-sweep' && argument && limitArgument) {
  const plugin = await configuredPlugin();
  const arms = parseSelectionSweepConfig(JSON.parse(await readFile(limitArgument, 'utf8')) as unknown);
  const taskGold = new Map(parseTaskDataset(await readFile(argument, 'utf8'))
    .map((task) => [task.id, task.goldFiles]));
  const selectorFor = (selectorId: string, task: AgentTask) => {
    if (selectorId === 'oracle') return new OracleSelector(new Set(taskGold.get(task.id) ?? []));
    const selector = plugin.selectors?.create(selectorId, { task });
    if (!selector) throw new Error(`Plugin ${plugin.name} does not provide selector '${selectorId}'`);
    return selector;
  };
  console.log(JSON.stringify(await evaluateSelectionSweep({
    tasksPath: argument, outputPath: 'runs/e1a-sweep.jsonl', arms, selectorFor,
    workspaces: plugin.workspaces, context: plugin.context,
  }), null, 2));
} else if (command === 'eval' && subcommand === 'agent' && argument && limitArgument) {
  const plugin = await configuredPlugin();
  if (!plugin.tools || !plugin.evaluator || !plugin.agent) {
    throw new Error(`Plugin ${plugin.name} must provide tools, evaluator, and agent capabilities`);
  }
  const rawConfig = JSON.parse(await readFile(limitArgument, 'utf8')) as unknown;
  const config = parseAgentExperimentConfig(rawConfig);
  const tasks = parseTaskDataset(await readFile(argument, 'utf8'));
  const ledger = new SpendLedger(config.budget?.ledgerPath ?? 'runs/unpriced-usage-ledger.jsonl', config.budget?.capUsd);
  const budgetPlan = config.budget === undefined ? undefined : planOnlineBudget({
    tasks: tasks.length, runsPerTask: config.runsPerTask, arms: 1,
    p90CostPerRunUsd: config.estimatedCostPerRunUsd ?? 0,
    capUsd: config.budget.capUsd, spentUsd: await ledger.spent(), reservePct: config.budget.reservePct,
    ...(config.budget.minimumTasks === undefined ? {} : { minimumTasks: config.budget.minimumTasks }),
  });
  if (budgetPlan && !budgetPlan.affordable) throw new Error(`Online experiment rejected: ${budgetPlan.reason}`);
  const manifest = createRunManifest({
    config: rawConfig, datasetVersion: config.datasetVersion,
    modelIds: config.modelIds, decisionModelIds: config.decisionModelIds,
    ...(config.environmentId ? { environmentId: config.environmentId } : {}),
  });
  const taskGold = new Map(tasks.map((task) => [task.id, task.goldFiles]));
  const selectorFor = (task: AgentTask) => {
    if (config.selector === 'oracle') return new OracleSelector(new Set(taskGold.get(task.id) ?? []));
    const selector = plugin.selectors?.create(config.selector, { task });
    if (!selector) throw new Error(`Plugin ${plugin.name} does not provide selector '${config.selector}'`);
    return selector;
  };
  const result = await runAgentExperiment(tasks, {
    workspaces: plugin.workspaces, context: plugin.context, tools: plugin.tools,
    evaluator: plugin.evaluator, selectorFor, events: new JsonlEventSink(config.eventsPath),
    controllerFor: (task, context) => plugin.agent!.create({
      task, ...context, ledger, ...(config.budget?.runCapUsd === undefined ? {} : { runCapUsd: config.budget.runCapUsd }),
      config: rawConfig as Record<string, unknown>,
    }),
  }, {
    configId: config.configId, candidateLimit: config.candidateLimit,
    ...(config.poolCandidates === undefined ? {} : { poolCandidates: config.poolCandidates }),
    ...(config.candidateKinds === undefined ? {} : { candidateKinds: config.candidateKinds }),
    selectionBudget: config.selectionBudget, initialContextMaxTokens: config.initialContextMaxTokens,
    dynamicContextMaxTokens: config.dynamicContextMaxTokens,
    sessionBudgets: config.sessionBudgets,
    manifest, ...(config.reporting ? { reporting: config.reporting } : {}),
    runsPerTask: config.runsPerTask, seed: config.seed,
    ...(config.estimatedCostPerRunUsd === undefined ? {} : { estimatedCostPerRunUsd: config.estimatedCostPerRunUsd }),
    ...(config.budget === undefined ? {} : { admission: new SpendLedgerAdmission((estimate) => ledger.assertCanSpend(estimate)) }),
  });
  console.log(JSON.stringify({ budgetPlan, completed: result.completed.length, errors: result.errors }, null, 2));
  if (result.errors.length) process.exitCode = 1;
} else if (command === 'replay' && subcommand === 'build' && argument && limitArgument) {
  const plugin = await configuredPlugin();
  const tasks = parseTaskDataset(await readFile(limitArgument, 'utf8'));
  const cases = await buildRoutingDataset({
    eventsPath: argument, outputPath: 'runs/routing-cases.jsonl', tasks,
    ...(plugin.snapshots ? { snapshots: plugin.snapshots } : {}),
  });
  console.log(JSON.stringify({ cases: cases.length, stop_labels: cases.filter(({ labels }) => labels.shouldStop !== undefined).length }, null, 2));
} else if (command === 'replay' && subcommand === 'evaluate' && argument && limitArgument) {
  const plugin = await configuredPlugin();
  const config = process.env.REPLAY_CONFIG ? JSON.parse(await readFile(process.env.REPLAY_CONFIG, 'utf8')) as Record<string, unknown> : {};
  const router = await plugin.replayRouters?.create(limitArgument, { config });
  if (!router) throw new Error(`Plugin ${plugin.name} does not provide replay router '${limitArgument}'`);
  console.log(JSON.stringify(await evaluateRoutingReplayFile(argument, router), null, 2));
} else if (command === 'report' && subcommand === 'gate' && argument) {
  console.log(JSON.stringify(await evaluateGateManifest(JSON.parse(await readFile(argument, 'utf8')) as unknown), null, 2));
} else if (command === 'report' && subcommand === 'calibration' && argument) {
  console.log(JSON.stringify(await calibrationReportFromFile(argument), null, 2));
} else if (command === 'report' && subcommand === 'selection' && argument) {
  console.log(JSON.stringify(await summarizeSelectionLog(argument), null, 2));
} else if (command === 'report' && subcommand === 'selection-compare' && argument && limitArgument) {
  const [baseline, arm] = await Promise.all([loadSelectionLog(argument), loadSelectionLog(limitArgument)]);
  console.log(JSON.stringify(compareSelectionRecords(baseline, arm, { requireCompleteCoverage: true }), null, 2));
} else if (command === 'report' && subcommand === 'headroom' && argument && limitArgument) {
  const tiers = limitArgument.split(',').map((id, rank) => ({ id: id.trim(), rank }));
  if (tiers.some(({ id }) => !id)) throw new Error('Tier list contains an empty ID');
  const runs = await summarizeRunLog(argument);
  console.log(JSON.stringify(analyzeModelHeadroom(tierObservationsFromRuns(runs), tiers), null, 2));
} else if (command === 'report' && subcommand === 'summary' && argument) {
  const runs = await summarizeRunLog(argument);
  console.log(JSON.stringify({ aggregate: aggregateRuns(runs), runs }, null, 2));
} else if (command === 'report' && subcommand === 'compare' && argument && limitArgument) {
  const [baseline, arm] = await Promise.all([summarizeRunLog(argument), summarizeRunLog(limitArgument)]);
  console.log(JSON.stringify({
    comparison: compareRuns(baseline, arm, { requireCompleteCoverage: true }),
    pass_rate_difference_ci: pairedPassRateInterval(baseline, arm, { requireCompleteCoverage: true }),
  }, null, 2));
} else if (command === 'characterize' && ['smoke', 'core'].includes(subcommand ?? '')) {
  const decisionModel = decisionModelFromEnvironment();
  if (subcommand === 'smoke') {
    console.log(JSON.stringify(await runSmoke(decisionModel), null, 2));
  } else {
    const records = await runCoreCharacterization(decisionModel, { outputPath: 'runs/characterization-results.jsonl' });
    console.log(JSON.stringify(records, null, 2));
  }
} else usage();
