import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EvaluationTask } from '../eval/tasks.js';

export async function writeTaskSplits(tasks: EvaluationTask[], devPath: string, testPath: string): Promise<void> {
  await Promise.all([mkdir(dirname(devPath), { recursive: true }), mkdir(dirname(testPath), { recursive: true })]);
  const encode = (split: 'dev' | 'test') => tasks.filter((task) => task.split === split)
    .map((task) => JSON.stringify(task)).join('\n');
  await writeFile(devPath, `${encode('dev')}\n`);
  await writeFile(testPath, `${encode('test')}\n`);
}
