import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CitationManifest } from '../src/citations/contract.ts';
import { DEFAULT_SOURCE_PATH, buildManifest, extractSource, readPageImages } from '../src/citations/manifest.ts';
import { type IndexDeps, type VectorReplacement, indexDocument } from '../src/mastra/indexing.ts';
import { EMBED_BATCH_SIZE } from '../src/mastra/lib/gateway.ts';

const source = await extractSource(DEFAULT_SOURCE_PATH);
const images = await readPageImages(source.pages.length);
const manifest: CitationManifest = buildManifest(source, images);

// 40-char excerpts yield well over one embed batch, so indexing must span several.
const multiBatchManifest: CitationManifest = buildManifest(source, images, 40);

type Recorded = {
  calls: string[];
  batches: number[];
  replacements: VectorReplacement[];
  published: CitationManifest[];
};

function harness(
  overrides: Partial<IndexDeps> = {},
  indexed: CitationManifest = manifest,
): { deps: IndexDeps; recorded: Recorded } {
  const recorded: Recorded = { calls: [], batches: [], replacements: [], published: [] };
  let embedded = 0;
  const deps: IndexDeps = {
    fits: () => false,
    verify: async () => {
      recorded.calls.push('verify');
      return indexed;
    },
    embed: async (texts) => {
      recorded.calls.push('embed');
      recorded.batches.push(texts.length);
      // Each vector encodes its global position so reordering across batches is detectable.
      return texts.map(() => [embedded++]);
    },
    replaceVectors: async (replacement) => {
      recorded.calls.push('replaceVectors');
      recorded.replacements.push(replacement);
    },
    publish: async (published) => {
      recorded.calls.push('publish');
      recorded.published.push(published);
      return published;
    },
    ...overrides,
  };
  return { deps, recorded };
}

test('a successful index publishes only after the vectors are in place', async () => {
  const { deps, recorded } = harness();
  const result = await indexDocument(DEFAULT_SOURCE_PATH, deps);

  assert.deepEqual(recorded.calls, ['verify', 'embed', 'replaceVectors', 'publish']);
  assert.ok(recorded.calls.indexOf('publish') > recorded.calls.indexOf('replaceVectors'));
  assert.deepEqual(result, {
    version: manifest.source.version,
    documentId: manifest.source.documentId,
    indexedCitations: manifest.citations.length,
  });
});

test('a failed embed leaves the previously published document answerable', async () => {
  const { deps, recorded } = harness({
    embed: async () => {
      recorded.calls.push('embed');
      throw new Error('embedding provider unavailable');
    },
  });

  await assert.rejects(indexDocument(DEFAULT_SOURCE_PATH, deps), /embedding provider unavailable/);
  assert.ok(!recorded.calls.includes('publish'), 'publish must not run after an embed failure');
  assert.ok(!recorded.calls.includes('replaceVectors'), 'vectors must not be replaced after an embed failure');
});

test('a failed vector replacement leaves the previously published document answerable', async () => {
  const { deps, recorded } = harness({
    replaceVectors: async () => {
      recorded.calls.push('replaceVectors');
      throw new Error('vector store rejected the transaction');
    },
  });

  await assert.rejects(indexDocument(DEFAULT_SOURCE_PATH, deps), /vector store rejected the transaction/);
  assert.ok(!recorded.calls.includes('publish'), 'publish must not run after an upsert failure');
});

test('a failed verification never reaches embedding, replacement, or publication', async () => {
  const { deps, recorded } = harness({
    verify: async () => {
      recorded.calls.push('verify');
      throw new Error('excerpt_not_in_source');
    },
  });

  await assert.rejects(indexDocument(DEFAULT_SOURCE_PATH, deps), /excerpt_not_in_source/);
  assert.deepEqual(recorded.calls, ['verify']);
});

test('vectors are keyed by citation id and scoped to the document being replaced', async () => {
  const { deps, recorded } = harness();
  await indexDocument(DEFAULT_SOURCE_PATH, deps);

  const [replacement] = recorded.replacements;
  assert.equal(replacement.documentId, manifest.source.documentId);
  assert.deepEqual(replacement.ids, manifest.citations.map((citation) => citation.id));
  assert.equal(replacement.vectors.length, manifest.citations.length);
  assert.equal(replacement.metadata.length, manifest.citations.length);
  assert.deepEqual(
    replacement.metadata.map((entry) => entry.version),
    manifest.citations.map((citation) => citation.version),
  );
});

test('a manifest larger than one batch is embedded in order across batches', async () => {
  assert.ok(multiBatchManifest.citations.length > EMBED_BATCH_SIZE, 'fixture must exceed one batch');
  const { deps, recorded } = harness({}, multiBatchManifest);
  const result = await indexDocument(DEFAULT_SOURCE_PATH, deps);

  const total = multiBatchManifest.citations.length;
  const expectedBatches = [];
  for (let remaining = total; remaining > 0; remaining -= EMBED_BATCH_SIZE) {
    expectedBatches.push(Math.min(EMBED_BATCH_SIZE, remaining));
  }
  assert.deepEqual(recorded.batches, expectedBatches);
  assert.equal(result.indexedCitations, total);

  const [replacement] = recorded.replacements;
  assert.equal(replacement.vectors.length, total);
  assert.deepEqual(
    replacement.vectors.map((entry) => entry[0]),
    Array.from({ length: total }, (_, position) => position),
  );
  assert.deepEqual(replacement.ids, multiBatchManifest.citations.map((citation) => citation.id));
});

test('a failure in a later batch prevents vector replacement and publication', async () => {
  const { deps, recorded } = harness({}, multiBatchManifest);
  const failing: IndexDeps = {
    ...deps,
    embed: async (texts) => {
      recorded.calls.push('embed');
      recorded.batches.push(texts.length);
      if (recorded.batches.length > 1) throw new Error('embedding provider died mid-corpus');
      return texts.map(() => [0]);
    },
  };

  await assert.rejects(indexDocument(DEFAULT_SOURCE_PATH, failing), /died mid-corpus/);
  assert.equal(recorded.batches.length, 2, 'failure must occur on the second batch');
  assert.ok(!recorded.calls.includes('replaceVectors'), 'vectors must not be replaced');
  assert.ok(!recorded.calls.includes('publish'), 'publish must not run');
});

test('the published manifest is exactly the one the vectors were built from', async () => {
  const { deps, recorded } = harness();
  await indexDocument(DEFAULT_SOURCE_PATH, deps);

  assert.equal(recorded.published.length, 1);
  assert.deepEqual(recorded.published[0], manifest);
});

test('a document that fits the retrieval budget is published without being embedded', async () => {
  const { deps, recorded } = harness({ fits: () => true });
  const result = await indexDocument(DEFAULT_SOURCE_PATH, deps);

  assert.deepEqual(recorded.calls, ['verify', 'publish'], 'a whole-fitting document needs no vectors');
  assert.equal(result.indexedCitations, 0);
  assert.deepEqual(recorded.published.map((entry) => entry.source.version), [manifest.source.version]);
});

test('a document over the budget is still embedded and indexed before publication', async () => {
  const { deps, recorded } = harness();
  await indexDocument(DEFAULT_SOURCE_PATH, deps);

  assert.ok(recorded.calls.includes('embed'), 'an oversized document must still be embedded');
  assert.ok(recorded.calls.indexOf('publish') > recorded.calls.indexOf('replaceVectors'));
});
