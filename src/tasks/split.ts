import { createHash } from 'node:crypto';
import type { EvaluationTask } from '../eval/tasks.js';

export function splitTasks(tasks: EvaluationTask[], testFraction = 0.5, seed = 1): EvaluationTask[] {
  if (testFraction <= 0 || testFraction >= 1) throw new Error('testFraction must be between 0 and 1');
  return tasks.map((task) => {
    const digest = createHash('sha256').update(`${seed}:${task.id}`).digest();
    const bucket = digest.readUInt32BE(0) / 0x1_0000_0000;
    return { ...task, split: bucket < testFraction ? 'test' : 'dev' };
  });
}
