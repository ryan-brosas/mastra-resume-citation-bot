import { createInterface } from 'node:readline/promises';
import { type CitationManifest } from '../src/citations/contract.ts';
import { DEFAULT_SOURCE_PATH } from '../src/citations/manifest.ts';
import { ManifestTrustError, trustedManifest } from '../src/citations/trust.ts';
import { AnswerError, type Exchange, answerWithCitations } from '../src/mastra/boundary.ts';
import { indexDocument } from '../src/mastra/indexing.ts';
import { fitsWhole } from '../src/mastra/lib/retrieval.ts';
import { CITATION_INDEX_NAME, vectorStore } from '../src/mastra/lib/vector-store.ts';

const EXCERPT_PREVIEW_CHARS = 240;

function describe(error: unknown): string {
  if (error instanceof ManifestTrustError) return `citation manifest unusable (${error.code})`;
  if (error instanceof AnswerError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

function fail(reason: string): never {
  process.stderr.write(`ask: ${reason}\n`);
  process.exit(1);
}

/** Indexing and the manifest must agree before any question is accepted. */
async function prepare(): Promise<CitationManifest> {
  const published = await trustedManifest().then(
    (manifest) => manifest,
    () => undefined,
  );

  // A document that fits the retrieval budget is answered whole, so it needs no index to be usable.
  if (published !== undefined) {
    if (fitsWhole(published)) return published;
    if ((await vectorStore.listIndexes()).includes(CITATION_INDEX_NAME)) return published;
  }

  process.stdout.write('Indexing the document…\n');
  await indexDocument(DEFAULT_SOURCE_PATH);
  return trustedManifest();
}

const manifest = await prepare().catch((error: unknown) =>
  fail(`could not prepare the document — ${describe(error)}`),
);

function render(result: Awaited<ReturnType<typeof answerWithCitations>>): void {
  process.stdout.write(`\n${result.answer}\n\n`);

  if (result.citations.length === 0) {
    process.stdout.write('  no citations — nothing in the document supports an answer\n\n');
    return;
  }

  result.citations.forEach((citation, position) => {
    const quote =
      citation.quote.length > EXCERPT_PREVIEW_CHARS
        ? `${citation.quote.slice(0, EXCERPT_PREVIEW_CHARS)}…`
        : citation.quote;
    process.stdout.write(`  [${position + 1}] page ${citation.page}  ·  ${citation.id}\n      ${quote}\n\n`);
  });
}

// One-shot mode: a question on the command line answers and exits, for scripting and smoke checks.
const asked = process.argv[2]?.trim();
if (asked !== undefined && asked !== '') {
  try {
    render(await answerWithCitations(asked));
  } catch (error) {
    fail(describe(error));
  }
  process.exit(0);
}

process.stdout.write(
  `\n${manifest.source.title} — ${manifest.source.sourcePath}, ` +
    `${manifest.source.pageCount} pages, ${manifest.citations.length} citations\n` +
    'Ask a question. Type "exit" or press Ctrl+C to quit.\n\n',
);

const history: Exchange[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

// On EOF, readline closes without settling a pending question; aborting turns that into a clean exit.
const closed = new AbortController();
rl.on('close', () => closed.abort());

for (;;) {
  let question: string;
  try {
    question = (await rl.question('> ', { signal: closed.signal })).trim();
  } catch {
    break;
  }

  if (question === '') continue;
  if (question.toLowerCase() === 'exit' || question.toLowerCase() === 'quit') break;

  try {
    const result = await answerWithCitations(question, history);
    render(result);
    // A follow-up in the loop should resolve against what was already asked.
    history.push({ question, answer: result.answer });
    if (history.length > 6) history.shift();
  } catch (error) {
    process.stdout.write(`\n  failed: ${describe(error)}\n\n`);
  }
}

rl.close();
