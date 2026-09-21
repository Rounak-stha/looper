import type { HarnessPlugin } from '../src/core/plugins.js';

/**
 * Minimal plugin shape. Replace these methods with your repository service,
 * sandbox, LSP, hosted index, or other existing tooling.
 */
const plugin: HarnessPlugin = {
  name: 'my-repository-tools',

  taskSource: {
    async mine(_location, _options) {
      return [];
    },
  },

  workspaces: {
    async acquire(task) {
      const path = String(task.source.data.workspacePath ?? '');
      if (!path) throw new Error('Expected source.data.workspacePath');
      return { path, async release() {} };
    },
  },

  context: {
    async create(_input) {
      return {
        async search(_query, _options) { return []; },
        async load(id) { throw new Error(`Unknown candidate: ${id}`); },
      };
    },
  },

  // Optional: expose any selector implementations under arbitrary names.
  selectors: {
    kinds: () => [],
    create: (_kind, _input) => undefined,
  },

  // Optional. Creates routers for offline replay without a full online agent.
  replayRouters: {
    kinds: () => ['rules'],
    async create(kind) {
      if (kind !== 'rules') throw new Error(`Unknown replay router: ${kind}`);
      return { async route({ feasible }) { return { action: feasible[0]!, source: 'rule' }; } };
    },
  },

  // Optional. Creates routing/reasoning for online runs. A real implementation
  // can use the supplied ledger, logger, run cap, and current step.
  agent: {
    async create(_input) {
      return {
        router: { async route({ feasible }) { return { action: feasible[0], source: 'rule' }; } },
        reasoner: { async decide() { return { thought: 'not implemented', usage: { inputTokens: 0, outputTokens: 0 } }; } },
      };
    },
  },

  // Optional. Agent tools can target a local sandbox, container, VM, or remote API.
  tools: {
    async create(_input) {
      return {
        async readFile(_path) { return { ok: false, output: 'not implemented', durationMs: 0 }; },
        async writeFile(_path, _content) { return { ok: false, output: 'not implemented', durationMs: 0 }; },
        async search(_query) { return { ok: false, output: 'not implemented', durationMs: 0 }; },
        async runTests() { return { ok: false, output: 'not implemented', durationMs: 0, exitCode: 1 }; },
        async runCommand(_command, _args) { return { ok: false, output: 'not implemented', durationMs: 0 }; },
        async snapshot() { return { id: 'not-implemented' }; },
      };
    },
  },

  // Optional. This is authoritative run scoring (for example, hidden tests).
  evaluator: {
    async evaluate(_input) {
      return { passed: false, exitCode: 1, durationMs: 0, output: 'not implemented' };
    },
  },

  // Optional. Resolves opaque snapshots after a run for hidden-test labels.
  snapshots: {
    async evaluate(_input) {
      return { passed: false, exitCode: 1, durationMs: 0, output: 'not implemented' };
    },
  },

  // Optional. The plugin owns isolation, installation, patch application, and
  // test commands; the harness consumes only the structured evidence.
  validator: {
    async validate(_task) {
      return {
        before: { passed: false, exitCode: 1, durationMs: 0 },
        after: { passed: false, exitCode: 1, durationMs: 0 },
        reason: 'Implement validation in your sandbox provider',
      };
    },
  },
};

export default plugin;
