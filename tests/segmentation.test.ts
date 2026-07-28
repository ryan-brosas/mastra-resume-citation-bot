import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifest, isPageEdge, segmentPage } from '../src/citations/manifest.ts';
import type { PdfSource, SourceLine, SourcePage } from '../src/citations/pdf-source.ts';

const PAGE_HEIGHT = 792;

/** Hand-built pages, so the oracle is the intended rule rather than the function under test. */
function line(text: string, top: number, height = 10): SourceLine {
  const words = text.split(' ').map((word, index) => ({
    text: word,
    xMin: 50 + index * 30,
    xMax: 50 + index * 30 + 25,
    yMin: top,
    yMax: top + height,
  }));
  return { words, top, bottom: top + height, height, text };
}

function page(lines: SourceLine[], pageNumber = 1): SourcePage {
  return {
    page: pageNumber,
    widthPoints: 612,
    heightPoints: PAGE_HEIGHT,
    lines,
    text: lines.map((entry) => entry.text).join(' '),
  };
}

const texts = (segments: SourceLine[][]) => segments.map((segment) => segment.map((l) => l.text).join(' '));

test('a wide vertical gap breaks a segment', () => {
  const subject = page([
    line('alpha body line one', 100),
    line('alpha body line two', 112),
    line('alpha body line three', 124),
    line('beta entry begins here', 200),
    line('beta continues on', 212),
  ]);

  assert.deepEqual(texts(segmentPage(subject)), [
    'alpha body line one alpha body line two alpha body line three',
    'beta entry begins here beta continues on',
  ]);
});

test('a change in text height breaks a segment even without a gap', () => {
  const subject = page([
    line('body text at normal size', 100),
    line('body text continues here', 112),
    line('MUCH BIGGER HEADING TEXT', 124, 18),
    line('and its body underneath', 144),
  ]);

  const segments = texts(segmentPage(subject));
  assert.ok(segments.length >= 2, 'a size change must start a new segment');
  assert.equal(segments[0], 'body text at normal size body text continues here');
});

test('a lone heading merges into the entry it introduces', () => {
  const subject = page([
    line('08 Quality Assurance Specialist', 100, 14),
    line('Bluelogic Solutions Inc. Sep 2018 - Aug 2019', 116),
    line('Trained a new QA from scratch using data.', 128),
  ]);

  assert.deepEqual(texts(segmentPage(subject)), [
    '08 Quality Assurance Specialist Bluelogic Solutions Inc. Sep 2018 - Aug 2019 Trained a new QA from scratch using data.',
  ]);
});

test('a short standalone entry does not swallow the next entry across a section gap', () => {
  // Enough tightly-set lines that the median gap reflects normal leading rather than the section break.
  const subject = page([
    line('Short entry stands alone', 100),
    line('A completely separate later entry', 300),
    line('with its own body text here', 312),
    line('and a third line of body', 324),
    line('and a fourth line of body', 336),
  ]);

  assert.deepEqual(texts(segmentPage(subject)), [
    'Short entry stands alone',
    'A completely separate later entry with its own body text here and a third line of body and a fourth line of body',
  ]);
});

test('page-edge detection distinguishes margins from body', () => {
  const subject = page([line('body', 400)]);
  assert.equal(isPageEdge([line('footer', PAGE_HEIGHT - 20)], subject), true);
  assert.equal(isPageEdge([line('header', 10)], subject), true);
  assert.equal(isPageEdge([line('body', 400)], subject), false);
});

function twoPageSource(pages: SourcePage[]): PdfSource {
  return { sha256: 'a'.repeat(64), sourcePath: 'documents/sample.pdf', title: 'fixture', pages };
}

const noImages = [
  { page: 1, sha256: 'b'.repeat(64), width: 0, height: 0 },
  { page: 2, sha256: 'c'.repeat(64), width: 0, height: 0 },
];

test('a repeated page-edge footer is dropped from citations', () => {
  const footer = 'Ryan Jose Brosas linkedin.com';
  const body = (which: string) => [
    line(`page ${which} body content here`, 300),
    line('second line of body content', 312),
    line('third line of body content', 324),
  ];
  const source = twoPageSource([
    page([...body('one'), line(`${footer} 01 / 02`, PAGE_HEIGHT - 20)], 1),
    page([...body('two'), line(`${footer} 02 / 02`, PAGE_HEIGHT - 20)], 2),
  ]);

  const excerpts = buildManifest(source, noImages).citations.map((citation) => citation.excerpt);
  assert.ok(excerpts.some((text) => text.includes('page one body content')));
  assert.ok(!excerpts.some((text) => text.includes('linkedin.com')), 'running footer must not be citable');
});

test('body text repeated on every page is still citable', () => {
  const repeated = 'This exact paragraph appears in the body of both pages verbatim';
  const source = twoPageSource([
    page([line(repeated, 300), line('shared second line', 312), line('page one tail', 400), line('tail two', 412), line('tail three', 424)], 1),
    page([line(repeated, 300), line('shared second line', 312), line('page two tail', 400), line('tail two', 412), line('tail three', 424)], 2),
  ]);

  const excerpts = buildManifest(source, noImages).citations.map((citation) => citation.excerpt);
  const matches = excerpts.filter((text) => text.includes('This exact paragraph'));
  assert.equal(matches.length, 2, 'repeated body content must survive on both pages');
});
