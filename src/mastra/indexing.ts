import { type CitationManifest } from '../citations/contract.ts';
import { publishManifest, verifiedManifest } from '../citations/trust.ts';
import { EMBED_BATCH_SIZE, embedTexts } from './lib/gateway.ts';
import { EMBEDDING_DIMENSION } from './lib/models.ts';
import { fitsWhole } from './lib/retrieval.ts';
import { CITATION_INDEX_NAME, vectorStore } from './lib/vector-store.ts';

export type IndexResult = Readonly<{ version: string; documentId: string; indexedCitations: number }>;

export type VectorReplacement = Readonly<{
  documentId: string;
  version: string;
  ids: readonly string[];
  vectors: readonly number[][];
  metadata: readonly Record<string, unknown>[];
}>;

export type IndexDeps = Readonly<{
  /** A seam, so the oversized path can be exercised against a real manifest. */
  fits: (manifest: CitationManifest) => boolean;
  verify: (sourcePath: string) => Promise<CitationManifest>;
  embed: (texts: readonly string[]) => Promise<number[][]>;
  stageVectors: (replacement: VectorReplacement) => Promise<void>;
  publish: (manifest: CitationManifest) => Promise<unknown>;
  retireVectors: (documentId: string, activeVersion?: string) => Promise<void>;
}>;

const liveIndexDeps: IndexDeps = {
  fits: fitsWhole,
  verify: verifiedManifest,
  embed: embedTexts,
  stageVectors: async ({ ids, vectors, metadata }) => {
    const indexes = await vectorStore.listIndexes();
    if (!indexes.includes(CITATION_INDEX_NAME)) {
      await vectorStore.createIndex({
        indexName: CITATION_INDEX_NAME,
        dimension: EMBEDDING_DIMENSION,
        metric: 'cosine',
      });
    }

    await vectorStore.upsert({
      indexName: CITATION_INDEX_NAME,
      vectors: [...vectors],
      ids: [...ids],
      metadata: [...metadata],
    });
  },
  publish: publishManifest,
  retireVectors: async (documentId, activeVersion) => {
    const filter = activeVersion === undefined
      ? { documentId }
      : { $and: [{ documentId }, { version: { $ne: activeVersion } }] };
    await vectorStore.deleteVectors({ indexName: CITATION_INDEX_NAME, filter });
  },
};

let activationTail = Promise.resolve();

/** One activation at a time, so a later build cannot be retired by an earlier build's cleanup. */
export async function indexDocument(sourcePath: string, deps: IndexDeps = liveIndexDeps): Promise<IndexResult> {
  const previous = activationTail;
  let releaseNext: (() => void) | undefined;
  activationTail = new Promise<void>((resolve) => { releaseNext = resolve; });
  await previous;
  try {
    return await activateDocument(sourcePath, deps);
  } finally {
    releaseNext?.();
  }
}

/** Stage vectors under the new version, publish to activate them, then retire older versions. */
async function activateDocument(sourcePath: string, deps: IndexDeps): Promise<IndexResult> {
  const manifest = await deps.verify(sourcePath);
  const { documentId, version } = manifest.source;

  /**
   * A document that fits the retrieval budget is answered whole, so vectors for it could never be
   * queried. Embedding it would buy nothing and would make publication depend on the gateway.
   */
  if (deps.fits(manifest)) {
    await deps.publish(manifest);
    await deps.retireVectors(documentId).catch(() => undefined);
    return { version, documentId, indexedCitations: 0 };
  }

  const vectors: number[][] = [];
  for (let offset = 0; offset < manifest.citations.length; offset += EMBED_BATCH_SIZE) {
    const batch = manifest.citations.slice(offset, offset + EMBED_BATCH_SIZE);
    vectors.push(...(await deps.embed(batch.map((citation) => citation.excerpt))));
  }

  await deps.stageVectors({
    documentId,
    version,
    ids: manifest.citations.map((citation) => `${version}:${citation.id}`),
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
  await deps.retireVectors(documentId, version).catch(() => undefined);

  return { version, documentId, indexedCitations: manifest.citations.length };
}
