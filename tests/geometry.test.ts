import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { validateManifest, type CitationManifest } from '../src/citations/contract.ts';
import { DEFAULT_SOURCE_PATH, buildManifest, extractSource, readPageImages } from '../src/citations/manifest.ts';

const run = promisify(execFile);

const source = await extractSource(DEFAULT_SOURCE_PATH);
const images = await readPageImages(source.pages.length);
const validated = validateManifest(buildManifest(source, images));
assert.equal(validated.ok, true);
const manifest = (validated as { ok: true; value: CitationManifest }).value;

const dimensions = new Map(manifest.source.pages.map((page) => [page.page, page]));

/** Poppler selects by containment, so an exact box needs about a point of slack. */
const SLACK = 1;

async function textInBox(page: number, x: number, y: number, w: number, h: number): Promise<string> {
  const { stdout } = await run('pdftotext', [
    '-f', String(page), '-l', String(page), '-cropbox',
    '-x', String(Math.max(0, Math.round(x - SLACK))),
    '-y', String(Math.max(0, Math.round(y - SLACK))),
    '-W', String(Math.round(w + 2 * SLACK)),
    '-H', String(Math.round(h + 2 * SLACK)),
    DEFAULT_SOURCE_PATH, '-',
  ]);
  return stdout.replace(/\s+/g, ' ').trim();
}

function longestWord(excerpt: string): string | undefined {
  return excerpt
    .split(' ')
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
    .filter((word) => word.length >= 6)
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * The structural tests only prove rects are in-bounds. This proves they point at the right words:
 * text lifted from a citation's own region must contain a distinctive word from its excerpt.
 */
test('each citation region contains the text that citation quotes', async () => {
  let checked = 0;

  for (const citation of manifest.citations) {
    const marker = longestWord(citation.excerpt);
    if (marker === undefined) continue;

    const page = dimensions.get(citation.page);
    assert.ok(page !== undefined);

    const rects = citation.spans.map((span) => span.rect);
    const x = Math.min(...rects.map((rect) => rect.x)) * page.widthPoints;
    const y = Math.min(...rects.map((rect) => rect.y)) * page.heightPoints;
    const right = Math.max(...rects.map((rect) => rect.x + rect.width)) * page.widthPoints;
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height)) * page.heightPoints;

    const region = await textInBox(citation.page, x, y, right - x, bottom - y);
    assert.ok(
      region.replace(/[^A-Za-z0-9 ]/g, '').includes(marker),
      `${citation.id}: region did not contain "${marker}" — got "${region.slice(0, 120)}"`,
    );
    checked += 1;
  }

  assert.ok(checked >= manifest.citations.length - 1, 'nearly every citation must be checkable');
});

function boxOf(citation: CitationManifest['citations'][number]) {
  const page = dimensions.get(citation.page);
  assert.ok(page !== undefined);
  const rects = citation.spans.map((span) => span.rect);
  const x = Math.min(...rects.map((rect) => rect.x)) * page.widthPoints;
  const y = Math.min(...rects.map((rect) => rect.y)) * page.heightPoints;
  const right = Math.max(...rects.map((rect) => rect.x + rect.width)) * page.widthPoints;
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height)) * page.heightPoints;
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Geometry has to discriminate location, not merely land on the page. A word unique to one citation
 * must not be readable from a different, non-overlapping citation's region on the same page.
 */
test('a citation region excludes text belonging to a different region on the same page', async () => {
  let compared = 0;

  for (const subject of manifest.citations) {
    const a = boxOf(subject);

    for (const other of manifest.citations) {
      if (other.id === subject.id || other.page !== subject.page) continue;
      const b = boxOf(other);
      if (a.y + a.h > b.y && b.y + b.h > a.y) continue; // vertically overlapping: not a clean pair

      const subjectWords = new Set(subject.excerpt.split(' ').map((word) => word.replace(/[^A-Za-z0-9]/g, '')));
      const marker = other.excerpt
        .split(' ')
        .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
        .filter((word) => word.length >= 7 && !subjectWords.has(word))
        .sort((first, second) => second.length - first.length)[0];
      if (marker === undefined) continue;

      const region = (await textInBox(subject.page, a.x, a.y, a.w, a.h)).replace(/[^A-Za-z0-9 ]/g, '');
      assert.ok(!region.includes(marker), `${subject.id} leaked "${marker}" from ${other.id}`);
      compared += 1;
      break;
    }
  }

  assert.ok(compared > 0, 'the fixture must provide at least one non-overlapping pair');
});
