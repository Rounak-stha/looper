import { basename } from 'node:path';
import { simpleGit } from 'simple-git';
import type { TaskMineOptions, TaskSource } from '../../core/plugins.js';
import type { EvaluationTask } from '../../eval/tasks.js';

const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__)\/|(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/i;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/i;

export function isTestFile(path: string): boolean { return TEST_FILE.test(path); }
export function isSourceFile(path: string): boolean {
  return SOURCE_FILE.test(path) && !isTestFile(path) && !path.endsWith('.d.ts');
}

export async function mineTasks(repo: string, options: TaskMineOptions = {}): Promise<EvaluationTask[]> {
  const limit = options.limit ?? 100;
  const maxSourceFiles = options.maxSourceFiles ?? 5;
  const maxChangedLines = options.maxChangedLines ?? 200;
  const repository = simpleGit(repo);
  const raw = (args: string[]) => repository.raw(args);
  const commits = (await raw(['log', '--format=%H', '--no-merges', `--max-count=${limit * 10}`]))
    .trim().split('\n').filter(Boolean);
  const remote = (await raw(['remote', 'get-url', 'origin']).catch(() => '')).trim() || undefined;
  const tasks: EvaluationTask[] = [];

  for (const fixSha of commits) {
    if (tasks.length >= limit) break;
    const parents = (await raw(['rev-list', '--parents', '-n', '1', fixSha])).trim().split(/\s+/);
    const baseSha = parents[1];
    if (!baseSha || parents.length !== 2) continue;

    const statuses = parseNameStatus(await raw(['diff', '--name-status', baseSha, fixSha]));
    const sourceFiles = statuses.filter(({ path }) => isSourceFile(path)).map(({ path }) => path);
    const testFiles = statuses.filter(({ path }) => isTestFile(path)).map(({ path }) => path);
    if (!sourceFiles.length || sourceFiles.length > maxSourceFiles || !testFiles.length) continue;

    const numstat = await raw(['diff', '--numstat', baseSha, fixSha, '--', ...sourceFiles]);
    const changedLines = numstat.trim().split('\n').filter(Boolean).reduce((sum, line) => {
      const [added, deleted] = line.split('\t');
      return sum + numeric(added) + numeric(deleted);
    }, 0);
    if (changedLines > maxChangedLines) continue;

    const createdAt = (await raw(['show', '-s', '--format=%cI', fixSha])).trim();
    tasks.push({
      id: `${slug(basename(repo))}-${fixSha.slice(0, 10)}`,
      type: 'T-fix',
      task: inferTask(testFiles),
      goldFiles: sourceFiles,
      testFiles,
      source: {
        kind: 'git',
        data: { repository: repo, ...(remote ? { remote } : {}), name: basename(repo), baseRef: baseSha, fixRef: fixSha },
      },
      gold: {
        sourcePatch: await raw(['diff', '--binary', baseSha, fixSha, '--', ...sourceFiles]),
        testPatch: await raw(['diff', '--binary', baseSha, fixSha, '--', ...testFiles]),
        changedLines,
      },
      createdAt,
    });
  }
  return tasks;
}

export class GitTaskSource implements TaskSource {
  mine(location: string, options?: TaskMineOptions): Promise<EvaluationTask[]> {
    return mineTasks(location, options);
  }
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const fields = line.split('\t');
    const status = fields[0] ?? '';
    return { status, path: fields.at(-1) ?? '' };
  }).filter(({ status }) => !status.startsWith('D'));
}

function numeric(value: string | undefined): number { return value === '-' ? 0 : Number(value ?? 0); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function inferTask(testFiles: string[]): string {
  // Commit messages and patches are deliberately excluded from task text.
  // Validation can replace this with sanitized failing-test output.
  return `Fix the failing tests in: ${testFiles.join(', ')}`;
}
