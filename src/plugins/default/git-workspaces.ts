import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { WorkspaceLease, WorkspaceProvider } from '../../core/plugins.js';
import type { EvaluationTask } from '../../eval/tasks.js';

/** Optional default workspace implementation backed by Git worktrees. */
export class GitWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly workspaceRoot = '.cache/worktrees') {}

  async acquire(task: EvaluationTask): Promise<WorkspaceLease> {
    if (task.source.kind !== 'git') throw new Error(`Default Git workspace cannot open source kind: ${task.source.kind}`);
    const repositoryPath = requiredString(task.source.data, 'repository');
    const baseRef = requiredString(task.source.data, 'baseRef');
    const destination = resolve(this.workspaceRoot, task.id);
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    const repository = simpleGit(repositoryPath);
    await repository.raw(['worktree', 'add', '--detach', destination, baseRef]);
    return {
      path: destination,
      release: async () => { await repository.raw(['worktree', 'remove', '--force', destination]); },
    };
  }
}

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || !value) throw new Error(`Git task source requires string ${key}`);
  return value;
}
