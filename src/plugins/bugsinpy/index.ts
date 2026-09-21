import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { HarnessPlugin } from '../../core/plugins.js';
import type { EvaluationTask } from '../../eval/tasks.js';
import { TypeSafeSystemOneProvider } from '../../decisions/providers/typesafe-system-one.js';
import { DecisionModelSelector, type DecisionSelectionKind } from '../../selection/decision-model.js';
import { ReasoningModelSelector } from '../../selection/reasoning-model.js';
import { reasoningProviderFromConfig } from '../reasoning-provider.js';
import { createDockerGitPlugin, runProcess, type ProcessRunner } from '../docker-git/index.js';

interface BugSpec { id: number; test?: string[] }
interface ProjectSpec { name: string; bugs: BugSpec[] }
interface BugsInPyConfig {
  benchmarkDirectory: string;
  benchmarkRevision?: string;
  cacheDirectory: string;
  workspaceDirectory: string;
  snapshotDirectory: string;
  image: string;
  cpus: number;
  memory: string;
  pidsLimit: number;
  maxOutputBytes: number;
  timeoutMs: number;
  projects: ProjectSpec[];
}

interface BugMetadata {
  pythonVersion: string;
  buggyCommit: string;
  fixedCommit: string;
  testFiles: string[];
}

/**
 * Imports BugsInPy's public metadata as visible-test T-fix tasks. Execution and
 * qualification are delegated to the hardened Docker/Git adapter.
 */
export function createBugsInPyPlugin(runner: ProcessRunner = runProcess): HarnessPlugin {
  const docker = createDockerGitPlugin(runner);
  return {
    ...docker,
    name: 'bugsinpy',
    selectors: {
      kinds: () => [...(docker.selectors?.kinds() ?? []), 'llm-listwise', 'system-one-choice', 'system-one-noul', 'system-one-combined'],
      create(kind, input) {
        const local = docker.selectors?.create(kind, input);
        if (local) return local;
        if (kind === 'llm-listwise') {
          const inline = process.env.LLM_SELECTION_PROVIDER_CONFIG;
          const path = process.env.LLM_SELECTION_PROVIDER_CONFIG_PATH;
          if (inline && path) throw new Error('Set only one of LLM_SELECTION_PROVIDER_CONFIG or LLM_SELECTION_PROVIDER_CONFIG_PATH');
          if (!inline && !path) throw new Error("Selector 'llm-listwise' requires LLM_SELECTION_PROVIDER_CONFIG_PATH or LLM_SELECTION_PROVIDER_CONFIG");
          let config: unknown;
          try { config = JSON.parse(path ? readFileSync(path, 'utf8') : inline!); }
          catch { throw new Error(`${path ? 'LLM_SELECTION_PROVIDER_CONFIG_PATH' : 'LLM_SELECTION_PROVIDER_CONFIG'} must contain valid JSON`); }
          const provider = reasoningProviderFromConfig(config);
          return new ReasoningModelSelector(provider.model, {
            k: positiveIntegerEnvironment('LLM_SELECTION_K', 1),
            maxOutputTokens: provider.maxOutputTokens,
            maxDecodeRetries: provider.maxDecodeRetries,
            ...(input.sanitizeSummaries === undefined ? {} : { sanitizeSummaries: input.sanitizeSummaries }),
          });
        }
        const decisionKind: DecisionSelectionKind | undefined = kind === 'system-one-choice' ? 'choice'
          : kind === 'system-one-noul' ? 'noul' : kind === 'system-one-combined' ? 'choice+noul' : undefined;
        if (!decisionKind) return undefined;
        const apiKey = process.env.TYPESAFE_API_KEY;
        if (!apiKey) throw new Error(`Selector '${kind}' requires TYPESAFE_API_KEY`);
        const model = new TypeSafeSystemOneProvider({
          apiKey,
          model: process.env.TYPESAFE_SYSTEM_ONE_MODEL ?? 'jev-1.13.0',
          cacheDir: process.env.TYPESAFE_CACHE_DIR ?? '.cache/decisions/typesafe-system-one',
          logPath: process.env.TYPESAFE_SELECTION_LOG ?? 'runs/system-one-selection-calls.jsonl',
        });
        const k = positiveIntegerEnvironment('TYPESAFE_SELECTION_K', 1);
        const cache = process.env.TYPESAFE_SELECTION_CACHE === 'bypass' ? 'bypass' as const : 'use' as const;
        return new DecisionModelSelector(model, {
          kind: decisionKind, k, tauEdit: 0.5, tauRead: 0.7, cache,
          ...(input.sanitizeSummaries === undefined ? {} : { sanitizeSummaries: input.sanitizeSummaries }),
        });
      },
    },
    taskSource: {
      async mine(location, options) {
        const config = parseConfig(JSON.parse(await readFile(location, 'utf8')));
        if (config.benchmarkRevision) {
          const actual = (await simpleGit(config.benchmarkDirectory).revparse(['HEAD'])).trim();
          if (actual !== config.benchmarkRevision) {
            throw new Error(`BugsInPy revision mismatch: expected ${config.benchmarkRevision}, received ${actual}`);
          }
        }
        const requested = config.projects.flatMap((project) => project.bugs.map((bug) => ({ project, bug })))
          .sort((left, right) => left.project.name.localeCompare(right.project.name) || left.bug.id - right.bug.id)
          .slice(0, options?.limit ?? Number.POSITIVE_INFINITY);
        const tasks: EvaluationTask[] = [];
        for (const { project, bug } of requested) tasks.push(await importBug(config, project, bug, runner));
        return tasks;
      },
    },
  };
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function importBug(
  config: BugsInPyConfig, project: ProjectSpec, bug: BugSpec, runner: ProcessRunner,
): Promise<EvaluationTask> {
  const projectDirectory = join(config.benchmarkDirectory, 'projects', project.name);
  const bugDirectory = join(projectDirectory, 'bugs', String(bug.id));
  const metadata = parseBugInfo(await readFile(join(bugDirectory, 'bug.info'), 'utf8'));
  const repositoryUrl = parseAssignment(await readFile(join(projectDirectory, 'project.info'), 'utf8'), 'github_url');
  const repository = join(config.cacheDirectory, 'repositories', `${safeName(project.name)}.git`);
  await mkdir(dirname(repository), { recursive: true });
  if (!await gitObjectExists(repository, 'HEAD')) {
    requireSuccess('BugsInPy repository clone')(await runner('git', ['clone', '--bare', repositoryUrl, repository], {
      timeoutMs: 30 * 60_000, maxOutputBytes: config.maxOutputBytes,
    }));
  }
  await ensureCommit(repository, metadata.buggyCommit, runner, config.maxOutputBytes);
  await ensureCommit(repository, metadata.fixedCommit, runner, config.maxOutputBytes);

  const recordedPatch = await readFile(join(bugDirectory, 'bug_patch.txt'), 'utf8');
  // Some BugsInPy bug_patch.txt records contain the newly added regression test as
  // well as the production fix. Keep visible tests out of both localization gold
  // and the source patch so workspace acquisition does not apply them twice.
  const goldFiles = patchPaths(recordedPatch).filter((path) => !isTestPath(path));
  if (!goldFiles.length) throw new Error(`BugsInPy task '${project.name}-${bug.id}' has no non-test source files in bug_patch.txt`);
  const sourcePatch = await simpleGit().raw([
    '--git-dir', repository, 'diff', '--binary', metadata.buggyCommit, metadata.fixedCommit, '--', ...goldFiles,
  ]);
  if (!sourcePatch.trim()) throw new Error(`BugsInPy task '${project.name}-${bug.id}' has no source patch after excluding tests`);
  const changedPaths = (await simpleGit().raw([
    '--git-dir', repository, 'diff', '--name-only', metadata.buggyCommit, metadata.fixedCommit, '--',
  ])).split('\n').map((path) => path.trim()).filter(Boolean);
  const testFiles = [...new Set([...metadata.testFiles, ...changedPaths.filter(isTestPath)])];
  const testPatch = await simpleGit().raw([
    '--git-dir', repository, 'diff', '--binary', metadata.buggyCommit, metadata.fixedCommit, '--', ...testFiles,
  ]);
  if (!testPatch.trim()) throw new Error(`BugsInPy task '${project.name}-${bug.id}' has no visible test patch`);
  const test = bug.test ?? parseTestCommand(await readFile(join(bugDirectory, 'run_test.sh'), 'utf8'));
  if (!test.length) throw new Error(`BugsInPy task '${project.name}-${bug.id}' has no visible test command`);
  const command = { command: test[0]!, args: test.slice(1), timeoutMs: config.timeoutMs };
  return {
    id: `bugsinpy-${project.name}-${bug.id}`,
    type: 'T-fix',
    task: `Fix the bug exposed by this visible test: ${test.join(' ')}`,
    goldFiles,
    testFiles,
    source: { kind: 'docker-git', data: {
      repository, baseRef: metadata.buggyCommit, fixRef: metadata.fixedCommit,
      image: config.image, cpus: config.cpus, memory: config.memory, pidsLimit: config.pidsLimit,
      maxOutputBytes: config.maxOutputBytes, visibleTest: command, authoritativeTest: command,
      snapshotDirectory: config.snapshotDirectory, workspaceDirectory: config.workspaceDirectory,
    } },
    gold: { sourcePatch, testPatch },
    reporting: {
      benchmark: 'BugsInPy', repository: project.name, language: 'python', pythonVersion: metadata.pythonVersion,
    },
  };
}

function parseBugInfo(content: string): BugMetadata {
  const testFiles = parseAssignment(content, 'test_file').split(';').map((value) => value.trim()).filter(Boolean);
  if (!testFiles.length || testFiles.some((path) => path.startsWith('/') || path.split('/').includes('..'))) {
    throw new Error('BugsInPy test_file must contain safe relative paths');
  }
  const buggyCommit = parseCommit(parseAssignment(content, 'buggy_commit_id'), 'buggy_commit_id');
  const fixedCommit = parseCommit(parseAssignment(content, 'fixed_commit_id'), 'fixed_commit_id');
  return { pythonVersion: parseAssignment(content, 'python_version'), buggyCommit, fixedCommit, testFiles };
}

function parseAssignment(content: string, key: string): string {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm').exec(content);
  if (!match) throw new Error(`BugsInPy metadata requires ${key}`);
  return match[1]!;
}

/** Parses only plain argv lines. Shell operators and expansion are deliberately unsupported. */
export function parseTestCommand(content: string): string[] {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (lines.length !== 1) throw new Error('BugsInPy run_test.sh must contain exactly one command or use a config override');
  const line = lines[0]!;
  if (/[;&|`$<>\\]/.test(line)) throw new Error('BugsInPy test command contains unsupported shell syntax');
  const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => {
    const quoted = (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"));
    return quoted ? token.slice(1, -1) : token;
  }) ?? [];
  if (!tokens.length) throw new Error('BugsInPy test command is empty');
  return tokens;
}

function patchPaths(patch: string): string[] {
  return [...new Set([...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]!))];
}
function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.split('/').some((part) => part === 'test' || part === 'tests')
    || /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(lower);
}

async function ensureCommit(repository: string, commit: string, runner: ProcessRunner, maxOutputBytes: number): Promise<void> {
  if (await gitObjectExists(repository, `${commit}^{commit}`)) return;
  requireSuccess('BugsInPy commit fetch')(await runner('git', ['--git-dir', repository, 'fetch', '--depth', '1', 'origin', commit], {
    timeoutMs: 10 * 60_000, maxOutputBytes,
  }));
}

async function gitObjectExists(repository: string, object: string): Promise<boolean> {
  try { await simpleGit().raw(['--git-dir', repository, 'cat-file', '-e', object]); return true; }
  catch { return false; }
}

function requireSuccess(name: string): (result: { exitCode: number; output: string }) => void {
  return (result) => { if (result.exitCode !== 0) throw new Error(`${name} failed (${result.exitCode}): ${result.output.slice(-1000)}`); };
}

function parseConfig(value: unknown): BugsInPyConfig {
  const record = object(value, 'BugsInPy config');
  const benchmarkDirectory = resolve(text(record.benchmarkDirectory, 'benchmarkDirectory'));
  const cacheDirectory = resolve(text(record.cacheDirectory ?? '.cache/bugsinpy', 'cacheDirectory'));
  const workspaceDirectory = resolve(text(record.workspaceDirectory ?? '.cache/bugsinpy/worktrees', 'workspaceDirectory'));
  const snapshotDirectory = resolve(text(record.snapshotDirectory ?? 'runs/bugsinpy-snapshots', 'snapshotDirectory'));
  const projectsValue = record.projects;
  if (!Array.isArray(projectsValue) || !projectsValue.length) throw new Error('projects must be a non-empty array');
  const projects = projectsValue.map((value, index): ProjectSpec => {
    const item = object(value, `projects[${index}]`); const bugsValue = item.bugs;
    if (!Array.isArray(bugsValue) || !bugsValue.length) throw new Error(`projects[${index}].bugs must be non-empty`);
    return { name: text(item.name, `projects[${index}].name`), bugs: bugsValue.map((entry, bugIndex) => {
      if (typeof entry === 'number') return { id: positiveInteger(entry, `projects[${index}].bugs[${bugIndex}]`) };
      const bug = object(entry, `projects[${index}].bugs[${bugIndex}]`);
      const test = bug.test;
      if (test !== undefined && (!Array.isArray(test) || !test.length || test.some((arg) => typeof arg !== 'string' || !arg))) {
        throw new Error(`projects[${index}].bugs[${bugIndex}].test must be a non-empty string array`);
      }
      return { id: positiveInteger(bug.id, `projects[${index}].bugs[${bugIndex}].id`), ...(test ? { test: test as string[] } : {}) };
    }) };
  });
  const benchmarkRevision = record.benchmarkRevision === undefined
    ? undefined : parseCommit(text(record.benchmarkRevision, 'benchmarkRevision'), 'benchmarkRevision');
  return {
    benchmarkDirectory, ...(benchmarkRevision ? { benchmarkRevision } : {}), cacheDirectory, workspaceDirectory, snapshotDirectory,
    image: text(record.image, 'image'), cpus: positive(record.cpus ?? 2, 'cpus'),
    memory: text(record.memory ?? '4g', 'memory'), pidsLimit: positiveInteger(record.pidsLimit ?? 256, 'pidsLimit'),
    maxOutputBytes: positiveInteger(record.maxOutputBytes ?? 1_000_000, 'maxOutputBytes'),
    timeoutMs: positiveInteger(record.timeoutMs ?? 120_000, 'timeoutMs'), projects,
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value;
}
function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`); return value;
}
function positiveInteger(value: unknown, name: string): number {
  const parsed = positive(value, name); if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`); return parsed;
}
function parseCommit(value: string, name: string): string {
  if (!/^[a-f0-9]{7,40}$/.test(value)) throw new Error(`${name} must be a Git commit id`); return value;
}
function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9_.-]/g, '_'); }

const plugin = createBugsInPyPlugin();
export default plugin;
