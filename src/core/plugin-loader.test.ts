import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadHarnessPlugin } from './plugin-loader.js';
import { assertHarnessPlugin } from './plugins.js';

test('loads an external plugin without importing default implementations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-plugin-'));
  const modulePath = join(root, 'plugin.mjs');
  await writeFile(modulePath, `export default {
    name: 'fixture',
    workspaces: { async acquire() { return { path: '/tmp', async release() {} }; } },
    context: { async create() { return { async search() { return []; }, async load() { throw new Error('missing'); } }; } }
  };`);
  const plugin = await loadHarnessPlugin(modulePath);
  assert.equal(plugin.name, 'fixture');
});

test('rejects incomplete plugins', () => {
  assert.throws(() => assertHarnessPlugin({ name: 'incomplete' }), /workspaces\.acquire/);
});
