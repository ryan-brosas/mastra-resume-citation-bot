import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DEFAULT_SOURCE_PATH, extractSource, pageImagePath } from '../src/citations/manifest.ts';
import { PdfSourceError, decodeEntities, parseBboxLayout, pngSize } from '../src/citations/pdf-source.ts';

const scratch = await mkdtemp(join(tmpdir(), 'pdf-citation-source-'));
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'accepted';
  } catch (error) {
    assert.ok(error instanceof PdfSourceError, String(error));
    return error.code;
  }
}

test('the five XML entities and numeric references decode', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), `a & b <c> "d" 'e'`);
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeEntities('nothing to decode'), 'nothing to decode');
});

test('an unsupported entity fails closed rather than corrupting a verbatim excerpt', () => {
  assert.equal(codeOf(() => decodeEntities('hard&nbsp;space')), 'unsupported_entity');
  assert.equal(codeOf(() => decodeEntities('&#x110000;')), 'invalid_entity');
});

test('bbox layout parses pages, lines, and word boxes', () => {
  const xml = [
    '<page width="612.000000" height="792.000000">',
    '<line xMin="10" yMin="20" xMax="90" yMax="30">',
    '<word xMin="10" yMin="20" xMax="40" yMax="30">Hello</word>',
    '<word xMin="50" yMin="20" xMax="90" yMax="30">world&amp;co</word>',
    '</line></page>',
  ].join('');

  const [page] = parseBboxLayout(xml);
  assert.ok(page !== undefined);
  assert.equal(page.page, 1);
  assert.equal(page.widthPoints, 612);
  assert.equal(page.text, 'Hello world&co');
  assert.equal(page.lines[0]?.words.length, 2);
});

test('a layout with no pages or an invalid page size is rejected', () => {
  assert.equal(codeOf(() => parseBboxLayout('<html></html>')), 'no_pages');
  assert.equal(codeOf(() => parseBboxLayout('<page width="0.000000" height="792.000000"></page>')), 'invalid_page_size');
});

test('png dimensions are read from the header', async () => {
  const data = await readFile(pageImagePath(1));
  assert.deepEqual(pngSize(data), { width: 1224, height: 1584 });
  assert.equal(codeOf(() => pngSize(new Uint8Array(8))), 'invalid_png');
});

test('extracting a file that is not a PDF fails with a controlled code', async () => {
  const notPdf = join(scratch, 'not-a.pdf');
  await writeFile(notPdf, 'this is plainly not a pdf');

  await assert.rejects(
    extractSource(notPdf),
    (error: unknown) => error instanceof PdfSourceError && error.code === 'extract_failed',
  );
});

test('the real document still extracts with page geometry', async () => {
  const source = await extractSource(DEFAULT_SOURCE_PATH);
  assert.equal(source.pages.length, 3);
  for (const page of source.pages) {
    assert.ok(page.widthPoints > 0 && page.heightPoints > 0);
    assert.ok(page.lines.length > 0);
    assert.ok(page.text.length > 0);
  }
});
