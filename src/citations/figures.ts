/**
 * Retrieval proves a passage is real; it does not prove a sentence follows from it. A model can cite
 * a genuine excerpt and still invent the figure in front of it, which is the most damaging kind of
 * fabrication in a résumé answer. Numbers are checkable without a second model call, so they are.
 */

const MARKER = /\[\d+\]/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

function digitsOf(text: string): string[] {
  return [...text.matchAll(NUMBER)].map((match) => match[0].replace(/,/g, '').replace(/\.0+$/, ''));
}

/**
 * Splits an answer into claims. A claim ends at a sentence boundary or a trailing marker, but never
 * between adjacent markers such as "[1] [2]", which rest on one claim. Both figure grounding and
 * highlight scoping depend on this agreeing, so it is owned here rather than restated.
 */
export function claims(text: string): string[] {
  return text
    .split(/(?<=\[\d+\])\s+(?!\[\d+\])|(?<=[.!?])\s+(?!\[\d+\])/)
    .filter((part) => part.trim() !== '');
}

export type Grounding = Readonly<{ text: string; unsupported: readonly string[] }>;

/**
 * Any figure in a cited sentence must appear in the passages that sentence cites. When it does not,
 * the markers are removed so the claim is no longer presented as evidenced.
 */
export function groundFigures(text: string, excerptsFor: (position: number) => string | undefined): Grounding {
  const unsupported: string[] = [];

  const grounded = claims(text).map((claim) => {
    const positions = [...claim.matchAll(MARKER)].map((match) => Number(match[0].slice(1, -1)));
    if (positions.length === 0) return claim;

    const allowed = new Set(positions.flatMap((position) => digitsOf(excerptsFor(position) ?? '')));
    const stated = digitsOf(claim.replace(MARKER, ' '));
    const missing = stated.filter((value) => !allowed.has(value));
    if (missing.length === 0) return claim;

    for (const value of missing) if (!unsupported.includes(value)) unsupported.push(value);
    return claim.replace(MARKER, '').replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  });

  return { text: grounded.join(' ').replace(/\s{2,}/g, ' ').trim(), unsupported };
}
