import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createBugsInPyPlugin, parseTestCommand } from './index.js';

const exec = promisify(execFile);
const git = (repository: string, ...args: string[]) => exec('git', ['-C', repository, ...args]);

test('parses one shell-free BugsInPy test command', () => {
  assert.deepEqual(parseTestCommand('python -m unittest -q tests.test_math.Test.test_add\n'),
    ['python', '-m', 'unittest', '-q', 'tests.test_math.Test.test_add']);
  assert.throws(() => parseTestCommand('pytest tests; rm -rf /'), /unsupported shell syntax/);
  assert.throws(() => parseTestCommand('pytest a\npytest b\n'), /exactly one command/);
});

test('advertises System One selectors without requiring credentials for local selectors', () => {
  const plugin = createBugsInPyPlugin();
  assert.deepEqual(plugin.selectors!.kinds(), [
    'none', 'bm25', 'heuristic', 'llm-listwise', 'system-one-choice', 'system-one-noul', 'system-one-combined',
  ]);
  assert.ok(plugin.selectors!.create('bm25', { task: { id: 't', type: 'T-fix', task: 'fix' } }));
  const prior = process.env.TYPESAFE_API_KEY;
  const priorLlm = process.env.LLM_SELECTION_PROVIDER_CONFIG;
  const priorLlmPath = process.env.LLM_SELECTION_PROVIDER_CONFIG_PATH;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.LLM_SELECTION_PROVIDER_CONFIG;
  delete process.env.LLM_SELECTION_PROVIDER_CONFIG_PATH;
  try {
    assert.throws(() => plugin.selectors!.create('system-one-choice', {
      task: { id: 't', type: 'T-fix', task: 'fix' },
    }), /requires TYPESAFE_API_KEY/);
    assert.throws(() => plugin.selectors!.create('llm-listwise', {
      task: { id: 't', type: 'T-fix', task: 'fix' },
    }), /requires LLM_SELECTION_PROVIDER_CONFIG_PATH or LLM_SELECTION_PROVIDER_CONFIG/);
  } finally {
    if (prior !== undefined) process.env.TYPESAFE_API_KEY = prior;
    if (priorLlm !== undefined) process.env.LLM_SELECTION_PROVIDER_CONFIG = priorLlm;
    if (priorLlmPath !== undefined) process.env.LLM_SELECTION_PROVIDER_CONFIG_PATH = priorLlmPath;
  }
});

test('imports BugsInPy metadata as a Docker-backed visible-test task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugsinpy-import-'));
  const benchmark = join(root, 'benchmark'); const project = join(benchmark, 'projects', 'demo');
  const bug = join(project, 'bugs', '1'); const repository = join(root, 'upstream');
  await mkdir(bug, { recursive: true }); await mkdir(repository);
  await git(repository, 'init', '-q'); await git(repository, 'config', 'user.email', 'test@example.com');
  await git(repository, 'config', 'user.name', 'Test'); await mkdir(join(repository, 'tests'));
  await writeFile(join(repository, 'math.py'), 'def add(a,b): return a-b\n');
  await writeFile(join(repository, 'tests', 'test_math.py'), 'old test\n');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-qm', 'buggy');
  const buggy = (await git(repository, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(repository, 'math.py'), 'def add(a,b): return a+b\n');
  await writeFile(join(repository, 'tests', 'test_math.py'), 'new failing test\n');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-qm', 'fixed');
  const fixed = (await git(repository, 'rev-parse', 'HEAD')).stdout.trim();
  const patch = (await git(repository, 'diff', `${buggy}..${fixed}`)).stdout;
  await writeFile(join(project, 'project.info'), `github_url="${repository}"\nstatus="OK"\n`);
  // The pinned benchmark contains both `key="value"` and `key ="value"`.
  await writeFile(join(bug, 'bug.info'), `python_version="3.11"\nbuggy_commit_id="${buggy}"\nfixed_commit_id ="${fixed}"\ntest_file="tests/test_math.py"\n`);
  await writeFile(join(bug, 'bug_patch.txt'), patch); await writeFile(join(bug, 'run_test.sh'), 'python -m unittest tests.test_math\n');
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({
    benchmarkDirectory: benchmark, cacheDirectory: join(root, 'cache'), workspaceDirectory: join(root, 'worktrees'),
    snapshotDirectory: join(root, 'snapshots'), image: `fixture@sha256:${'a'.repeat(64)}`,
    projects: [{ name: 'demo', bugs: [1] }], timeoutMs: 1000,
  }));
  const plugin = createBugsInPyPlugin();
  const [task] = await plugin.taskSource!.mine(config, { limit: 1 });
  assert.equal(task!.type, 'T-fix'); assert.equal(task!.source.kind, 'docker-git');
  assert.deepEqual(task!.goldFiles, ['math.py']); assert.deepEqual(task!.testFiles, ['tests/test_math.py']);
  assert.match(String(task!.gold?.sourcePatch), /math\.py/);
  assert.doesNotMatch(String(task!.gold?.sourcePatch), /tests\/test_math\.py/);
  assert.match(String(task!.gold?.testPatch), /new failing test/);
  assert.deepEqual((task!.source.data.visibleTest as { args: string[] }).args, ['-m', 'unittest', 'tests.test_math']);
  assert.equal(task!.reporting?.benchmark, 'BugsInPy');
  const cached = String(task!.source.data.repository);
  assert.ok((await readFile(join(cached, 'HEAD'), 'utf8')).length > 0);
});
