import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CitationManifest } from '../src/citations/contract.ts';
import { DEFAULT_SOURCE_PATH, buildManifest, extractSource, mergeRects, readPageImages } from '../src/citations/manifest.ts';
import {
  AnswerError,
  claimContext,
  isSearchable,
  plainText,
  answeredCitation,
  type AnswerDeps,
  MAX_HISTORY_TURNS,
  MAX_QUESTION_CHARS,
  NO_EVIDENCE_ANSWER,
  answerWithCitations,
} from '../src/mastra/boundary.ts';

const source = await extractSource(DEFAULT_SOURCE_PATH);
const images = await readPageImages(source.pages.length);
const manifest: CitationManifest = buildManifest(source, images);
const [first, second, third] = manifest.citations;

function deps(overrides: Partial<AnswerDeps> = {}): AnswerDeps {
  return {
    standalone: async () => 'rewritten standalone question',
    manifest: async () => manifest,
    retrieve: async () => [first, second],
    generate: async () => `Alpha [[${first.id}]].`,
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    assert.ok(error instanceof AnswerError);
    return error.code;
  }
}

const NONSENSE = 'zebra xylophone quokka marzipan';
const area = (rects: readonly { width: number; height: number }[]) =>
  rects.reduce((total, rect) => total + rect.width * rect.height, 0);

test('a highlight narrows to the fragments the answer actually echoes', () => {
  const citation = manifest.citations.find((candidate) => candidate.spans.length >= 6);
  assert.ok(citation !== undefined, 'the fixture needs a multi-fragment citation');

  const echoed = citation.spans[2];
  assert.ok(echoed !== undefined);

  const narrowed = answeredCitation(citation, echoed.text).rects;
  const whole = answeredCitation(citation, NONSENSE).rects;

  assert.ok(narrowed.length > 0, 'an echoed fragment must still be highlighted');
  assert.ok(area(narrowed) < area(whole), 'the highlight must cover less than the whole chunk');
});

test('a highlight falls back to the whole quote rather than guessing when nothing matches', () => {
  const [citation] = manifest.citations;
  assert.ok(citation !== undefined);

  assert.deepEqual(
    answeredCitation(citation, NONSENSE).rects,
    mergeRects(citation.spans.map((span) => span.rect)),
  );
});

test('an answered citation exposes narrowed rects and no internal fields', async () => {
  const result = await answerWithCitations('What did Ryan build?', [], deps({
    generate: async () => `${first.spans[0]!.text} [[${first.id}]].`,
  }));

  const [cited] = result.citations;
  assert.ok(cited !== undefined);
  assert.deepEqual(Object.keys(cited).sort(), ['excerpt', 'id', 'label', 'page', 'quote', 'rects']);
  assert.ok(cited.rects.length > 0);
});

test('the quote is the part of the excerpt the claim used, and stays verbatim within it', async () => {
  const wide = manifest.citations.find((candidate) => candidate.spans.filter(contentful).length >= 4);
  assert.ok(wide !== undefined);
  const fragment = wide.spans.filter(contentful)[0];
  assert.ok(fragment !== undefined);

  const result = await answerWithCitations('What does it say?', [], deps({
    retrieve: async () => [wide],
    generate: async () => `${fragment.text} [[${wide.id}]].`,
  }));

  const [cited] = result.citations;
  assert.ok(cited !== undefined);
  assert.ok(cited.quote.length < cited.excerpt.length, 'the quote must be narrower than the whole chunk');
  for (const part of cited.quote.split(' … ')) {
    assert.ok(cited.excerpt.includes(part), `quoted run "${part.slice(0, 40)}" must be verbatim in the citation`);
  }

  // Fragments the claim never touched must not survive into the quote.
  const unrelated = wide.spans.filter(
    (span) => contentful(span) && !cited.quote.includes(span.text) && span.text !== fragment.text,
  );
  assert.ok(unrelated.length > 0, 'the fixture must contain fragments the claim did not use');
  for (const span of unrelated) {
    assert.ok(!cited.quote.includes(span.text), `unrelated line leaked: "${span.text.slice(0, 40)}"`);
  }
  assert.equal(cited.excerpt, wide.excerpt, 'the full citation is still reported unchanged');
});

test('the quote is the whole excerpt when nothing narrows', async () => {
  const [citation] = manifest.citations;
  assert.ok(citation !== undefined);

  const result = await answerWithCitations('What does it say?', [], deps({
    retrieve: async () => [citation],
    generate: async () => `Zebra xylophone quokka marzipan [[${citation.id}]].`,
  }));

  assert.equal(result.citations[0]?.quote, citation.excerpt);
});

test('a claim context keeps only the sentences carrying that citation marker', () => {
  const answer = 'Alpha happened here [1]. Beta happened elsewhere [2]. Gamma is unmarked.';

  assert.equal(claimContext(answer, 1), 'Alpha happened here [1].');
  assert.equal(claimContext(answer, 2), 'Beta happened elsewhere [2].');
  // A marker that never appears must not silently narrow to nothing.
  assert.equal(claimContext(answer, 3), answer);
});

test('a marker placed after the full stop stays attached to its own claim', () => {
  // The observed model style: the citation trails the sentence it supports.
  const answer = 'Ryan raised campaign quality using data. [1] He also trained a new QA. [2]';

  assert.equal(claimContext(answer, 1), 'Ryan raised campaign quality using data. [1]');
  assert.equal(claimContext(answer, 2), 'He also trained a new QA. [2]');
});

function contentful(span: { text: string }): boolean {
  return (span.text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 4).length >= 3;
}

test('one claim cannot widen another citation highlight', async () => {
  const wide = manifest.citations.find((candidate) => candidate.spans.filter(contentful).length >= 4);
  assert.ok(wide !== undefined, 'the fixture needs a citation with several content-bearing fragments');

  const other = manifest.citations.find((candidate) => candidate.id !== wide.id);
  assert.ok(other !== undefined, 'the second claim must belong to a different citation');

  const rich = wide.spans.filter(contentful);
  const mine = rich[0];
  const theirs = rich[rich.length - 1];
  assert.ok(mine !== undefined && theirs !== undefined && mine.text !== theirs.text);

  // Matching against both claims must cover more than matching against this citation's claim alone.
  const bothClaims = area(answeredCitation(wide, `${mine.text} ${theirs.text}`).rects);
  const ownClaim = area(answeredCitation(wide, mine.text).rects);
  assert.ok(ownClaim < bothClaims, 'the fixture must distinguish the two claims');

  const result = await answerWithCitations('What does it say?', [], deps({
    retrieve: async () => [wide, other],
    generate: async () => `${mine.text} [[${wide.id}]]. ${theirs.text} [[${other.id}]].`,
  }));

  const cited = result.citations.find((candidate) => candidate.id === wide.id);
  assert.ok(cited !== undefined);
  assert.equal(area(cited.rects), ownClaim, 'the highlight must reflect only this citation own claim');
  assert.ok(area(cited.rects) < bothClaims);
});

test('page geometry comes from the same manifest that produced the citations', async () => {
  const result = await answerWithCitations('What does it say?', [], deps({
    generate: async () => `Alpha [[${first.id}]]. Beta [[${second.id}]].`,
  }));

  const citedPages = [...new Set(result.citations.map((citation) => citation.page))].sort();
  assert.deepEqual(result.pages.map((page) => page.page).sort(), citedPages);

  for (const page of result.pages) {
    const source = manifest.source.pages.find((candidate) => candidate.page === page.page);
    assert.ok(source !== undefined);
    assert.equal(page.widthPoints, source.widthPoints);
    assert.equal(page.heightPoints, source.heightPoints);
  }
});

test('a no-evidence answer reports no pages', async () => {
  const result = await answerWithCitations('Who won the 1998 World Cup?', [], deps({ retrieve: async () => [] }));
  assert.deepEqual(result.pages, []);
  assert.deepEqual(result.citations, []);
});

test('an empty or oversized question is rejected before any retrieval', async () => {
  let retrieved = false;
  const spy = deps({ retrieve: async () => { retrieved = true; return []; } });

  assert.equal(await codeOf(answerWithCitations('   ', [], spy)), 'invalid_question');
  assert.equal(await codeOf(answerWithCitations('x'.repeat(MAX_QUESTION_CHARS + 1), [], spy)), 'invalid_question');
  assert.equal(retrieved, false);
});

test('an untrusted manifest surfaces as a controlled manifest_unavailable error', async () => {
  const failing = deps({ manifest: async () => { throw new Error('excerpt_not_in_source'); } });
  assert.equal(await codeOf(answerWithCitations('What did Ryan build?', [], failing)), 'manifest_unavailable');
});

test('retrieval and model failures surface as distinct controlled errors', async () => {
  const retrievalDown = deps({ retrieve: async () => { throw new Error('libsql down'); } });
  assert.equal(await codeOf(answerWithCitations('What did Ryan build?', [], retrievalDown)), 'retrieval_failed');

  const modelDown = deps({ generate: async () => { throw new Error('429'); } });
  assert.equal(await codeOf(answerWithCitations('What did Ryan build?', [], modelDown)), 'model_failed');
});

test('zero evidence returns a stated limitation and no citations, without calling the model', async () => {
  let generated = false;
  const result = await answerWithCitations('Who won the 1998 World Cup?', [], deps({
    retrieve: async () => [],
    generate: async () => { generated = true; return 'anything'; },
  }));

  assert.equal(result.answer, NO_EVIDENCE_ANSWER);
  assert.deepEqual(result.citations, []);
  assert.equal(result.version, manifest.source.version);
  assert.equal(generated, false);
});

test('a grounded answer returns renumbered markers and resolved citations', async () => {
  const result = await answerWithCitations('What did Ryan build?', [], deps({
    generate: async () => `Alpha [[${first.id}]]. Beta [[${second.id}]].`,
  }));

  assert.equal(result.answer, 'Alpha [1]. Beta [2].');
  assert.deepEqual(result.citations.map((citation) => citation.id), [first.id, second.id]);
});

test('an uncited model claim is replaced with the controlled no-evidence answer', async () => {
  const result = await answerWithCitations('What does Ryan do?', [], deps({
    generate: async () => 'Ryan is a neurosurgeon.',
  }));

  assert.equal(result.answer, NO_EVIDENCE_ANSWER);
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.pages, []);
});

test('a markerless line cannot borrow a citation from a later line', async () => {
  const result = await answerWithCitations('What did Ryan build?', [], deps({
    generate: async () => `- Ryan is a neurosurgeon
- Built the supported thing [[${first.id}]]`,
  }));

  assert.equal(result.answer, '- Built the supported thing [1]');
  assert.deepEqual(result.citations.map((citation) => citation.id), [first.id]);
});

test('a fabricated citation id never reaches the caller', async () => {
  const result = await answerWithCitations('What did Ryan build?', [], deps({
    generate: async () => `Real [[${first.id}]]. Fake [[${manifest.source.documentId}.p1.c9999]].`,
  }));

  assert.equal(result.answer, 'Real [1].');
  assert.deepEqual(result.citations.map((citation) => citation.id), [first.id]);
});

test('a real citation the model was never shown never reaches the caller', async () => {
  const result = await answerWithCitations('What did Ryan build?', [], deps({
    generate: async () => `Shown [[${first.id}]]. Unshown [[${third.id}]].`,
  }));

  assert.equal(result.answer, 'Shown [1].');
  assert.deepEqual(result.citations.map((citation) => citation.id), [first.id]);
  assert.ok(!result.answer.includes(third.id));
});

test('model-authored reader-style markers are stripped instead of passing as citations', async () => {
  const result = await answerWithCitations('What did Ryan build?', [], deps({
    generate: async () => `Alpha [1]. Beta [2,3]. Gamma [[${first.id}]].`,
  }));

  assert.equal(result.answer, 'Gamma [1].');
  assert.deepEqual(result.citations.map((citation) => citation.id), [first.id]);
});

test('a follow-up is resolved against the conversation before retrieval', async () => {
  const searched: string[] = [];
  let rewritePrompt = '';

  await answerWithCitations(
    'what else?',
    [{ question: 'What did he do at Brainforge?', answer: 'He built automations.' }],
    deps({
      standalone: async (prompt) => {
        rewritePrompt = prompt;
        return 'What else did Ryan do at Brainforge?';
      },
      retrieve: async (query) => {
        searched.push(query);
        return [first];
      },
    }),
  );

  assert.deepEqual(searched, ['What else did Ryan do at Brainforge?'], 'retrieval must use the resolved question');
  assert.match(rewritePrompt, /Brainforge/, 'the rewrite must see the earlier turn');
  assert.match(rewritePrompt, /what else\?/);
});

test('a first question is retrieved as asked, with no rewrite', async () => {
  const searched: string[] = [];
  let rewrites = 0;

  await answerWithCitations('Where has Ryan worked?', [], deps({
    standalone: async () => {
      rewrites += 1;
      return 'unused';
    },
    retrieve: async (query) => {
      searched.push(query);
      return [first];
    },
  }));

  assert.equal(rewrites, 0, 'nothing to resolve against on the first turn');
  assert.deepEqual(searched, ['Where has Ryan worked?']);
});

test('an unusable rewrite falls back to a question that can stand on its own', async () => {
  for (const rewritten of ['', '   ', 'x'.repeat(MAX_QUESTION_CHARS + 1)]) {
    const searched: string[] = [];
    await answerWithCitations('and at Samsung?', [{ question: 'q', answer: 'a' }], deps({
      standalone: async () => rewritten,
      retrieve: async (query) => {
        searched.push(query);
        return [first];
      },
    }));
    assert.deepEqual(searched, ['and at Samsung?'], 'an empty or oversized rewrite must not be used');
  }
});

test('only the most recent exchanges reach the prompt', async () => {
  const long = Array.from({ length: 20 }, (_, index) => ({ question: 'q' + index, answer: 'a' + index }));
  let prompt = '';

  await answerWithCitations('what else?', long, deps({
    standalone: async (value) => {
      prompt = value;
      return 'resolved';
    },
  }));

  assert.match(prompt, /q19/, 'the newest turn must be present');
  assert.doesNotMatch(prompt, /\bq13\b/, 'only the most recent turns should survive');
  assert.equal(MAX_HISTORY_TURNS, 6);
});

test('a citation stripped by figure grounding is not listed as a source', async () => {
  const [alpha] = manifest.citations;
  assert.ok(alpha !== undefined);
  const beta = manifest.citations.find((candidate) => candidate.page !== alpha.page);
  assert.ok(beta !== undefined, 'the fixture needs citations on different pages');

  const result = await answerWithCitations('What does it say?', [], deps({
    retrieve: async () => [alpha, beta],
    // The first claim invents a figure; the second quotes its passage faithfully.
    generate: async () =>
      `He managed 4242 engineers. [[${alpha.id}]] ${beta.spans[0]!.text} [[${beta.id}]]`,
  }));

  assert.deepEqual(result.unsupported, ['4242']);
  assert.equal(result.citations.length, 1, 'only the surviving citation may be listed');
  assert.equal(result.citations[0]?.id, beta.id);

  // The survivor is renumbered so the reader never sees a gap or a source without a marker.
  assert.match(result.answer, /\[1\]/);
  assert.doesNotMatch(result.answer, /\[2\]/);
  // The unevidenced claim is dropped entirely: a sentence with no surviving validated citation
  // must not reach the reader, even if the model originally attached a marker to it.
  assert.doesNotMatch(result.answer, /He managed 4242 engineers/);

  assert.deepEqual(result.pages.map((page) => page.page), [beta.page], 'pages follow the compacted set');
});

test('grounding that strips every citation leaves no sources at all', async () => {
  const [alpha] = manifest.citations;
  assert.ok(alpha !== undefined);

  const result = await answerWithCitations('What does it say?', [], deps({
    retrieve: async () => [alpha],
    generate: async () => `Revenue grew by 9999 percent. [[${alpha.id}]]`,
  }));

  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.pages, []);
  assert.deepEqual(result.unsupported, ['9999']);
  assert.doesNotMatch(result.answer, /\[\d+\]/);
});

test('a rewrite that fails degrades to the question when it can stand alone', async () => {
  const searched: string[] = [];

  const result = await answerWithCitations('and at Samsung?', [{ question: 'q', answer: 'a' }], deps({
    standalone: async () => { throw new Error('gateway /chat/completions timed out'); },
    retrieve: async (query) => { searched.push(query); return [first]; },
    generate: async () => `Something grounded. [[${first.id}]]`,
  }));

  assert.deepEqual(searched, ['and at Samsung?'], 'retrieval must still run, on the raw question');
  assert.equal(result.answer, 'Something grounded. [1]');
});

test('a never-settling rewrite is abandoned at the deadline instead of hanging', async () => {
  const searched: string[] = [];
  const started = Date.now();

  const result = await answerWithCitations('and what about Samsung?', [{ question: 'q', answer: 'a' }], deps({
    deadlineMs: 25,
    standalone: () => new Promise<string>(() => {}),
    retrieve: async (query) => { searched.push(query); return [first]; },
    generate: async () => `Something grounded. [[${first.id}]]`,
  }));

  assert.ok(Date.now() - started < 2000, 'the request must not wait on a dependency that never settles');
  assert.deepEqual(searched, ['and what about Samsung?']);
  assert.equal(result.answer, 'Something grounded. [1]');
});

test('a contentless follow-up that cannot be resolved is refused, not answered from anything nearby', async () => {
  let retrieved = 0;

  for (const standalone of [
    () => new Promise<string>(() => {}),
    async () => { throw new Error('gateway timed out'); },
    async () => '',
  ]) {
    const code = await codeOf(
      answerWithCitations('what else?', [{ question: 'q', answer: 'a' }], deps({
        deadlineMs: 25,
        standalone,
        retrieve: async () => { retrieved += 1; return [first]; },
      })),
    );

    assert.equal(code, 'unresolved_followup');
  }

  assert.equal(retrieved, 0, 'a question with nothing to search on must never reach retrieval');
});

test('a question is searchable only when it carries a word it is about', () => {
  for (const contentless of ['what else?', 'and then?', 'tell me more', 'what about that', 'anything else']) {
    assert.equal(isSearchable(contentless), false, JSON.stringify(contentless) + ' has nothing to retrieve on');
  }
  for (const searchable of ['and at Samsung?', 'what else at Brainforge?', 'more about the QA role']) {
    assert.equal(isSearchable(searchable), true, JSON.stringify(searchable) + ' can stand alone');
  }
});

test('emphasis syntax is removed rather than shown as literal asterisks', () => {
  assert.equal(plainText('The **Outsourcing Manager** role. [1]'), 'The Outsourcing Manager role. [1]');
  assert.equal(plainText('__Samsung__ and **Brainforge**'), 'Samsung and Brainforge');
  assert.equal(plainText('a * b * c'), 'a * b * c', 'lone asterisks are left alone');
  assert.equal(plainText('2 ** 3 is exponent'), '2 ** 3 is exponent', 'nothing to emphasise stays put');
});

test('a rewrite that resolved nothing is refused rather than searched on', async () => {
  let retrieved = 0;

  // Each of these is a rewrite that came back nonempty but no more searchable than the question.
  for (const echoed of ['what else?', 'What else?', 'tell me more', 'and then?']) {
    const code = await codeOf(
      answerWithCitations('what else?', [{ question: 'q', answer: 'a' }], deps({
        standalone: async () => echoed,
        retrieve: async () => { retrieved += 1; return [first]; },
      })),
    );

    assert.equal(code, 'unresolved_followup', JSON.stringify(echoed) + ' resolved nothing');
  }

  assert.equal(retrieved, 0, 'an unresolved follow-up must never reach retrieval');
});

test('a rewrite that resolves the follow-up is still used', async () => {
  const searched: string[] = [];

  await answerWithCitations('what else?', [{ question: 'What did he do at Brainforge?', answer: 'GTM work.' }], deps({
    standalone: async () => 'What else did he do at Brainforge?',
    retrieve: async (query) => { searched.push(query); return [first]; },
    generate: async () => 'Something grounded.',
  }));

  assert.deepEqual(searched, ['What else did he do at Brainforge?']);
});

test('a continuation is not searchable merely because its words are uncommon', () => {
  // Every one of these is a request to carry on, carrying nothing to retrieve on.
  for (const continuation of [
    'continue',
    'go on',
    'keep going',
    'go on then',
    'and continue',
    'elaborate',
    'expand on that',
    'tell me the rest',
    'proceed',
  ]) {
    assert.equal(isSearchable(continuation), false, JSON.stringify(continuation) + ' resolves nothing on its own');
  }
});

test('a continuation word does not make a real question unsearchable', () => {
  for (const question of [
    'did he keep the Samsung role?',
    'go on about Brainforge',
    'what did he continue at Demicreation?',
  ]) {
    assert.equal(isSearchable(question), true, JSON.stringify(question) + ' names something to retrieve');
  }
});
