import type { ContextProviderFactory, HarnessPlugin } from '../../core/plugins.js';
import { GitTaskSource } from './git-task-miner.js';
import { GitWorkspaceProvider } from './git-workspaces.js';
import { HeuristicSelector } from './heuristic-selector.js';
import { MiniSearchContextProvider } from './minisearch-context.js';
import { Bm25Selector } from './minisearch-selector.js';
import { NoneSelector } from '../../selection/none.js';

class MiniSearchContextFactory implements ContextProviderFactory {
  create(input: { workspacePath: string }): Promise<MiniSearchContextProvider> {
    return MiniSearchContextProvider.create(input.workspacePath);
  }
}

/** Convenience fallback only. Users can replace every repository-intelligence capability. */
export const defaultPlugin: HarnessPlugin = {
  name: 'default-ts-git',
  taskSource: new GitTaskSource(),
  workspaces: new GitWorkspaceProvider(),
  context: new MiniSearchContextFactory(),
  selectors: {
    kinds: () => ['none', 'bm25', 'heuristic'],
    create: (kind) => kind === 'none' ? new NoneSelector()
      : kind === 'bm25' ? new Bm25Selector()
        : kind === 'heuristic' ? new HeuristicSelector() : undefined,
  },
};
