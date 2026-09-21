import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FilesystemContextProvider } from './filesystem-context.js';

test('language-neutral provider indexes Python, Rust, Go, and Java files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'filesystem-context-'));
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'auth.py'), 'def validate_session(token):\n    return token is not None\n');
  await writeFile(join(root, 'lib.rs'), 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n');
  await writeFile(join(root, 'main.go'), 'package main\nfunc main() {}\n');
  await writeFile(join(root, 'Service.java'), 'class Service {}\n');
  await writeFile(join(root, 'tests', 'test_auth.py'), 'def test_auth(): pass\n');
  const provider = await FilesystemContextProvider.create(root);
  const candidates = await provider.search('validate session', { limit: 10 });
  assert.equal(candidates[0]!.path, 'auth.py');
  assert.deepEqual(new Set(candidates.map(({ path }) => path)), new Set(['auth.py', 'lib.rs', 'main.go', 'Service.java', 'tests/test_auth.py']));
  assert.equal(candidates.find(({ path }) => path === 'tests/test_auth.py')!.kind, 'test');
  assert.match((await provider.load('auth.py')).text, /validate_session/);
});

test('language-neutral provider searches bounded file text beyond the selector summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'filesystem-context-full-text-'));
  await writeFile(join(root, 'deep.py'), `${Array.from({ length: 12 }, (_, index) => `header_${index} = ${index}`).join('\n')}\ndef deeply_named_target(): pass\n`);
  await writeFile(join(root, 'other.py'), 'def unrelated(): pass\n');
  const provider = await FilesystemContextProvider.create(root);
  const candidates = await provider.search('deeply named target', { limit: 2 });
  assert.equal(candidates[0]!.path, 'deep.py');
  assert.doesNotMatch(candidates[0]!.summary ?? '', /deeply_named_target/);
});

test('language-neutral provider excludes symbolic links and generated dependency trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'filesystem-context-safe-'));
  const outside = await mkdtemp(join(tmpdir(), 'filesystem-context-outside-'));
  await writeFile(join(outside, 'secret.py'), 'SECRET');
  await symlink(outside, join(root, 'linked'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'dependency.js'), 'dependency');
  const provider = await FilesystemContextProvider.create(root);
  assert.deepEqual(await provider.search('SECRET dependency', { limit: 10 }), []);
});
