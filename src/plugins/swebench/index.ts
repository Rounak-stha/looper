import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { simpleGit } from 'simple-git';
import type { HarnessPlugin, TaskEvaluationResult, ToolResult, WorkspaceLease } from '../../core/plugins.js';
import type { EvaluationTask } from '../../eval/tasks.js';
import { NoneSelector } from '../../selection/none.js';
import { FilesystemContextProvider } from '../default/filesystem-context.js';
import { HeuristicSelector } from '../default/heuristic-selector.js';
import { Bm25Selector } from '../default/minisearch-selector.js';
import { RulesRouter } from '../../routing/rules.js';
import { JsonCodingDecisionCodec } from '../../agent/json-codec.js';
import { MeteredCodingReasoner } from '../../agent/reasoning-adapter.js';
import { MeteredReasoningModel } from '../../models/metered.js';
import { reasoningProviderFromConfig } from '../reasoning-provider.js';

const DEFAULT_DATASET = 'SWE-bench/SWE-bench_Verified';
const DEFAULT_SPLIT = 'test';

export interface SWEbenchSourceConfig {
  dataset: string;
  split: string;
  cacheDirectory: string;
  evaluationDirectory: string;
  pythonCommand: string;
  evaluationTimeoutMs: number;
  /** A checked-in JSON/JSONL export can replace Hugging Face for reproducible/offline import. */
  datasetPath?: string;
}

interface SWEbenchRow {
  repo: string;
  instance_id: string;
  base_commit: string;
  patch: string;
  test_patch: string;
  problem_statement: string;
  hints_text?: string;
  created_at?: string;
  version?: string;
  FAIL_TO_PASS: string | string[];
  PASS_TO_PASS: string | string[];
  difficulty?: string;
  image?: string;
}

type SWEbenchLease = WorkspaceLease & { repositoryDirectory: string; baseCommit: string };
export interface ProcessResult { exitCode: number; output: string; durationMs: number }
export type ProcessRunner = (command: string, args: string[], options: {
  cwd?: string; timeoutMs: number; maxOutputBytes: number; env?: NodeJS.ProcessEnv;
}) => Promise<ProcessResult>;

/** Imports official SWE-bench records and delegates final grading to the upstream harness. */
export function createSWEbenchPlugin(runner: ProcessRunner = runProcess): HarnessPlugin {
  return {
    name: 'swebench-official',
    taskSource: {
      async mine(location, options) {
        const config = sourceConfig(JSON.parse(await readFile(location, 'utf8')));
        const rows = config.datasetPath
          ? await rowsFromFile(config.datasetPath)
          : await rowsFromHuggingFace(config.dataset, config.split, options?.limit ?? 100);
        return rows.slice(0, options?.limit ?? rows.length).map((row) => taskFromRow(row, config));
      },
    },
    workspaces: {
      async acquire(task) {
        const source = taskSource(task);
        const repositoryDirectory = join(source.cacheDirectory, 'repositories', ...source.repository.split('/'));
        const worktreeRoot = join(source.cacheDirectory, 'worktrees');
        await mkdir(dirname(repositoryDirectory), { recursive: true });
        if (!await exists(join(repositoryDirectory, 'HEAD'))) {
          await runner('git', ['clone', '--bare', `https://github.com/${source.repository}.git`, repositoryDirectory], {
            timeoutMs: 30 * 60_000, maxOutputBytes: 1_000_000,
          }).then(requireSuccess('Git clone'));
        }
        const repository = simpleGit(repositoryDirectory);
        try { await repository.raw(['cat-file', '-e', `${source.baseCommit}^{commit}`]); }
        catch {
          const fetched = await runner('git', ['--git-dir', repositoryDirectory, 'fetch', '--depth', '1', 'origin', source.baseCommit], {
            timeoutMs: 10 * 60_000, maxOutputBytes: 1_000_000,
          });
          requireSuccess('Git fetch')(fetched);
        }
        await mkdir(worktreeRoot, { recursive: true });
        const destination = join(worktreeRoot, `${safeName(task.id)}-${randomUUID()}`);
        await repository.raw(['worktree', 'add', '--detach', destination, source.baseCommit]);
        return {
          path: destination, repositoryDirectory, baseCommit: source.baseCommit,
          async release() { await repository.raw(['worktree', 'remove', '--force', destination]); },
        } satisfies SWEbenchLease;
      },
    },
    context: { create({ workspacePath }) { return FilesystemContextProvider.create(workspacePath); } },
    selectors: {
      kinds: () => ['none', 'bm25', 'heuristic'],
      create(kind) {
        return kind === 'none' ? new NoneSelector() : kind === 'bm25' ? new Bm25Selector()
          : kind === 'heuristic' ? new HeuristicSelector() : undefined;
      },
    },
    tools: {
      async create({ workspace }) {
        const lease = workspace as SWEbenchLease;
        return {
          async readFile(path) { return timed(async () => readFile(await safeFilesystemPath(lease.path, path, false), 'utf8')); },
          async writeFile(path, content) {
            return timed(async () => {
              const target = await safeFilesystemPath(lease.path, path, true);
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, content, 'utf8');
              return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
            });
          },
          async search(query) {
            return timed(async () => {
              const provider = await FilesystemContextProvider.create(lease.path);
              return (await provider.search(query, { limit: 50 })).map(({ path }) => path).join('\n');
            });
          },
          async runTests() {
            return { ok: false, exitCode: 2, durationMs: 0, output: 'No visible test suite is exposed for T-issue; edit and submit for authoritative evaluation.' };
          },
          async snapshot() { return { id: `sha256:${await workspaceDigest(lease.path)}` }; },
        };
      },
    },
    evaluator: {
      async evaluate({ task, workspace }) {
        return evaluateWithOfficialHarness(task, workspace as SWEbenchLease, runner);
      },
    },
    agent: {
      async create({ config, runId, task, logger, ledger, runCapUsd, currentStep }) {
        const provider = reasoningProviderFromConfig(config.reasoningProvider);
        const metered = new MeteredReasoningModel({
          id: provider.tier, model: provider.model, priceInPerM: provider.priceInPerM, priceOutPerM: provider.priceOutPerM,
        }, ledger, logger);
        return {
          router: new RulesRouter(),
          reasoner: new MeteredCodingReasoner(metered, new JsonCodingDecisionCodec(), {
            current: () => ({ runId, taskId: task.id, step: currentStep(), ...(runCapUsd === undefined ? {} : { runCapUsd }) }),
            estimatedMaxCostUsd: () => provider.estimatedMaxCostUsd,
          }, 'coder', provider.maxDecodeRetries),
        };
      },
    },
  };
}

export function taskFromRow(rowValue: unknown, config: SWEbenchSourceConfig): EvaluationTask {
  const row = parseRow(rowValue);
  const goldFiles = patchPaths(row.patch);
  const tests = testNames(row.FAIL_TO_PASS);
  const testFiles = [...new Set([...patchPaths(row.test_patch), ...tests.map((name) => name.split('::')[0]!).filter(Boolean)])];
  if (!goldFiles.length) throw new Error(`SWE-bench instance '${row.instance_id}' has no source files in patch`);
  if (!testFiles.length) throw new Error(`SWE-bench instance '${row.instance_id}' has no test files`);
  return {
    id: row.instance_id,
    type: 'T-issue',
    task: row.problem_statement,
    goldFiles,
    testFiles,
    source: { kind: 'swebench', data: {
      dataset: config.dataset, split: config.split, repository: row.repo, baseCommit: row.base_commit,
      cacheDirectory: config.cacheDirectory, evaluationDirectory: config.evaluationDirectory,
      pythonCommand: config.pythonCommand, evaluationTimeoutMs: config.evaluationTimeoutMs,
      ...(row.image ? { image: row.image } : {}),
    } },
    gold: {
      sourcePatch: row.patch, testPatch: row.test_patch,
      failToPass: tests, passToPass: testNames(row.PASS_TO_PASS),
    },
    ...(row.created_at ? { createdAt: row.created_at } : {}),
    reporting: {
      benchmark: config.dataset, repository: row.repo, language: 'python',
      ...(row.difficulty ? { difficulty: row.difficulty } : {}),
      ...(row.version ? { version: row.version } : {}),
    },
  };
}

export async function evaluateWithOfficialHarness(
  task: EvaluationTask, workspace: SWEbenchLease, runner: ProcessRunner = runProcess,
): Promise<TaskEvaluationResult> {
  const source = taskSource(task);
  const started = performance.now();
  const temporary = await mkdtemp(join(tmpdir(), 'looper-swebench-eval-'));
  const runId = `looper-${safeName(task.id)}-${randomUUID()}`;
  try {
    const git = simpleGit(workspace.path);
    await git.raw(['add', '--intent-to-add', '--', '.']);
    const modelPatch = await git.raw(['diff', '--binary', '--no-ext-diff', source.baseCommit, '--']);
    const predictions = join(temporary, 'predictions.jsonl');
    await writeFile(predictions, `${JSON.stringify({
      instance_id: task.id, model_name_or_path: 'looper', model_patch: modelPatch,
    })}\n`);
    if (process.arch === 'arm64' && source.image) {
      const pull = await runner('docker', ['pull', '--platform', 'linux/amd64', source.image], {
        timeoutMs: source.evaluationTimeoutMs, maxOutputBytes: 1_000_000,
      });
      requireSuccess('Official SWE-bench image pull')(pull);
    }
    const result = await runner(source.pythonCommand, [
      '-m', 'swebench.harness.run_evaluation', '--dataset_name', source.dataset, '--split', source.split,
      '--instance_ids', task.id, '--predictions_path', predictions, '--max_workers', '1',
      '--run_id', runId, '--timeout', String(Math.ceil(source.evaluationTimeoutMs / 1000)),
    ], {
      cwd: source.evaluationDirectory, timeoutMs: source.evaluationTimeoutMs + 300_000, maxOutputBytes: 2_000_000,
      env: process.arch === 'arm64' ? { ...process.env, DOCKER_DEFAULT_PLATFORM: 'linux/amd64' } : process.env,
    });
    if (result.exitCode !== 0) throw new Error(`Official SWE-bench evaluator failed (${result.exitCode}): ${result.output.slice(-1000)}`);
    const reportPath = join(source.evaluationDirectory, 'logs', 'evaluation', runId, 'results.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    const infra = stringArray(report.infra_failure_ids);
    const errors = stringArray(report.error_ids);
    if (infra.includes(task.id) || errors.includes(task.id)) {
      throw new Error(`Official SWE-bench infrastructure failure for '${task.id}'`);
    }
    const resolved = stringArray(report.resolved_ids).includes(task.id);
    return {
      passed: resolved, exitCode: resolved ? 0 : 1, durationMs: performance.now() - started,
      output: result.output,
      metadata: { evaluator: 'official-swebench', dataset: source.dataset, split: source.split, runId },
    };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function rowsFromFile(path: string): Promise<unknown[]> {
  const content = await readFile(resolve(path), 'utf8');
  const parsed = content.trimStart().startsWith('[') ? JSON.parse(content) : content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (!Array.isArray(parsed)) throw new Error('SWE-bench dataset file must contain a JSON array or JSONL records');
  return parsed;
}

async function rowsFromHuggingFace(dataset: string, split: string, limit: number): Promise<unknown[]> {
  const output: unknown[] = [];
  for (let offset = 0; offset < limit;) {
    const length = Math.min(100, limit - offset);
    const url = new URL('https://datasets-server.huggingface.co/rows');
    url.searchParams.set('dataset', dataset); url.searchParams.set('config', 'default');
    url.searchParams.set('split', split); url.searchParams.set('offset', String(offset)); url.searchParams.set('length', String(length));
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Hugging Face dataset request failed (${response.status})`);
    const body = await response.json() as { rows?: Array<{ row?: unknown }> };
    const rows = body.rows?.map(({ row }) => row) ?? [];
    output.push(...rows); offset += rows.length;
    if (rows.length < length) break;
  }
  return output;
}

async function timed(operation: () => Promise<string>): Promise<ToolResult> {
  const started = performance.now();
  try { return { ok: true, output: await operation(), durationMs: performance.now() - started }; }
  catch (error) { return { ok: false, output: error instanceof Error ? error.message : String(error), durationMs: performance.now() - started }; }
}
async function safeFilesystemPath(root: string, path: string, allowMissingLeaf: boolean): Promise<string> {
  if (!path || isAbsolute(path)) throw new Error(`Path must be workspace-relative: '${path}'`);
  const target = resolve(root, path); const value = relative(resolve(root), target);
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error(`Path escapes workspace: '${path}'`);
  let current = resolve(root);
  for (const [index, part] of value.split(sep).filter(Boolean).entries()) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Path traverses a symbolic link: '${path}'`); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'ENOENT' && allowMissingLeaf && index === value.split(sep).filter(Boolean).length - 1) continue;
      throw error;
    }
  }
  return target;
}
async function workspaceDigest(path: string): Promise<string> {
  const git = simpleGit(path);
  const [diff, untracked] = await Promise.all([
    git.raw(['diff', '--binary', 'HEAD', '--']),
    git.raw(['ls-files', '--others', '--exclude-standard']),
  ]);
  const hash = createHash('sha256').update(diff);
  for (const file of untracked.split('\n').filter(Boolean).sort()) {
    const target = await safeFilesystemPath(path, file, false);
    hash.update(file).update('\0').update(await readFile(target)).update('\0');
  }
  return hash.digest('hex');
}
function sourceConfig(value: unknown): SWEbenchSourceConfig {
  const record = object(value, 'SWE-bench source configuration');
  const datasetPath = optionalText(record.datasetPath);
  return {
    dataset: optionalText(record.dataset) ?? DEFAULT_DATASET,
    split: optionalText(record.split) ?? DEFAULT_SPLIT,
    cacheDirectory: resolve(optionalText(record.cacheDirectory) ?? '.cache/swebench'),
    evaluationDirectory: resolve(optionalText(record.evaluationDirectory) ?? '.'),
    pythonCommand: optionalText(record.pythonCommand) ?? 'python3',
    evaluationTimeoutMs: positiveInteger(record.evaluationTimeoutMs ?? 1_800_000, 'evaluationTimeoutMs'),
    ...(datasetPath ? { datasetPath: resolve(datasetPath) } : {}),
  };
}

function taskSource(task: EvaluationTask) {
  if (task.type !== 'T-issue' || task.source.kind !== 'swebench') throw new Error(`SWE-bench plugin cannot open task '${task.id}'`);
  const data = task.source.data;
  const repository = requiredText(data.repository, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid SWE-bench repository');
  const baseCommit = requiredText(data.baseCommit, 'baseCommit');
  if (!/^[a-f0-9]{40}$/i.test(baseCommit)) throw new Error('Invalid SWE-bench base commit');
  return {
    repository, baseCommit,
    dataset: requiredText(data.dataset, 'dataset'), split: requiredText(data.split, 'split'),
    cacheDirectory: resolve(requiredText(data.cacheDirectory, 'cacheDirectory')),
    evaluationDirectory: resolve(requiredText(data.evaluationDirectory, 'evaluationDirectory')),
    pythonCommand: requiredText(data.pythonCommand, 'pythonCommand'),
    evaluationTimeoutMs: positiveInteger(data.evaluationTimeoutMs, 'evaluationTimeoutMs'),
    ...(optionalText(data.image) ? { image: optionalText(data.image)! } : {}),
  };
}

function parseRow(value: unknown): SWEbenchRow {
  const row = object(value, 'SWE-bench row');
  for (const key of ['repo', 'instance_id', 'base_commit', 'patch', 'problem_statement'] as const) requiredText(row[key], key);
  testNames(row.FAIL_TO_PASS); testNames(row.PASS_TO_PASS);
  return { ...row, test_patch: typeof row.test_patch === 'string' ? row.test_patch : '' } as unknown as SWEbenchRow;
}
function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) paths.push(match[2] === '/dev/null' ? match[1]! : match[2]!);
  }
  return [...new Set(paths)];
}
function testNames(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('Invalid SWE-bench test list');
  return parsed;
}
function stringArray(value: unknown): string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []; }
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function optionalText(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer`);
  return value as number;
}
function nonnegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}
function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}
function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9_.-]/g, '_'); }
async function exists(path: string): Promise<boolean> { try { await readFile(path); return true; } catch { return false; } }
function requireSuccess(label: string): (result: ProcessResult) => void {
  return (result) => { if (result.exitCode !== 0) throw new Error(`${label} failed (${result.exitCode}): ${result.output.slice(-1000)}`); };
}

export const runProcess: ProcessRunner = (command, args, options) => new Promise((resolveResult, rejectResult) => {
  const started = performance.now(); const child = spawn(command, args, { cwd: options.cwd, shell: false, env: options.env ?? process.env, detached: true });
  const chunks: Buffer[] = []; let bytes = 0; let settled = false;
  const retain = (chunk: Buffer) => { if (bytes < options.maxOutputBytes) { chunks.push(chunk.subarray(0, options.maxOutputBytes - bytes)); bytes += chunk.length; } };
  const finish = (exitCode: number) => {
    if (settled) return; settled = true; clearTimeout(timer);
    resolveResult({ exitCode, output: Buffer.concat(chunks).toString('utf8'), durationMs: performance.now() - started });
  };
  const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} finish(124); }, options.timeoutMs);
  child.stdout.on('data', retain); child.stderr.on('data', retain);
  child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); rejectResult(error); } });
  child.once('close', (code) => finish(code ?? 1));
});

const plugin = createSWEbenchPlugin();
export default plugin;
