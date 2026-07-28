import { type CitationManifest } from '../citations/contract.ts';
import { publishManifest, verifiedManifest } from '../citations/trust.ts';
import { EMBED_BATCH_SIZE, embedTexts } from './lib/gateway.ts';
import { EMBEDDING_DIMENSION } from './lib/models.ts';
import { fitsWhole } from './lib/retrieval.ts';
import { CITATION_INDEX_NAME, vectorStore } from './lib/vector-store.ts';

export type IndexResult = Readonly<{ version: string; documentId: string; indexedCitations: number }>;

export type VectorReplacement = Readonly<{
  documentId: string;
  ids: readonly string[];
  vectors: readonly number[][];
  metadata: readonly Record<string, unknown>[];
}>;

export type IndexDeps = Readonly<{
  /** A seam, so the oversized path can be exercised against a real manifest. */
  fits: (manifest: CitationManifest) => boolean;
  verify: (sourcePath: string) => Promise<CitationManifest>;
  embed: (texts: readonly string[]) => Promise<number[][]>;
  replaceVectors: (replacement: VectorReplacement) => Promise<void>;
  publish: (manifest: CitationManifest) => Promise<unknown>;
}>;

const liveIndexDeps: IndexDeps = {
  fits: (manifest) => fitsWhole(manifest),
  verify: (sourcePath) => verifiedManifest(sourcePath),
  embed: (texts) => embedTexts(texts),
  replaceVectors: async ({ documentId, ids, vectors, metadata }) => {
    const indexes = await vectorStore.listIndexes();
    if (!indexes.includes(CITATION_INDEX_NAME)) {
      await vectorStore.createIndex({
        indexName: CITATION_INDEX_NAME,
        dimension: EMBEDDING_DIMENSION,
        metric: 'cosine',
      });
    }

    // deleteFilter makes the removal of superseded vectors part of the insert transaction,
    // so a failure cannot leave the document with its old vectors deleted and no new ones.
    await vectorStore.upsert({
      indexName: CITATION_INDEX_NAME,
      vectors: [...vectors],
      ids: [...ids],
      metadata: [...metadata],
      deleteFilter: { documentId },
    });
  },
  publish: (manifest) => publishManifest(manifest),
};

/**
 * Publishing is what makes a manifest answerable, so it happens only after the vectors backing it
 * are in place. A failure anywhere earlier leaves the previously published document answerable.
 */
export async function indexDocument(sourcePath: string, deps: IndexDeps = liveIndexDeps): Promise<IndexResult> {
  const manifest = await deps.verify(sourcePath);
  const { documentId, version } = manifest.source;

  /**
   * A document that fits the retrieval budget is answered whole, so vectors for it could never be
   * queried. Embedding it would buy nothing and would make publication depend on the gateway.
   */
  if (deps.fits(manifest)) {
    await deps.publish(manifest);
    return { version, documentId, indexedCitations: 0 };
  }

  const vectors: number[][] = [];
  for (let offset = 0; offset < manifest.citations.length; offset += EMBED_BATCH_SIZE) {
    const batch = manifest.citations.slice(offset, offset + EMBED_BATCH_SIZE);
    vectors.push(...(await deps.embed(batch.map((citation) => citation.excerpt))));
  }

  await deps.replaceVectors({
    documentId,
    ids: manifest.citations.map((citation) => citation.id),
    vectors,
    metadata: manifest.citations.map((citation) => ({
      citationId: citation.id,
      documentId: citation.documentId,
      version: citation.version,
      page: citation.page,
      excerpt: citation.excerpt,
    })),
  });

  await deps.publish(manifest);

  return { version, documentId, indexedCitations: manifest.citations.length };
}
