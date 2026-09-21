import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MiniSearchContextProvider } from './minisearch-context.js';
import { summarizeTypeScript } from './ts-morph-summaries.js';

test('extracts symbols and imports with TypeScript compiler API', () => {
  const result = summarizeTypeScript('service.ts', `/** Handles sessions. */\nimport { User } from './user.js';\nexport class SessionService {}`);
  assert.deepEqual(result.symbols, ['SessionService']);
  assert.deepEqual(result.imports, ['./user.js']);
  assert.match(result.summary, /SessionService/);
});

test('provider searches and loads indexed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/auth.ts'), 'export function validateSession() { return true; }');
  await writeFile(join(root, 'src/math.ts'), 'export function add(a: number, b: number) { return a + b; }');
  const provider = await MiniSearchContextProvider.create(root);
  const found = await provider.search('validate authentication session', { limit: 1 });
  assert.equal(found[0]!.path, 'src/auth.ts');
  assert.match((await provider.load('src/auth.ts')).text, /validateSession/);
});

test('provider does not index files through symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'context-outside-'));
  await writeFile(join(outside, 'secret.ts'), 'export const secret = true;');
  await symlink(outside, join(root, 'linked'));
  const provider = await MiniSearchContextProvider.create(root);
  assert.deepEqual(await provider.search('secret', { limit: 10 }), []);
});
