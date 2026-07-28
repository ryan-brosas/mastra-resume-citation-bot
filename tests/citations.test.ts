import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeText,
  parseManifest,
  serializeManifest,
  sha256Hex,
  validateManifest,
  verifyAgainstSource,
  verifyPageImages,
  type CitationManifest,
} from '../src/citations/contract.ts';
import {
  DEFAULT_SOURCE_PATH,
  MAX_EXCERPT_CHARS,
  buildManifest,
  extractSource,
  packUnits,
  segmentPage,
  segmentUnits,
  readPageImages,
} from '../src/citations/manifest.ts';
import { validateAnswerCitations } from '../src/citations/answer.ts';

const source = await extractSource(DEFAULT_SOURCE_PATH);
const images = await readPageImages(source.pages.length);
const manifest = (() => {
  const validated = validateManifest(buildManifest(source, images));
  assert.equal(validated.ok, true, 'built manifest must satisfy the contract');
  return (validated as { ok: true; value: CitationManifest }).value;
})();

function clone(): CitationManifest {
  return JSON.parse(JSON.stringify(manifest)) as CitationManifest;
}

test('every citation excerpt is verbatim source text on its own page', () => {
  const verified = verifyAgainstSource(manifest, source);
  assert.equal(verified.ok, true);

  const pages = new Map(source.pages.map((page) => [page.page, normalizeText(page.text)]));
  for (const citation of manifest.citations) {
    assert.ok(citation.excerpt.length <= MAX_EXCERPT_CHARS, `${citation.id} exceeds excerpt bound`);
    assert.ok(pages.get(citation.page)?.includes(citation.excerpt), `${citation.id} is not verbatim`);
  }
  assert.ok(manifest.citations.length > 0);
  assert.equal(manifest.source.pageCount, source.pages.length);
});

test('citation ids are stable and unique across rebuilds', () => {
  const rebuilt = buildManifest(source, images);
  assert.deepEqual(
    rebuilt.citations.map((citation) => citation.id),
    manifest.citations.map((citation) => citation.id),
  );
  assert.equal(new Set(manifest.citations.map((citation) => citation.id)).size, manifest.citations.length);
});

test('a manifest round-trips through serialization', () => {
  const reparsed = parseManifest(serializeManifest(manifest));
  assert.equal(reparsed.ok, true);
  assert.deepEqual((reparsed as { ok: true; value: CitationManifest }).value, manifest);
});

test('a different source PDF fails closed', () => {
  const drifted = { ...source, sha256: sha256Hex('some other pdf') };
  const verified = verifyAgainstSource(manifest, drifted);
  assert.equal(verified.ok, false);
  assert.equal((verified as { ok: false; error: { code: string } }).error.code, 'source_hash_mismatch');
});

test('edited page text fails closed', () => {
  const edited = {
    ...source,
    pages: source.pages.map((page) => (page.page === 1 ? { ...page, text: `${page.text} injected claim` } : page)),
  };
  const verified = verifyAgainstSource(manifest, edited);
  assert.equal(verified.ok, false);
  assert.equal((verified as { ok: false; error: { code: string } }).error.code, 'page_text_mismatch');
});

test('a tampered excerpt fails closed', () => {
  const tampered = clone() as unknown as unknown as { citations: { excerpt: string }[] };
  tampered.citations[0].excerpt = 'Ryan personally invented the transistor';
  const verified = verifyAgainstSource(tampered as unknown as CitationManifest, source);
  assert.equal(verified.ok, false);
  assert.equal((verified as { ok: false; error: { code: string } }).error.code, 'excerpt_not_in_source');
});

test('duplicate citation ids are rejected', () => {
  const duplicated = clone() as unknown as unknown as { citations: unknown[] };
  duplicated.citations = [duplicated.citations[0], duplicated.citations[0]];
  const validated = validateManifest(duplicated);
  assert.equal(validated.ok, false);
  assert.equal((validated as { ok: false; error: { code: string } }).error.code, 'duplicate_citation_id');
});

test('a citation id that disagrees with its page is rejected', () => {
  const mismatched = clone() as unknown as unknown as { citations: { page: number }[] };
  mismatched.citations[0].page = mismatched.citations[0].page === 1 ? 2 : 1;
  const validated = validateManifest(mismatched);
  assert.equal(validated.ok, false);
  assert.equal((validated as { ok: false; error: { code: string } }).error.code, 'invalid_citation_id');
});

test('an answer keeps only retrieved, resolvable citations and renumbers them', () => {
  const [first, second] = manifest.citations;
  const retrieved = new Set([first.id as string, second.id as string]);
  const validated = validateAnswerCitations(
    `Alpha [[${first.id}]]. Beta [[${second.id}]]. Alpha again [[${first.id}]].`,
    manifest,
    retrieved,
  );

  assert.equal(validated.text, 'Alpha [1]. Beta [2]. Alpha again [1].');
  assert.deepEqual(validated.citations.map((citation) => citation.id), [first.id, second.id]);
  assert.deepEqual(validated.rejected, []);
});

test('a fabricated citation id is stripped from the answer', () => {
  const [first] = manifest.citations;
  const validated = validateAnswerCitations(
    `Real claim [[${first.id}]]. Invented claim [[${manifest.source.documentId}.p1.c9999]].`,
    manifest,
    new Set([first.id as string]),
  );

  assert.equal(validated.text, 'Real claim [1]. Invented claim.');
  assert.deepEqual(validated.citations.map((citation) => citation.id), [first.id]);
  assert.deepEqual(validated.rejected, [`${manifest.source.documentId}.p1.c9999`]);
});

test('a real citation the model was never shown is stripped', () => {
  const [first, second] = manifest.citations;
  const validated = validateAnswerCitations(
    `Shown [[${first.id}]]. Unshown [[${second.id}]].`,
    manifest,
    new Set([first.id as string]),
  );

  assert.deepEqual(validated.citations.map((citation) => citation.id), [first.id]);
  assert.deepEqual(validated.rejected, [second.id]);
});

test('chunking keeps units inside the excerpt bound and preserves page order', () => {
  const page = source.pages[0];
  assert.ok(page !== undefined);

  const segments = segmentPage(page);
  assert.ok(segments.length > 1, 'a page must split into several segments');

  const first = segments[0];
  assert.ok(first !== undefined);
  assert.ok(page.text.startsWith(first.map((line) => line.text).join(' ')));

  for (const segment of segments) {
    const units = segmentUnits(segment, page, MAX_EXCERPT_CHARS);
    for (const unit of units) assert.ok(unit.text.length <= MAX_EXCERPT_CHARS);

    for (const chunk of packUnits(units, MAX_EXCERPT_CHARS)) {
      const text = chunk.map((unit) => unit.text).join(' ');
      assert.ok(text.length <= MAX_EXCERPT_CHARS);
      assert.ok(page.text.includes(text), 'each chunk must be contiguous page text');
    }
  }
});

test('a citation does not run across a visual break into the next entry', () => {
  const page = source.pages[2];
  assert.ok(page !== undefined);

  const segmentTexts = segmentPage(page).map((segment) => segment.map((line) => line.text).join(' '));
  const onPage = manifest.citations.filter((citation) => citation.page === 3);
  assert.ok(onPage.length > 0);

  // Every citation must live inside one segment rather than straddling two.
  for (const citation of onPage) {
    assert.ok(
      segmentTexts.some((segment) => segment.includes(citation.excerpt)),
      `${citation.id} spans a visual break: "${citation.excerpt.slice(0, 60)}"`,
    );
  }

  const bluelogic = onPage.find((citation) => citation.excerpt.includes('Bluelogic'));
  assert.ok(bluelogic !== undefined);
  assert.ok(!bluelogic.excerpt.includes('Samsung'), 'the Bluelogic entry must not absorb the Samsung entry');
});

test('no visual line is cited twice on a page', () => {
  for (const page of manifest.source.pages) {
    const seen = new Map<string, string>();
    for (const citation of manifest.citations.filter((candidate) => candidate.page === page.page)) {
      for (const span of citation.spans) {
        const owner = seen.get(span.text);
        assert.equal(
          owner,
          undefined,
          `"${span.text.slice(0, 40)}" is cited by both ${owner} and ${citation.id}`,
        );
        seen.set(span.text, citation.id);
      }
    }
  }
});

test('running headers and footers are not citable', () => {
  const footers = manifest.citations.filter((citation) => /\d \/ \d\s*$/.test(citation.excerpt));
  assert.deepEqual(footers, [], 'page furniture must not compete for retrieval slots');

  // The footer text still exists in the page, it is simply never offered as evidence.
  assert.ok(source.pages.every((page) => page.text.includes('linkedin.com/in/ryanjosebrosas')));
  assert.ok(!manifest.citations.some((citation) => citation.excerpt.trim().endsWith('01 / 03')));
});

test('every citation carries in-page highlight geometry', () => {
  const dimensions = new Map(manifest.source.pages.map((page) => [page.page, page]));

  for (const citation of manifest.citations) {
    assert.ok(citation.spans.length > 0, `${citation.id} has no geometry`);
    assert.ok(dimensions.has(citation.page));
    assert.equal(
      citation.spans.map((span) => span.text).join(' '),
      citation.excerpt,
      `${citation.id} spans must rebuild the excerpt`,
    );

    for (const { rect } of citation.spans) {
      assert.ok(rect.width > 0 && rect.height > 0, `${citation.id} has a degenerate rect`);
      assert.ok(rect.x >= 0 && rect.y >= 0, `${citation.id} has a negative origin`);
      assert.ok(rect.x + rect.width <= 1.0001, `${citation.id} overflows the page width`);
      assert.ok(rect.y + rect.height <= 1.0001, `${citation.id} overflows the page height`);
    }
  }
});

test('a whole-page or out-of-bounds rectangle is rejected', () => {
  const wholePage = clone() as unknown as unknown as { citations: { spans: unknown[]; excerpt: string }[] };
  wholePage.citations[0]!.spans = [{ text: wholePage.citations[0]!.excerpt, rect: { x: 0, y: 0, width: 1, height: 1 } }];
  const whole = validateManifest(wholePage);
  assert.equal(whole.ok, false);
  assert.equal((whole as { ok: false; error: { code: string } }).error.code, 'whole_page_rectangle');

  const overflowing = clone() as unknown as unknown as { citations: { spans: unknown[]; excerpt: string }[] };
  overflowing.citations[0]!.spans = [{ text: overflowing.citations[0]!.excerpt, rect: { x: 0.9, y: 0.1, width: 0.5, height: 0.02 } }];
  const overflow = validateManifest(overflowing);
  assert.equal(overflow.ok, false);
  assert.equal((overflow as { ok: false; error: { code: string } }).error.code, 'invalid_rectangle');

  const empty = clone() as unknown as unknown as { citations: { spans: unknown[] }[] };
  empty.citations[0]!.spans = [];
  const none = validateManifest(empty);
  assert.equal(none.ok, false);
  assert.equal((none as { ok: false; error: { code: string } }).error.code, 'invalid_citation_spans');
});

test('spans that no longer rebuild their excerpt are rejected', () => {
  const drifted = clone() as unknown as unknown as { citations: { excerpt: string }[] };
  drifted.citations[0]!.excerpt = `${drifted.citations[0]!.excerpt} and one more claim`;

  const validated = validateManifest(drifted);
  assert.equal(validated.ok, false);
  assert.equal((validated as { ok: false; error: { code: string } }).error.code, 'span_text_mismatch');
});

test('recorded page dimensions match the rendered images at the recorded DPI', () => {
  const verified = verifyPageImages(manifest, images);
  assert.equal(verified.ok, true);

  const { dpi } = manifest.source.renderer;
  for (const page of manifest.source.pages) {
    const image = images.find((candidate) => candidate.page === page.page);
    assert.ok(image !== undefined);
    assert.equal(image.width, Math.round((page.widthPoints * dpi) / 72), `page ${page.page} width`);
    assert.equal(image.height, Math.round((page.heightPoints * dpi) / 72), `page ${page.page} height`);
  }
});

test('a page image sized differently from its recorded points fails closed', () => {
  // This is what an extractor/renderer box mismatch looks like: right bytes, wrong coordinate space.
  const resized = images.map((image, index) => (index === 0 ? { ...image, width: image.width + 2 } : image));
  const verified = verifyPageImages(manifest, resized);

  assert.equal(verified.ok, false);
  assert.equal((verified as { ok: false; error: { code: string } }).error.code, 'page_image_mismatch');
});

test('a drifted page render fails closed', () => {
  const drifted = clone() as unknown as unknown as { source: { pages: { imageSha256: string }[] } };
  drifted.source.pages[0]!.imageSha256 = sha256Hex('a different render');
  const validated = validateManifest(drifted);
  assert.equal(validated.ok, true, 'a well-formed hash still parses');

  const verified = verifyPageImages((validated as { ok: true; value: CitationManifest }).value, images);
  assert.equal(verified.ok, false);
  assert.equal((verified as { ok: false; error: { code: string } }).error.code, 'page_image_mismatch');
});
