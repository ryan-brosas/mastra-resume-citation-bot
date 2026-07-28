import { type Citation, type CitationManifest, findCitation } from '../../citations/contract.ts';
import { embedTexts } from './gateway.ts';
import { CITATION_INDEX_NAME, vectorStore } from './vector-store.ts';

export type Evidence = Readonly<{ citation: Citation }>;

/**
 * Similarity search exists to make a corpus fit, not because a subset is desirable. A short document
 * fits whole, and selecting from it can only lose evidence — which is how a question like "which role
 * lasted longest" gets answered from six of eight roles. Above the budget, selection resumes.
 */
export const CONTEXT_BUDGET_CHARS = 24000;

export function fitsWhole(manifest: CitationManifest, budget: number = CONTEXT_BUDGET_CHARS): boolean {
  return manifest.citations.reduce((total, citation) => total + citation.excerpt.length, 0) <= budget;
}

/** Returns candidate citation ids only: resolution stays in one place, below. */
export type SimilaritySearch = (
  query: string,
  manifest: CitationManifest,
  topK: number,
) => Promise<readonly string[]>;

/** `budget` is overridable so the selection branch can be exercised with a real manifest. */
export type RetrievalOptions = Readonly<{ topK?: number; search?: SimilaritySearch; budget?: number }>;

const searchIndex: SimilaritySearch = async (query, manifest, topK) => {
  const [vector] = await embedTexts([query]);
  const results = await vectorStore.query({
    indexName: CITATION_INDEX_NAME,
    queryVector: vector as number[],
    topK,
    filter: { version: manifest.source.version },
  });

  return results.map((result) => result.metadata?.citationId).filter((id): id is string => typeof id === 'string');
};

/** Retrieved ids are resolved through the manifest, so similarity metadata can never invent a citation. */
export async function retrieveEvidence(
  query: string,
  manifest: CitationManifest,
  options: RetrievalOptions = {},
): Promise<readonly Evidence[]> {
  const { topK = 6, search = searchIndex, budget = CONTEXT_BUDGET_CHARS } = options;

  // Document order, not relevance order: comparing entries needs them in the order they were written.
  if (fitsWhole(manifest, budget)) return manifest.citations.map((citation) => ({ citation }));

  const evidence: Evidence[] = [];
  for (const id of await search(query, manifest, topK)) {
    const citation = findCitation(manifest, id);
    if (!citation.ok) continue;
    evidence.push({ citation: citation.value });
  }
  return evidence;
}
