import {
  type Citation,
  type CitationManifest,
  type CitationSpan,
  type NormalizedRect,
} from '../citations/contract.ts';
import { mergeRects } from '../citations/manifest.ts';
import { validateAnswerCitations } from '../citations/answer.ts';
import { claims, groundFigures } from '../citations/figures.ts';
import { generateAnswer, generateStandaloneQuestion } from './lib/answer-model.ts';
import { trustedManifest } from '../citations/trust.ts';
import { type Evidence, retrieveEvidence } from './lib/retrieval.ts';

export const MAX_QUESTION_CHARS = 1000;
/** Enough conversation to resolve a follow-up, bounded so a caller cannot grow the prompt at will. */
export const MAX_HISTORY_TURNS = 6;

export type Exchange = Readonly<{ question: string; answer: string }>;
export const NO_EVIDENCE_ANSWER = 'The document does not establish an answer to that question.';

export type AnsweredCitation = Readonly<{
  id: string;
  page: number;
  label: string;
  /** The complete validated citation, always verbatim from the page. */
  excerpt: string;
  /** The part of that excerpt this claim actually drew on; equal to the excerpt when nothing narrowed. */
  quote: string;
  /** Highlight boxes covering exactly the quote. */
  rects: readonly NormalizedRect[];
}>;

export type AnsweredPage = Readonly<{ page: number; widthPoints: number; heightPoints: number }>;

export type GroundedAnswer = Readonly<{
  answer: string;
  citations: readonly AnsweredCitation[];
  /** Geometry for the cited pages, taken from the same manifest that produced the citations. */
  pages: readonly AnsweredPage[];
  /** Figures the model stated that its own cited passages do not contain. */
  unsupported: readonly string[];
  version: string;
}>;

const STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'they', 'their', 'them', 'have', 'has', 'had', 'were', 'was',
  'and', 'the', 'for', 'into', 'through', 'over', 'under', 'each', 'also', 'about', 'when', 'what',
  'which', 'while', 'would', 'could', 'should', 'been', 'being', 'than', 'then', 'there', 'here',
]);

function contentTokens(value: string): Set<string> {
  const words = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((word) => word.length >= 4 && !STOPWORDS.has(word)));
}

/**
 * A retrieved chunk can span several unrelated lines, so highlighting all of it overstates what the
 * answer used. Keep the fragments the answer echoes; if none match, fall back to the whole quote
 * rather than guessing at a narrower claim.
 */
function supportingSpans(citation: Citation, answer: string): readonly CitationSpan[] {
  const answerTokens = contentTokens(answer);

  const selected = citation.spans.filter((span) => {
    const tokens = contentTokens(span.text);
    if (tokens.size === 0) return false;
    let hits = 0;
    for (const token of tokens) if (answerTokens.has(token)) hits += 1;
    return hits / tokens.size >= 0.5;
  });

  return selected.length > 0 ? selected : citation.spans;
}

/**
 * Only the sentences carrying this citation's marker may widen its highlight. Matching against the
 * whole answer would let an unrelated claim light up spans this citation never supported.
 */
export function claimContext(answer: string, position: number): string {
  const marker = `[${position}]`;
  const carrying = claims(answer).filter((sentence) => sentence.includes(marker));
  return carrying.length > 0 ? carrying.join(' ') : answer;
}

/** Contiguous runs stay verbatim; a skipped fragment becomes an explicit ellipsis rather than a silent join. */
function quoteOf(citation: Citation, selected: readonly CitationSpan[]): string {
  const chosen = new Set(selected);
  const runs: string[] = [];
  let run: string[] = [];

  for (const span of citation.spans) {
    if (chosen.has(span)) {
      run.push(span.text);
      continue;
    }
    if (run.length > 0) {
      runs.push(run.join(' '));
      run = [];
    }
  }
  if (run.length > 0) runs.push(run.join(' '));

  return runs.join(' … ');
}

export function answeredCitation(citation: Citation, answer: string): AnsweredCitation {
  const spans = supportingSpans(citation, answer);
  return {
    id: citation.id,
    page: citation.page,
    label: citation.label,
    excerpt: citation.excerpt,
    quote: quoteOf(citation, spans),
    rects: mergeRects(spans.map((span) => span.rect)),
  };
}

export type AnswerErrorCode =
  | 'invalid_question'
  | 'unresolved_followup'
  | 'manifest_unavailable'
  | 'retrieval_failed'
  | 'model_failed';

export class AnswerError extends Error {
  readonly code: AnswerErrorCode;

  constructor(code: AnswerErrorCode) {
    super(code);
    this.name = 'AnswerError';
    this.code = code;
  }
}

/** The boundary owns this, not the transport: an injected rewrite must be bounded too. */
export const REWRITE_DEADLINE_MS = 15000;

export type AnswerDeps = Readonly<{
  /** Overridable so a never-settling rewrite can be proven bounded without waiting for the real one. */
  deadlineMs?: number;
  manifest: () => Promise<CitationManifest>;
  retrieve: (query: string, manifest: CitationManifest) => Promise<readonly Evidence[]>;
  generate: (prompt: string) => Promise<string>;
  standalone: (prompt: string) => Promise<string>;
}>;

const liveDeps: AnswerDeps = {
  manifest: () => trustedManifest(),
  retrieve: (query, manifest) => retrieveEvidence(query, manifest),
  generate: (prompt) => generateAnswer(prompt),
  standalone: (prompt) => generateStandaloneQuestion(prompt),
};

/**
 * Words a follow-up is made of rather than words it is about. A question built only from these has
 * nothing to retrieve on, so it is only answerable once resolved against the conversation.
 */
const DISCOURSE = new Set([
  'what', 'which', 'when', 'where', 'how', 'why', 'who', 'whom', 'whose',
  'else', 'more', 'other', 'others', 'another', 'anything', 'something', 'everything',
  'next', 'then', 'after', 'before', 'again', 'further', 'additional', 'detail', 'details',
  'continue', 'continued', 'go', 'going', 'keep', 'keeps', 'on', 'rest', 'elaborate', 'expand',
  'proceed', 'onward', 'onwards', 'along', 'up', 'out',
  'tell', 'give', 'show', 'list', 'about', 'info', 'information', 'there', 'here',
  'that', 'this', 'those', 'these', 'they', 'them', 'their', 'it', 'its',
  'did', 'does', 'do', 'done', 'was', 'were', 'is', 'are', 'be', 'been',
  'he', 'she', 'him', 'her', 'his', 'you', 'your', 'me', 'my', 'we', 'us',
  'can', 'could', 'would', 'should', 'please', 'ok', 'okay', 'yes', 'no',
  'and', 'the', 'for', 'any', 'all', 'some', 'much', 'many', 'also', 'too',
]);

export function isSearchable(question: string): boolean {
  const words = question.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.some((word) => !DISCOURSE.has(word));
}

/**
 * The reply is rendered as text, never as markup, so emphasis syntax would reach the reader as
 * literal asterisks. It is removed here rather than interpreted: the trust rule stays "text is text".
 */
export function plainText(answer: string): string {
  return answer
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '$1');
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rewrite deadline exceeded')), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

function transcript(history: readonly Exchange[]): string {
  return history
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`)
    .join('\n\n');
}

/**
 * "What else?" carries no searchable words, so retrieving on it returns whatever happens to be
 * nearest and the answer fills with unrelated material. Resolve it against the conversation first.
 */
async function searchQuery(
  question: string,
  history: readonly Exchange[],
  deps: AnswerDeps,
): Promise<string> {
  if (history.length === 0) return question;

  let rewritten: string;
  try {
    rewritten = (
      await withDeadline(
        deps.standalone(`${transcript(history)}\n\nLatest message: ${question}`),
        deps.deadlineMs ?? REWRITE_DEADLINE_MS,
      )
    ).trim();
  } catch {
    rewritten = '';
  }

  // A rewrite that is still unsearchable did not resolve anything: echoing "what else?" back is a
  // failure wearing the shape of a success, and must not be trusted just because it is nonempty.
  if (rewritten !== '' && rewritten.length <= MAX_QUESTION_CHARS && isSearchable(rewritten)) return rewritten;

  /**
   * Falling back is fine when the question can stand on its own. When it cannot — "what else?" has
   * no searchable words — retrieving on it returns near-arbitrary passages, so refuse instead of
   * answering from whatever happened to be nearest.
   */
  if (!isSearchable(question)) throw new AnswerError('unresolved_followup');
  return question;
}

function buildPrompt(question: string, evidence: readonly Evidence[], history: readonly Exchange[]): string {
  const context = evidence
    .map(({ citation }) => `[[${citation.id}]] (page ${citation.page}) ${citation.excerpt}`)
    .join('\n\n');
  const conversation = history.length === 0 ? '' : `Conversation so far:\n${transcript(history)}\n\n`;

  return (
    `${conversation}Answer the question using only the evidence below. Cite each supported claim with its ` +
    `[[citationId]] marker.\n\nEvidence:\n${context}\n\nQuestion: ${question}`
  );
}

/**
 * The model may only cite passages it was actually shown, and every surviving citation is
 * re-resolved through the trusted manifest before it reaches a caller.
 */
export async function answerWithCitations(
  question: string,
  history: readonly Exchange[] = [],
  deps: AnswerDeps = liveDeps,
): Promise<GroundedAnswer> {
  const trimmed = question.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QUESTION_CHARS) {
    throw new AnswerError('invalid_question');
  }

  let manifest: CitationManifest;
  try {
    manifest = await deps.manifest();
  } catch {
    throw new AnswerError('manifest_unavailable');
  }

  const query = await searchQuery(trimmed, history, deps);

  let evidence: readonly Evidence[];
  try {
    evidence = await deps.retrieve(query, manifest);
  } catch {
    throw new AnswerError('retrieval_failed');
  }

  if (evidence.length === 0) {
    return {
      answer: NO_EVIDENCE_ANSWER,
      citations: [],
      pages: [],
      unsupported: [],
      version: manifest.source.version,
    };
  }

  let generated: string;
  try {
    generated = await deps.generate(buildPrompt(trimmed, evidence, history));
  } catch {
    throw new AnswerError('model_failed');
  }

  const retrievedIds = new Set(evidence.map(({ citation }) => citation.id as string));
  const validated = validateAnswerCitations(plainText(generated), manifest, retrievedIds);

  const resolved = validated.citations;
  const { text: grounded, unsupported } = groundFigures(
    validated.text,
    (position) => resolved[position - 1]?.excerpt,
  );

  // Grounding can strip a claim's markers, leaving its citation referenced by nothing. Listing it
  // anyway would show evidence for a claim just judged unevidenced, so compact and renumber together.
  const surviving: number[] = [];
  for (const match of grounded.matchAll(/\[(\d+)\]/g)) {
    const position = Number(match[1]);
    if (resolved[position - 1] !== undefined && !surviving.includes(position)) surviving.push(position);
  }

  const renumbered = new Map(surviving.map((position, index) => [position, index + 1]));
  const text = grounded.replace(/\[(\d+)\]/g, (marker, digits: string) => {
    const next = renumbered.get(Number(digits));
    return next === undefined ? marker : `[${next}]`;
  });

  const citations = surviving.map((position, index) =>
    answeredCitation(resolved[position - 1] as Citation, claimContext(text, index + 1)),
  );
  const cited = new Set(citations.map((citation) => citation.page));

  return {
    answer: text,
    citations,
    unsupported,
    // Derived here so page geometry can never come from a manifest published after the answer.
    pages: manifest.source.pages
      .filter((page) => cited.has(page.page))
      .map(({ page, widthPoints, heightPoints }) => ({ page, widthPoints, heightPoints })),
    version: manifest.source.version,
  };
}
