import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trustedManifest } from '../src/citations/trust.ts';
import { fitsWhole, retrieveEvidence } from '../src/mastra/lib/retrieval.ts';

const manifest = await trustedManifest();

// The selection branch is about size alone, so it is reached by measuring a real manifest against a
// tiny budget. A padded manifest would be the wrong fixture: its excerpts could not survive
// verification against the source, so it could never exist at runtime.
const TINY_BUDGET = 10;

test('the résumé fits whole, which is why it is not selected from', () => {
  assert.equal(fitsWhole(manifest), true);
  assert.equal(fitsWhole(manifest, TINY_BUDGET), false);
});

test('a document that fits returns every citation in document order, without searching', async () => {
  let searches = 0;
  const evidence = await retrieveEvidence('which role lasted the longest?', manifest, {
    search: async () => {
      searches += 1;
      return [];
    },
  });

  assert.equal(searches, 0, 'a document that fits must not be narrowed by similarity');
  assert.equal(evidence.length, manifest.citations.length, 'every citation must reach the model');
  assert.deepEqual(
    evidence.map(({ citation }) => citation.id),
    manifest.citations.map((citation) => citation.id),
    'evidence must arrive in manifest order, since comparing entries depends on it',
  );
});

test('every page is represented, so a comparison cannot miss an entry', async () => {
  const evidence = await retrieveEvidence('anything', manifest, { search: async () => [] });
  const pages = [...new Set(evidence.map(({ citation }) => citation.page))].sort((a, b) => a - b);

  assert.deepEqual(pages, [...new Set(manifest.citations.map((c) => c.page))].sort((a, b) => a - b));
});

test('a document over the budget falls back to bounded similarity selection', async () => {
  const asked: { query: string; topK: number }[] = [];

  const evidence = await retrieveEvidence('samsung', manifest, {
    budget: TINY_BUDGET,
    search: async (query, _manifest, topK) => {
      asked.push({ query, topK });
      return manifest.citations.slice(0, 3).map((citation) => citation.id as string);
    },
  });

  assert.deepEqual(asked, [{ query: 'samsung', topK: 6 }], 'the query and bound must reach the index unchanged');
  assert.equal(evidence.length, 3, 'only the selected citations are used');
  assert.ok(evidence.length < manifest.citations.length, 'selection must actually narrow');
});

test('a similarity hit that is not in the manifest is dropped, never invented', async () => {
  const real = manifest.citations[0]!.id as string;

  const evidence = await retrieveEvidence('anything', manifest, {
    budget: TINY_BUDGET,
    search: async () => ['doc-deadbeef.p9.c99', real, 'not-an-id-at-all'],
  });

  assert.deepEqual(evidence.map(({ citation }) => citation.id), [real], 'only manifest-resolvable ids survive');
});
