import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { splitTasks } from '../../tasks/split.js';
import { mineTasks } from './git-task-miner.js';

const exec = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', repo, ...args]);
}

test('mines a commit that changes source and tests without leaking its message', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'task-miner-'));
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src/math.ts'), 'export const add = (a: number, b: number) => a - b;\n');
  await writeFile(join(repo, 'src/math.test.ts'), 'test("adds", () => {});\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'initial');
  await writeFile(join(repo, 'src/math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  await writeFile(join(repo, 'src/math.test.ts'), 'test("adds two numbers", () => {});\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'SECRET root cause in addition');

  const tasks = await mineTasks(repo);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0]!.goldFiles, ['src/math.ts']);
  assert.deepEqual(tasks[0]!.testFiles, ['src/math.test.ts']);
  assert.doesNotMatch(tasks[0]!.task, /SECRET|root cause/);
  assert.equal(tasks[0]!.source.kind, 'git');
  assert.match(String(tasks[0]!.gold?.sourcePatch), /a \+ b/);
});

test('split is deterministic', () => {
  const task = { id: 'a' } as Parameters<typeof splitTasks>[0][number];
  assert.deepEqual(splitTasks([task], 0.5, 7), splitTasks([task], 0.5, 7));
});
