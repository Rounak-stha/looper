import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { simpleGit } from 'simple-git';
import type { ToolResult, HarnessPlugin, TaskEvaluationResult, WorkspaceLease } from '../../core/plugins.js';
import type { EvaluationTask } from '../../eval/tasks.js';
import { mineTasks } from '../default/git-task-miner.js';
import { FilesystemContextProvider } from '../default/filesystem-context.js';
import { Bm25Selector } from '../default/minisearch-selector.js';
import { HeuristicSelector } from '../default/heuristic-selector.js';
import { NoneSelector } from '../../selection/none.js';
import { RulesRouter } from '../../routing/rules.js';
import { JsonCodingDecisionCodec } from '../../agent/json-codec.js';
import { MeteredCodingReasoner } from '../../agent/reasoning-adapter.js';
import { MeteredReasoningModel } from '../../models/metered.js';
import { reasoningProviderFromConfig } from '../reasoning-provider.js';

interface CommandSpec { command: string; args: string[]; timeoutMs: number }
interface SandboxSpec {
  image: string; cpus: number; memory: string; pidsLimit: number; maxOutputBytes: number;
  visibleTest: CommandSpec; authoritativeTest: CommandSpec;
}
interface RepositorySpec extends SandboxSpec {
  repository: string; snapshotDirectory: string; workspaceDirectory: string;
}
type DockerLease = WorkspaceLease & { sandbox: RepositorySpec };

export interface ProcessResult { exitCode: number; output: string; durationMs: number }
export type ProcessRunner = (command: string, args: string[], options: {
  cwd?: string; timeoutMs: number; maxOutputBytes: number;
}) => Promise<ProcessResult>;

export function createDockerGitPlugin(runner: ProcessRunner = runProcess): HarnessPlugin {
  const plugin: HarnessPlugin = {
    name: 'docker-git',
    taskSource: {
      async mine(location, options) {
        const specification = repositorySpec(JSON.parse(await readFile(location, 'utf8')));
        const tasks = await mineTasks(specification.repository, options);
        return tasks.map((task) => ({
          ...task,
          source: { kind: 'docker-git', data: {
            repository: specification.repository,
            baseRef: task.source.data.baseRef,
            fixRef: task.source.data.fixRef,
            image: specification.image,
            cpus: specification.cpus,
            memory: specification.memory,
            pidsLimit: specification.pidsLimit,
            visibleTest: specification.visibleTest,
            authoritativeTest: specification.authoritativeTest,
            snapshotDirectory: specification.snapshotDirectory,
            workspaceDirectory: specification.workspaceDirectory,
          } },
          reporting: { ...(task.reporting ?? {}), repository: String(task.source.data.name ?? 'repository') },
        }));
      },
    },
    workspaces: {
      async acquire(task) {
        const source = taskSource(task);
        await mkdir(source.workspaceDirectory, { recursive: true });
        const destination = join(source.workspaceDirectory, `${safeName(task.id)}-${randomUUID()}`);
        const repository = simpleGit(source.repository);
        await repository.raw(['worktree', 'add', '--detach', destination, requiredText(task.source.data.baseRef, 'baseRef')]);
        try {
          const testPatch = optionalText(task.gold?.testPatch);
          if (testPatch) await applyPatch(destination, testPatch);
        } catch (error) {
          await repository.raw(['worktree', 'remove', '--force', destination]).catch(() => undefined);
          throw error;
        }
        return {
          path: destination, sandbox: source,
          async release() { await repository.raw(['worktree', 'remove', '--force', destination]); },
        } satisfies DockerLease;
      },
    },
    context: { create({ workspacePath }) { return FilesystemContextProvider.create(workspacePath); } },
    selectors: {
      kinds: () => ['none', 'bm25', 'heuristic'],
      create(kind) {
        if (kind === 'none') return new NoneSelector();
        if (kind === 'bm25') return new Bm25Selector();
        if (kind === 'heuristic') return new HeuristicSelector();
        return undefined;
      },
    },
    replayRouters: {
      kinds: () => ['rules'],
      async create(kind) {
        if (kind !== 'rules') throw new Error(`Unknown replay router: ${kind}`);
        return new RulesRouter();
      },
    },
    tools: {
      async create({ workspace }) {
        const lease = workspace as DockerLease;
        return {
          async readFile(path, range) {
            return timed(async () => lineRange(await readFile(await safeFilesystemPath(lease.path, path, false), 'utf8'), range));
          },
          async writeFile(path, content) {
            return timed(async () => {
              const target = await safeFilesystemPath(lease.path, path, true);
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, content, 'utf8');
              return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
            });
          },
          async replaceText(path, oldText, newText) {
            return timed(async () => {
              const target = await safeFilesystemPath(lease.path, path, false);
              const text = await readFile(target, 'utf8');
              const occurrences = text.split(oldText).length - 1;
              if (occurrences !== 1) throw new Error(`replace_text requires exactly one match; found ${occurrences}`);
              await writeFile(target, text.replace(oldText, newText), 'utf8');
              return `replaced ${Buffer.byteLength(oldText)} bytes with ${Buffer.byteLength(newText)} bytes in ${path}`;
            });
          },
          async search(query) {
            return timed(async () => {
              const needle = query.toLowerCase(); const matches: string[] = [];
              for (const path of await files(lease.path)) {
                const text = await readFile(join(lease.path, path), 'utf8').catch(() => '');
                const lines = text.split('\n');
                for (let index = 0; index < lines.length; index++) {
                  if (lines[index]!.toLowerCase().includes(needle)) matches.push(`${path}:${index + 1}:${lines[index]!.trim().slice(0, 240)}`);
                  if (matches.length >= 100) return matches.join('\n');
                }
                if (path.toLowerCase().includes(needle) && !lines.some((line) => line.toLowerCase().includes(needle))) matches.push(`${path}:1`);
              }
              return matches.join('\n');
            });
          },
          async runTests() { return dockerRun(runner, lease.path, lease.sandbox, lease.sandbox.visibleTest); },
          async snapshot() { return persistSnapshot(lease.path, lease.sandbox.snapshotDirectory); },
        };
      },
    },
    evaluator: {
      async evaluate({ task, workspace }) {
        const lease = workspace as DockerLease;
        return evaluate(runner, lease.path, lease.sandbox, lease.sandbox.authoritativeTest);
      },
    },
    snapshots: {
      async evaluate({ task, snapshotId }) {
        const source = taskSource(task);
        const digest = snapshotDigest(snapshotId);
        const stored = safePath(source.snapshotDirectory, digest);
        if (await treeDigest(stored) !== digest) throw new Error(`Snapshot '${snapshotId}' failed integrity validation`);
        const temporary = await mkdtemp(join(tmpdir(), 'harness-docker-snapshot-'));
        try {
          await copyTree(stored, temporary);
          return await evaluate(runner, temporary, source, source.authoritativeTest);
        } finally { await rm(temporary, { recursive: true, force: true }); }
      },
    },
    validator: {
      async validate(task) {
        const workspace = await plugin.workspaces.acquire(task) as DockerLease;
        try {
          const before = await evaluate(runner, workspace.path, workspace.sandbox, workspace.sandbox.authoritativeTest);
          const sourcePatch = requiredText(task.gold?.sourcePatch, 'gold.sourcePatch');
          await applyPatch(workspace.path, sourcePatch);
          const after = await evaluate(runner, workspace.path, workspace.sandbox, workspace.sandbox.authoritativeTest);
          return { before, after, metadata: { sandbox: 'docker', network: 'none' } };
        } finally { await workspace.release(); }
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
  return plugin;
}

export function dockerArguments(workspace: string, sandbox: SandboxSpec, command: CommandSpec): string[] {
  return [
    'run', '--rm', '--network', 'none', '--read-only', '--user', `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`,
    '--cpus', String(sandbox.cpus), '--memory', sandbox.memory, '--pids-limit', String(sandbox.pidsLimit),
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--env', 'HOME=/tmp',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m', '-v', `${resolve(workspace)}:/workspace:rw`, '-w', '/workspace',
    sandbox.image, command.command, ...command.args,
  ];
}

async function dockerRun(runner: ProcessRunner, workspace: string, sandbox: SandboxSpec, command: CommandSpec): Promise<ToolResult> {
  const options = { timeoutMs: command.timeoutMs, maxOutputBytes: sandbox.maxOutputBytes };
  let result = await runner('docker', dockerArguments(workspace, sandbox, command), options);
  const digest = missingLocalDigest(result, sandbox.image);
  if (digest) {
    // A locally built image can lose its RepoDigest alias when the mutable tag is
    // advanced. Retry only by the exact content-addressed image ID, never by tag.
    result = await runner('docker', dockerArguments(workspace, { ...sandbox, image: digest }, command), options);
  }
  if ([125, 126, 127].includes(result.exitCode)) {
    throw new Error(`Docker infrastructure failure (${result.exitCode}): ${result.output.slice(0, 500)}`);
  }
  return { ok: result.exitCode === 0, exitCode: result.exitCode, output: result.output, durationMs: result.durationMs };
}
function missingLocalDigest(result: ProcessResult, image: string): string | undefined {
  const match = image.match(/@(?<digest>sha256:[a-f0-9]{64})$/);
  if (result.exitCode !== 125 || !match?.groups?.digest) return undefined;
  return /Unable to find image .+ locally[\s\S]*pull access denied/.test(result.output) ? match.groups.digest : undefined;
}
async function evaluate(runner: ProcessRunner, workspace: string, sandbox: SandboxSpec, command: CommandSpec): Promise<TaskEvaluationResult> {
  const result = await dockerRun(runner, workspace, sandbox, command);
  return { passed: result.ok, exitCode: result.exitCode ?? 1, durationMs: result.durationMs, output: result.output };
}

async function applyPatch(workspace: string, patch: string): Promise<void> {
  const path = join(workspace, `.harness-patch-${randomUUID()}`);
  await writeFile(path, patch, 'utf8');
  try { await simpleGit(workspace).raw(['apply', '--whitespace=nowarn', path]); }
  finally { await rm(path, { force: true }); }
}

async function persistSnapshot(workspace: string, root: string): Promise<{ id: string }> {
  const digest = await treeDigest(workspace); const destination = join(root, digest);
  try { await stat(destination); } catch {
    const staging = join(root, `.staging-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    try { await copyTree(workspace, staging); await stat(destination).catch(() => renameDirectory(staging, destination)); }
    finally { await rm(staging, { recursive: true, force: true }); }
  }
  return { id: `sha256:${digest}` };
}
async function renameDirectory(source: string, destination: string): Promise<void> {
  const { rename } = await import('node:fs/promises'); await rename(source, destination);
}
type TreeEntry = { path: string; mode: number; kind: 'file' } | { path: string; mode: number; kind: 'symlink'; link: string };
async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await fileEntries(source, '', true)) {
    const target = join(destination, entry.path); await mkdir(dirname(target), { recursive: true });
    if (entry.kind === 'symlink') await symlink(entry.link, target);
    else { await writeFile(target, await readFile(join(source, entry.path))); await chmod(target, entry.mode); }
  }
}
async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of await fileEntries(root, '', true)) {
    hash.update(entry.path).update('\0').update(entry.kind).update('\0').update(String(entry.mode)).update('\0');
    if (entry.kind === 'symlink') hash.update(entry.link);
    else hash.update(await readFile(join(root, entry.path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
async function files(root: string): Promise<string[]> {
  return (await fileEntries(root)).filter((entry) => entry.kind === 'file').map(({ path }) => path);
}
async function fileEntries(root: string, current = '', includeSymlinks = false): Promise<TreeEntry[]> {
  const output: TreeEntry[] = [];
  for (const entry of (await readdir(join(root, current))).sort()) {
    if (['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(entry)) continue;
    const path = join(current, entry); const absolute = join(root, path); const information = await lstat(absolute);
    if (information.isSymbolicLink()) {
      if (!includeSymlinks) continue;
      const link = await readlink(absolute);
      if (isAbsolute(link) || !isWithin(root, resolve(dirname(absolute), link))) {
        throw new Error(`Repository snapshot symbolic link escapes workspace: '${path}'`);
      }
      output.push({ path, mode: information.mode & 0o777, kind: 'symlink', link });
    } else if (information.isDirectory()) output.push(...await fileEntries(root, path, includeSymlinks));
    else if (information.isFile()) output.push({ path, mode: information.mode & 0o777, kind: 'file' });
  }
  return output;
}
function safePath(root: string, path: string): string {
  if (!path || isAbsolute(path)) throw new Error(`Path must be workspace-relative: '${path}'`);
  const target = resolve(root, path); const value = relative(resolve(root), target);
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error(`Path escapes workspace: '${path}'`);
  return target;
}
async function safeFilesystemPath(root: string, path: string, allowMissingLeaf: boolean): Promise<string> {
  const target = safePath(root, path);
  const parts = relative(resolve(root), target).split(sep).filter(Boolean);
  let current = resolve(root);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Path traverses a symbolic link: '${path}'`);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'ENOENT' && allowMissingLeaf) {
        if (index !== parts.length - 1) await mkdir(current, { recursive: true });
        continue;
      }
      throw error;
    }
  }
  return target;
}
function snapshotDigest(id: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(id);
  if (!match) throw new Error(`Unknown snapshot '${id}'`);
  return match[1]!;
}

function repositorySpec(value: unknown): RepositorySpec {
  const record = object(value, 'repository specification');
  const repository = resolve(requiredText(record.repository, 'repository'));
  const image = requiredText(record.image, 'image');
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('image must use an immutable sha256 digest');
  const snapshotDirectory = resolve(requiredText(record.snapshotDirectory ?? 'runs/docker-git-snapshots', 'snapshotDirectory'));
  const workspaceDirectory = resolve(requiredText(record.workspaceDirectory ?? '.cache/docker-git-workspaces', 'workspaceDirectory'));
  if (isWithin(repository, snapshotDirectory) || isWithin(repository, workspaceDirectory)) {
    throw new Error('snapshotDirectory and workspaceDirectory must be outside the source repository');
  }
  if (isWithin(snapshotDirectory, workspaceDirectory) || isWithin(workspaceDirectory, snapshotDirectory)) {
    throw new Error('snapshotDirectory and workspaceDirectory must not overlap');
  }
  return {
    repository,
    image,
    cpus: positive(record.cpus ?? 2, 'cpus'), memory: requiredText(record.memory ?? '4g', 'memory'),
    pidsLimit: positiveInteger(record.pidsLimit ?? 256, 'pidsLimit'),
    maxOutputBytes: positiveInteger(record.maxOutputBytes ?? 1_000_000, 'maxOutputBytes'),
    visibleTest: commandSpec(record.visibleTest, 'visibleTest'),
    authoritativeTest: commandSpec(record.authoritativeTest, 'authoritativeTest'),
    snapshotDirectory, workspaceDirectory,
  };
}
function taskSource(task: EvaluationTask): RepositorySpec {
  if (task.source.kind !== 'docker-git') throw new Error(`Docker Git plugin cannot open source kind '${task.source.kind}'`);
  return repositorySpec(task.source.data);
}
function commandSpec(value: unknown, name: string): CommandSpec {
  const record = object(value, name);
  const args = record.args;
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw new Error(`${name}.args must be a string array`);
  return { command: requiredText(record.command, `${name}.command`), args, timeoutMs: positiveInteger(record.timeoutMs, `${name}.timeoutMs`) };
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function optionalText(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`); return value;
}
function nonnegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`); return value;
}
function positiveInteger(value: unknown, name: string): number {
  const parsed = positive(value, name); if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`); return parsed;
}
function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`); return value as number;
}
function isWithin(root: string, target: string): boolean {
  const value = relative(resolve(root), resolve(target));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9_.-]/g, '_'); }
function lineRange(text: string, range?: { startLine?: number; endLine?: number }): string {
  const lines = text.split('\n');
  const start = range?.startLine ?? 1;
  const end = Math.min(range?.endLine ?? start + 399, lines.length);
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) throw new Error('Invalid read line range');
  return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
}

async function timed(operation: () => Promise<string>): Promise<ToolResult> {
  const started = performance.now();
  try { return { ok: true, output: await operation(), durationMs: performance.now() - started }; }
  catch (error) { return { ok: false, output: error instanceof Error ? error.message : String(error), durationMs: performance.now() - started }; }
}
export const runProcess: ProcessRunner = (command, args, options) => new Promise((resolveResult, rejectResult) => {
  const started = performance.now(); const child = spawn(command, args, { cwd: options.cwd, shell: false, env: process.env });
  const chunks: Buffer[] = []; let retainedBytes = 0; let truncated = false; let settled = false;
  const retain = (chunk: Buffer) => {
    const remaining = options.maxOutputBytes - retainedBytes;
    if (remaining > 0) { const kept = chunk.subarray(0, remaining); chunks.push(kept); retainedBytes += kept.length; }
    if (chunk.length > remaining) truncated = true;
  };
  const finish = (exitCode: number, extra = '') => {
    if (settled) return; settled = true; clearTimeout(timer);
    const suffix = `${truncated ? '\n[output truncated]' : ''}${extra}`;
    resolveResult({ exitCode, output: `${Buffer.concat(chunks).toString('utf8')}${suffix}`, durationMs: performance.now() - started });
  };
  const timer = setTimeout(() => { child.kill('SIGKILL'); finish(124, `\ncommand timed out after ${options.timeoutMs}ms`); }, options.timeoutMs);
  child.stdout.on('data', retain); child.stderr.on('data', retain);
  child.stdout.on('error', rejectResult); child.stderr.on('error', rejectResult);
  child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); rejectResult(error); } });
  child.once('close', (code, signal) => finish(code ?? 1, signal ? `\nterminated by ${signal}` : ''));
});

const plugin = createDockerGitPlugin();
export default plugin;
