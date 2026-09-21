import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentDecision, AgentToolCall } from '../../agent/types.js';
import type {
  HarnessPlugin, TaskEvaluationResult, ToolResult, WorkspaceLease,
} from '../../core/plugins.js';
import { MiniSearchContextProvider } from '../default/minisearch-context.js';
import { HeuristicSelector } from '../default/heuristic-selector.js';
import { RulesRouter } from '../../routing/rules.js';
import { JsonCodingDecisionCodec } from '../../agent/json-codec.js';
import { MeteredCodingReasoner } from '../../agent/reasoning-adapter.js';
import { MeteredReasoningModel } from '../../models/metered.js';
import { reasoningProviderFromConfig } from '../reasoning-provider.js';
import { parseTaskDataset } from '../../eval/tasks.js';
import { NoneSelector } from '../../selection/none.js';

type CommandSpec = { command: string; args: string[]; timeoutMs: number };
type LocalLease = WorkspaceLease & { visibleTest: CommandSpec; snapshotDirectory: string };

/**
 * Executable, dependency-free smoke adapter for local trusted fixtures.
 * It is intentionally not a production sandbox and scripted decisions are not scientific evidence.
 */
const plugin: HarnessPlugin = {
  name: 'local-smoke',

  taskSource: {
    async mine(location, options) {
      const tasks = parseTaskDataset(await readFile(location, 'utf8'));
      return tasks.slice(0, options?.limit ?? tasks.length).map(({ split: _split, ...task }) => task);
    },
  },

  workspaces: {
    async acquire(task) {
      if (task.source.kind !== 'local-smoke') throw new Error("Expected source.kind 'local-smoke'");
      const source = task.source.data;
      const sourcePath = requiredText(source.workspacePath, 'source.data.workspacePath');
      const visibleTest = commandSpec(source.visibleTest, 'source.data.visibleTest');
      const snapshotDirectory = resolve(optionalText(source.snapshotDirectory) ?? 'runs/local-smoke-snapshots');
      const root = await mkdtemp(join(tmpdir(), 'harness-local-smoke-'));
      if (isWithin(root, snapshotDirectory)) throw new Error('Snapshot directory must be outside the workspace');
      await cp(resolve(sourcePath), root, { recursive: true });
      return {
        path: root,
        visibleTest, snapshotDirectory,
        async release() { await rm(root, { recursive: true, force: true }); },
      } satisfies LocalLease;
    },
  },

  context: {
    create({ workspacePath }) { return MiniSearchContextProvider.create(workspacePath); },
  },

  selectors: {
    kinds: () => ['none', 'heuristic'],
    create: (kind) => kind === 'none' ? new NoneSelector()
      : kind === 'heuristic' ? new HeuristicSelector() : undefined,
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
      const lease = workspace as LocalLease;
      return {
        async readFile(path) { return timed(async () => readFile(safePath(lease.path, path), 'utf8')); },
        async writeFile(path, content) {
          return timed(async () => {
            const target = safePath(lease.path, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, content, 'utf8');
            return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
          });
        },
        async search(query) {
          return timed(async () => {
            const needle = query.toLowerCase();
            const matches: string[] = [];
            for (const path of await files(lease.path)) {
              const text = await readFile(join(lease.path, path), 'utf8');
              if (`${path}\n${text}`.toLowerCase().includes(needle)) matches.push(path);
            }
            return matches.join('\n');
          });
        },
        async runTests() { return run(lease.visibleTest, lease.path); },
        async runCommand(command, args) { return run({ command, args, timeoutMs: 30_000 }, lease.path); },
        async snapshot() {
          const digest = await treeDigest(lease.path);
          const destination = join(lease.snapshotDirectory, digest);
          try { await stat(destination); }
          catch {
            await mkdir(lease.snapshotDirectory, { recursive: true });
            const staging = await mkdtemp(join(lease.snapshotDirectory, '.snapshot-'));
            try { await cp(lease.path, staging, { recursive: true }); await cp(staging, destination, { recursive: true }); }
            finally { await rm(staging, { recursive: true, force: true }); }
          }
          return { id: `sha256:${digest}` };
        },
      };
    },
  },

  agent: {
    async create({ config, runId, task, logger, ledger, runCapUsd, currentStep }) {
      const raw = config.scriptedDecisions;
      if (Array.isArray(raw)) {
        const decisions = raw.map((value, index) => scriptedDecision(value, index));
        let next = 0;
        return {
          router: new RulesRouter(),
          reasoner: {
            async decide() {
              const decision = decisions[next++];
              if (!decision) return { thought: 'script exhausted', usage: zeroUsage() };
              return { ...decision, usage: zeroUsage() };
            },
          },
        };
      }
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

  evaluator: {
    async evaluate({ task, workspace }) {
      return evaluateWorkspace(task.source.data, workspace.path);
    },
  },

  snapshots: {
    async evaluate({ task, snapshotId }) {
      const match = /^sha256:([a-f0-9]{64})$/.exec(snapshotId);
      if (!match) throw new Error(`Unknown local smoke snapshot '${snapshotId}'`);
      const directory = resolve(optionalText(task.source.data.snapshotDirectory) ?? 'runs/local-smoke-snapshots');
      const stored = safePath(directory, match[1]!);
      if (await treeDigest(stored) !== match[1]) throw new Error(`Local smoke snapshot '${snapshotId}' failed integrity validation`);
      const workspace = await mkdtemp(join(tmpdir(), 'harness-local-snapshot-'));
      try {
        await cp(stored, workspace, { recursive: true });
        return await evaluateWorkspace(task.source.data, workspace);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  },

  validator: {
    async validate(task) {
      const beforeWorkspace = await plugin.workspaces.acquire(task);
      try {
        const before = await evaluateWorkspace(task.source.data, beforeWorkspace.path);
        const files = goldFiles(task.gold);
        for (const [path, content] of Object.entries(files)) {
          const target = safePath(beforeWorkspace.path, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, 'utf8');
        }
        const after = await evaluateWorkspace(task.source.data, beforeWorkspace.path);
        return { before, after, metadata: { appliedFiles: Object.keys(files).sort() } };
      } finally {
        await beforeWorkspace.release();
      }
    },
  },
};

async function evaluateWorkspace(source: Record<string, unknown>, workspacePath: string): Promise<TaskEvaluationResult> {
  const spec = commandSpec(source.authoritativeTest ?? source.visibleTest, 'authoritative test');
  const result = await run(spec, workspacePath);
  return {
    passed: result.ok, exitCode: result.exitCode ?? (result.ok ? 0 : 1),
    durationMs: result.durationMs, output: result.output,
  };
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const path of await files(root)) {
    hash.update(path).update('\0').update(await readFile(join(root, path))).update('\0');
  }
  return hash.digest('hex');
}

function isWithin(root: string, target: string): boolean {
  const value = relative(resolve(root), resolve(target));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function zeroUsage() { return { inputTokens: 0, outputTokens: 0 }; }

function scriptedDecision(value: unknown, index: number): Omit<AgentDecision, 'usage'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`scriptedDecisions[${index}] must be an object`);
  const record = value as Record<string, unknown>;
  if (record.thought !== undefined) return { thought: requiredText(record.thought, `scriptedDecisions[${index}].thought`) };
  if (!record.tool || typeof record.tool !== 'object' || Array.isArray(record.tool)) {
    throw new Error(`scriptedDecisions[${index}] requires a tool or thought`);
  }
  const tool = record.tool as Record<string, unknown>;
  let parsed: AgentToolCall;
  if (tool.name === 'run_tests') parsed = { name: 'run_tests' };
  else if (tool.name === 'read_file') parsed = { name: 'read_file', path: requiredText(tool.path, `scriptedDecisions[${index}].tool.path`) };
  else if (tool.name === 'search') parsed = { name: 'search', query: requiredText(tool.query, `scriptedDecisions[${index}].tool.query`) };
  else if (tool.name === 'write_file') parsed = {
    name: 'write_file', path: requiredText(tool.path, `scriptedDecisions[${index}].tool.path`),
    content: typeof tool.content === 'string' ? tool.content : fail(`scriptedDecisions[${index}].tool.content must be a string`),
  };
  else throw new Error(`scriptedDecisions[${index}] has unsupported tool '${String(tool.name)}'`);
  return { tool: parsed };
}

async function timed(operation: () => Promise<string>): Promise<ToolResult> {
  const start = performance.now();
  try { return { ok: true, output: await operation(), durationMs: performance.now() - start }; }
  catch (error) { return { ok: false, output: error instanceof Error ? error.message : String(error), durationMs: performance.now() - start }; }
}

function run(spec: CommandSpec, cwd: string): Promise<ToolResult> {
  const start = performance.now();
  return new Promise((resolveResult) => {
    const child = spawn(spec.command, spec.args, { cwd, shell: false, env: process.env });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, exitCode: 124, output: `${Buffer.concat(chunks).toString('utf8')}\ncommand timed out after ${spec.timeoutMs}ms`, durationMs: performance.now() - start });
    }, spec.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', (error) => finish({ ok: false, exitCode: 1, output: error.message, durationMs: performance.now() - start }));
    child.once('close', (code, signal) => finish({
      ok: code === 0, exitCode: code ?? 1,
      output: `${Buffer.concat(chunks).toString('utf8')}${signal ? `\nterminated by ${signal}` : ''}`,
      durationMs: performance.now() - start,
    }));
  });
}

function safePath(root: string, path: string): string {
  if (!path || isAbsolute(path)) throw new Error(`Path must be workspace-relative: '${path}'`);
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes workspace: '${path}'`);
  return target;
}

async function files(root: string, current = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of (await readdir(join(root, current))).sort()) {
    if (['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(entry)) continue;
    const path = join(current, entry);
    const info = await stat(join(root, path));
    if (info.isDirectory()) output.push(...await files(root, path));
    else if (info.isFile()) output.push(path);
  }
  return output;
}

function goldFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('local-smoke validation requires gold.files');
  const filesValue = (value as Record<string, unknown>).files;
  if (!filesValue || typeof filesValue !== 'object' || Array.isArray(filesValue)
    || Object.entries(filesValue).some(([path, content]) => !path || typeof content !== 'string')) {
    throw new Error('local-smoke validation requires gold.files to map paths to strings');
  }
  return filesValue as Record<string, string>;
}

function commandSpec(value: unknown, name: string): CommandSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== 'string')) throw new Error(`${name}.args must be a string array`);
  const timeoutMs = record.timeoutMs === undefined ? 30_000 : record.timeoutMs;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1) throw new Error(`${name}.timeoutMs must be a positive integer`);
  return { command: requiredText(record.command, `${name}.command`), args: record.args as string[], timeoutMs: timeoutMs as number };
}
function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredText(value, 'snapshotDirectory');
}
function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}
function boundedNonnegativeInteger(value: unknown, max: number, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return value as number;
}
function nonnegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}
function fail(message: string): never { throw new Error(message); }

export default plugin;
