import { type Citation, type CitationManifest, findCitation } from './contract.ts';

const CITATION_MARKER = /\[\[([^\]]+)\]\]/g;
/** Reader-style markers are produced by renumbering here; any the model emits itself resolve to nothing. */
const UNSOURCED_MARKER = /\[\s*\d+(?:\s*[,-]\s*\d+)*\s*\]/g;

export type ValidatedAnswer = Readonly<{
  text: string;
  citations: readonly Citation[];
  rejected: readonly string[];
}>;

/**
 * Keeps only citations the model was actually shown and that resolve in the manifest,
 * then renumbers surviving markers to reader-facing [1], [2], … in first-use order.
 */
export function validateAnswerCitations(
  answer: string,
  manifest: CitationManifest,
  retrievedIds: ReadonlySet<string>,
): ValidatedAnswer {
  const accepted: Citation[] = [];
  const positions = new Map<string, number>();
  const rejected: string[] = [];

  const text = answer.replace(UNSOURCED_MARKER, '').replace(CITATION_MARKER, (_marker, rawId: string) => {
    const id = rawId.trim();
    const existing = positions.get(id);
    if (existing !== undefined) return `[${existing}]`;

    const resolved = findCitation(manifest, id);
    if (!resolved.ok || !retrievedIds.has(id)) {
      if (!rejected.includes(id)) rejected.push(id);
      return '';
    }

    const position = accepted.length + 1;
    positions.set(id, position);
    accepted.push(resolved.value);
    return `[${position}]`;
  });

  return {
    text: text.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim(),
    citations: accepted,
    rejected,
  };
}
