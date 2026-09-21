import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import type { EvaluationTask } from '../../eval/tasks.js';
import { createDockerGitPlugin, dockerArguments, type ProcessRunner } from './index.js';

const exec = promisify(execFile);
const git = (repository: string, ...args: string[]) => exec('git', ['-C', repository, ...args]);

const sandbox = {
  image: `fixture@sha256:${'a'.repeat(64)}`, cpus: 1, memory: '1g', pidsLimit: 32, maxOutputBytes: 1000,
  visibleTest: { command: 'npm', args: ['test'], timeoutMs: 1000 },
  authoritativeTest: { command: 'npm', args: ['run', 'hidden'], timeoutMs: 2000 },
};

test('Docker Git qualification applies test then source patches in an isolated worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-git-validation-'));
  const repository = join(root, 'repository'); await mkdir(repository);
  await git(repository, 'init', '-q'); await git(repository, 'config', 'user.email', 'test@example.com');
  await git(repository, 'config', 'user.name', 'Test'); await mkdir(join(repository, 'src'));
  await writeFile(join(repository, 'src/math.ts'), 'subtract\n');
  await writeFile(join(repository, 'src/math.test.ts'), 'old test\n');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-qm', 'base');
  await writeFile(join(repository, 'src/math.ts'), 'add\n');
  await writeFile(join(repository, 'src/math.test.ts'), 'new test\n');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-qm', 'fix');

  const specification = join(root, 'repository.json');
  await writeFile(specification, JSON.stringify({
    repository, ...sandbox, snapshotDirectory: join(root, 'snapshots'), workspaceDirectory: join(root, 'workspaces'),
  }));
  const seen: string[] = [];
  const plugin = createDockerGitPlugin(async (_command, args) => {
    const workspace = args[args.indexOf('-v') + 1]!.split(':/workspace:rw')[0]!;
    const source = await readFile(join(workspace, 'src/math.ts'), 'utf8');
    const testFile = await readFile(join(workspace, 'src/math.test.ts'), 'utf8');
    seen.push(`${source.trim()}|${testFile.trim()}`);
    const passed = source === 'add\n' && testFile === 'new test\n';
    return { exitCode: passed ? 0 : 1, output: passed ? 'passed' : 'failed', durationMs: 1 };
  });
  const tasks = await plugin.taskSource!.mine(specification, { limit: 1 });
  assert.equal(tasks.length, 1);
  const result = await plugin.validator!.validate(tasks[0]!);
  assert.equal(result.before.passed, false);
  assert.equal(result.after.passed, true);
  assert.deepEqual(seen, ['subtract|new test', 'add|new test']);
  assert.equal(await readFile(join(repository, 'src/math.ts'), 'utf8'), 'add\n');
});

test('Docker arguments enforce isolation and preserve command-array boundaries', () => {
  const args = dockerArguments('/tmp/work space', sandbox, { command: 'node', args: ['test.js', 'a; rm -rf /'], timeoutMs: 1 });
  assert.ok(args.includes('none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--user'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.includes('/tmp/work space:/workspace:rw'));
  assert.deepEqual(args.slice(-3), ['node', 'test.js', 'a; rm -rf /']);
});

test('Docker Git tools use the injected runner and reject host path escapes and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-git-tools-'));
  await writeFile(join(root, 'inside.txt'), 'inside');
  await symlink('/etc/passwd', join(root, 'escape-link'));
  const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    return { exitCode: 0, output: 'passed', durationMs: 4 };
  };
  const plugin = createDockerGitPlugin(runner);
  const tools = await plugin.tools!.create({
    workspace: { path: root, sandbox, async release() {} } as never,
    task: { id: 't', type: 'T-fix', task: 'fix' },
  });
  assert.equal((await tools.readFile('inside.txt')).output, '1: inside');
  assert.equal((await tools.readFile('../outside')).ok, false);
  assert.equal((await tools.readFile('escape-link')).ok, false);
  assert.equal((await tools.writeFile('escape-link', 'bad')).ok, false);
  assert.equal((await tools.replaceText!('inside.txt', 'inside', 'changed')).ok, true);
  assert.match((await tools.readFile('inside.txt')).output, /changed/);
  assert.equal((await tools.replaceText!('inside.txt', 'missing', 'x')).ok, false);
  assert.equal((await tools.runTests()).ok, true);
  assert.equal(calls[0]!.command, 'docker');
  assert.equal(calls[0]!.timeoutMs, 1000);
  assert.ok(calls[0]!.args.includes('--network'));
});

test('Docker retries a missing repository digest by exact local image ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-git-local-digest-'));
  const calls: string[][] = [];
  const plugin = createDockerGitPlugin(async (_command, args) => {
    calls.push(args);
    return calls.length === 1
      ? { exitCode: 125, output: `Unable to find image '${sandbox.image}' locally\npull access denied`, durationMs: 1 }
      : { exitCode: 0, output: 'passed', durationMs: 1 };
  });
  const tools = await plugin.tools!.create({
    workspace: { path: root, sandbox, async release() {} } as never,
    task: { id: 't', type: 'T-fix', task: 'fix' },
  });
  assert.equal((await tools.runTests()).ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.includes(`sha256:${'a'.repeat(64)}`));
  assert.equal(calls[1]!.includes(sandbox.image), false);
});

test('Docker startup failures are infrastructure errors rather than test failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-git-infrastructure-'));
  const plugin = createDockerGitPlugin(async () => ({ exitCode: 125, output: 'daemon unavailable', durationMs: 1 }));
  const tools = await plugin.tools!.create({
    workspace: { path: root, sandbox, async release() {} } as never,
    task: { id: 't', type: 'T-fix', task: 'fix' },
  });
  await assert.rejects(tools.runTests(), /Docker infrastructure failure \(125\)/);
});

test('authoritative evaluation uses its separate hidden-test command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-git-evaluator-'));
  const calls: string[][] = [];
  const plugin = createDockerGitPlugin(async (_command, args) => {
    calls.push(args); return { exitCode: 1, output: 'hidden failed', durationMs: 7 };
  });
  const task: EvaluationTask = {
    id: 't', type: 'T-fix', task: 'fix', goldFiles: ['a.ts'], testFiles: ['a.test.ts'],
    source: { kind: 'docker-git', data: {
      repository: root, baseRef: 'base', fixRef: 'fix', ...sandbox,
      snapshotDirectory: join(root, 'snapshots'), workspaceDirectory: join(root, 'workspaces'),
    } },
  };
  const result = await plugin.evaluator!.evaluate({
    task, workspace: { path: root, sandbox, async release() {} } as never,
  });
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls[0]!.slice(-3), ['npm', 'run', 'hidden']);
  assert.equal(await readFile(join(root, 'inside-does-not-exist'), 'utf8').catch(() => 'missing'), 'missing');
});
