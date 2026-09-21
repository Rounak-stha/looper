import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalHash, createRunManifest } from './manifest.js';

test('configuration hashes are independent of object key order', () => {
  assert.equal(canonicalHash({ b: 2, a: { d: 4, c: 3 } }), canonicalHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('manifest sorts model identities and hashes exact config', () => {
  const manifest = createRunManifest({
    config: { selector: 'bm25' }, datasetVersion: 'v1',
    modelIds: ['strong', 'cheap'], decisionModelIds: ['decision-b'],
  });
  assert.deepEqual(manifest.modelIds, ['cheap', 'strong']);
  assert.equal(manifest.configHash.length, 64);
});

test('canonical config rejects unreproducible values', () => {
  assert.throws(() => canonicalHash({ missing: undefined }), /undefined/);
  assert.throws(() => canonicalHash({ invalid: Number.NaN }), /finite/);
});
