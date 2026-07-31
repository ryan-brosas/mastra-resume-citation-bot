import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  MANIFEST_SCHEMA_VERSION,
  type Citation,
  type CitationManifest,
  type CitationSpan,
  type NormalizedRect,
  type PageDigest,
  citationIdFor,
  documentIdFor,
  normalizeText,
  normalizedWordBounds,
  sha256Hex,
  versionFor,
} from './contract.ts';
import {
  RENDER_DPI,
  type PdfSource,
  type SourceLine,
  type SourcePage,
  type WordBox,
  extractPdfSource,
  pngSize,
} from './pdf-source.ts';

export const MAX_EXCERPT_CHARS = 480;

/**
 * Neither `import.meta.url` nor the working directory is reliable here: `mastra build` relocates this
 * module into `.mastra/output`, and the dev server chdirs into `src/mastra/public`. So walk up to the
 * nearest directory that actually looks like this project.
 */
function findProjectRoot(): string {
  const override = process.env.PDF_CITATION_ROOT;
  if (override !== undefined && override !== '') return resolve(override);

  let directory = process.cwd();
  for (;;) {
    if (existsSync(resolve(directory, 'package.json')) && existsSync(resolve(directory, 'src/citations'))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot();
export const MANIFEST_PATH = resolve(PROJECT_ROOT, 'src/citations/generated/manifest.v1.json');
export const PAGES_DIR = resolve(PROJECT_ROOT, 'src/citations/generated/pages');
export const DEFAULT_SOURCE_PATH = resolve(PROJECT_ROOT, 'documents/sample.pdf');

export type PageImage = Readonly<{ page: number; sha256: string; width: number; height: number }>;

export function resolveSourcePath(sourcePath: string): string {
  return resolve(PROJECT_ROOT, sourcePath);
}

export function pageImageName(page: number): string {
  return `page-${String(page).padStart(2, '0')}.png`;
}

export function pageImagePath(page: number): string {
  return resolve(PAGES_DIR, pageImageName(page));
}

export async function readPageImages(pageCount: number, directory = PAGES_DIR): Promise<PageImage[]> {
  const images: PageImage[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const data = await readFile(resolve(directory, pageImageName(page)));
    images.push({ page, sha256: sha256Hex(data), ...pngSize(data) });
  }
  return images;
}

export async function extractSource(path: string): Promise<PdfSource> {
  const absolute = resolve(path);
  const sha256 = sha256Hex(await readFile(absolute));
  return extractPdfSource(absolute, relativeToRoot(absolute), sha256);
}

function relativeToRoot(absolute: string): string {
  const prefix = `${PROJECT_ROOT}/`;
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
}

type Unit = CitationSpan;

/** Words closer than this share a highlight box; wider gaps are column breaks worth preserving. */
const MERGE_GAP = 0.015;

function verticallyAligned(a: NormalizedRect, b: NormalizedRect): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap >= 0.5 * Math.min(a.height, b.height);
}

/**
 * Poppler emits one line per word for much of this layout, which would highlight a passage as dozens
 * of disconnected boxes. Merge only along a shared baseline and across small gaps, so columns and
 * separate lines stay distinct.
 */
export function mergeRects(rects: readonly NormalizedRect[]): NormalizedRect[] {
  const ordered = [...rects].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
  const merged: NormalizedRect[] = [];

  for (const rect of ordered) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      verticallyAligned(previous, rect) &&
      rect.x <= previous.x + previous.width + MERGE_GAP
    ) {
      const x = Math.min(previous.x, rect.x);
      const y = Math.min(previous.y, rect.y);
      merged[merged.length - 1] = {
        x,
        y,
        width: Math.max(previous.x + previous.width, rect.x + rect.width) - x,
        height: Math.max(previous.y + previous.height, rect.y + rect.height) - y,
      };
      continue;
    }
    merged.push(rect);
  }

  return merged;
}

/** A heading shorter than this is folded into the entry beneath it rather than cited on its own. */
const HEADING_CHARS = 64;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * Splits a page where it visually breaks — a wider-than-usual vertical gap or a change in text size —
 * so a citation is one entry rather than a fixed character count running across two of them.
 */
type Segment = { lines: SourceLine[]; gapBefore: number };

export function segmentPage(page: SourcePage): SourceLine[][] {
  const lines = page.lines;
  if (lines.length === 0) return [];

  const gaps: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    gaps.push(Math.max(0, (lines[index] as SourceLine).top - (lines[index - 1] as SourceLine).bottom));
  }
  const medianGap = median(gaps);
  const breakGap = Math.max(medianGap * 1.8, 2);

  const segments: Segment[] = [{ lines: [lines[0] as SourceLine], gapBefore: 0 }];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as SourceLine;
    const previous = lines[index - 1] as SourceLine;
    const gap = Math.max(0, line.top - previous.bottom);
    const sizeShift = Math.abs(line.height - previous.height) / Math.max(line.height, previous.height, 1e-6);

    if (gap > breakGap || sizeShift > 0.35) segments.push({ lines: [line], gapBefore: gap });
    else (segments[segments.length - 1] as Segment).lines.push(line);
  }

  /**
   * A heading is one short line sitting tight above what it introduces — usually broken off by a size
   * change rather than a wide gap. Requiring both keeps a short standalone entry from swallowing the
   * next one just because it happens to be brief.
   */
  const sectionGap = Math.max(medianGap * 3, breakGap);
  const merged: Segment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const isLoneHeading =
      previous !== undefined &&
      previous.lines.length === 1 &&
      (previous.lines[0] as SourceLine).text.length < HEADING_CHARS &&
      segment.gapBefore <= sectionGap;

    if (isLoneHeading) {
      (previous as Segment).lines.push(...segment.lines);
      continue;
    }
    merged.push({ lines: [...segment.lines], gapBefore: segment.gapBefore });
  }

  return merged.map((segment) => segment.lines);
}

/** Running furniture lives in the page margins; repeated body text does not. */
export function isPageEdge(segment: readonly SourceLine[], page: SourcePage): boolean {
  if (segment.length === 0) return false;
  const top = Math.min(...segment.map((line) => line.top));
  const bottom = Math.max(...segment.map((line) => line.bottom));
  return top <= page.heightPoints * 0.12 || bottom >= page.heightPoints * 0.88;
}

/** One unit per visual line, split further only when a single line exceeds the excerpt bound. */
export function segmentUnits(segment: readonly SourceLine[], page: SourcePage, maxChars: number): Unit[] {
  const units: Unit[] = [];

  for (const line of segment) {
    let start = 0;
    while (start < line.words.length) {
      let end = start;
      let length = 0;
      while (end < line.words.length) {
        const word = line.words[end] as WordBox;
        const projected = length === 0 ? word.text.length : length + 1 + word.text.length;
        if (length > 0 && projected > maxChars) break;
        length = projected;
        end += 1;
      }

      const slice = line.words.slice(start, end);
      units.push({ text: slice.map((word) => word.text).join(' '), rect: normalizedWordBounds(slice, page) });
      start = end;
    }
  }

  return units;
}

export function packUnits(units: readonly Unit[], maxChars: number): Unit[][] {
  const chunks: Unit[][] = [];
  let index = 0;

  while (index < units.length) {
    const current: Unit[] = [];
    let length = 0;
    let cursor = index;

    while (cursor < units.length) {
      const unit = units[cursor] as Unit;
      const projected = length === 0 ? unit.text.length : length + 1 + unit.text.length;
      if (length > 0 && projected > maxChars) break;
      current.push(unit);
      length = projected;
      cursor += 1;
    }

    chunks.push(current);
    if (cursor >= units.length) break;
    // No overlap: segments are already coherent, so repeating a line would cite it twice.
    index = cursor;
  }

  return chunks;
}

/** Page numbers differ, so compare running text with digits and punctuation removed. */
function boilerplateKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

/**
 * A running header or footer appears on every page and answers nothing. Left in, it becomes a
 * citation that competes with real content for retrieval slots.
 */
function runningText(segmentsByPage: readonly (readonly string[])[]): ReadonlySet<string> {
  if (segmentsByPage.length < 2) return new Set();

  const pagesSeen = new Map<string, Set<number>>();
  segmentsByPage.forEach((segments, index) => {
    for (const text of segments) {
      const key = boilerplateKey(text);
      if (key === '') continue;
      const seen = pagesSeen.get(key) ?? new Set<number>();
      seen.add(index);
      pagesSeen.set(key, seen);
    }
  });


  const running = new Set<string>();
  for (const [key, pages] of pagesSeen) {
    if (pages.size === segmentsByPage.length) running.add(key);
  }
  return running;
}

function labelFor(excerpt: string, page: number): string {
  const head = excerpt.length <= 72 ? excerpt : `${excerpt.slice(0, 71).trimEnd()}…`;
  return `p.${page} — ${head}`;
}

export function buildManifest(
  source: PdfSource,
  images: readonly PageImage[],
  maxExcerptChars = MAX_EXCERPT_CHARS,
): CitationManifest {
  const documentId = documentIdFor(source.sha256);
  const provisionalVersion = versionFor(source.sha256);
  const pages: PageDigest[] = [];
  const citations: Citation[] = [];

  // Only margin segments are eligible: body text that legitimately repeats must survive.
  const segmentsByPage = source.pages.map((page) =>
    segmentPage(page)
      .filter((segment) => isPageEdge(segment, page))
      .map((segment) => segment.map((line) => line.text).join(' ')),
  );
  const running = runningText(segmentsByPage);

  for (const page of source.pages) {
    const image = images.find((candidate) => candidate.page === page.page);
    pages.push({
      page: page.page,
      textSha256: sha256Hex(normalizeText(page.text)),
      widthPoints: page.widthPoints,
      heightPoints: page.heightPoints,
      imageSha256: image?.sha256 ?? '',
    });

    let ordinal = 0;
    const chunks = segmentPage(page)
      .filter(
        (segment) =>
          !(isPageEdge(segment, page) && running.has(boilerplateKey(segment.map((line) => line.text).join(' ')))),
      )
      .flatMap((segment) => packUnits(segmentUnits(segment, page, maxExcerptChars), maxExcerptChars));

    chunks.forEach((chunk) => {
      if (chunk.length === 0) return;
      ordinal += 1;
      const excerpt = chunk.map((unit) => unit.text).join(' ');
      citations.push({
        id: citationIdFor(documentId, page.page, ordinal),
        documentId,
        version: provisionalVersion,
        page: page.page,
        label: labelFor(excerpt, page.page),
        excerpt,
        spans: chunk,
      });
    });
  }

  const version = versionFor(source.sha256, citations);
  const versionedCitations = citations.map((citation) => ({ ...citation, version }));

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: {
      sha256: source.sha256,
      sourcePath: source.sourcePath,
      documentId,
      version,
      title: source.title,
      pageCount: source.pages.length,
      renderer: { tool: 'poppler', dpi: RENDER_DPI },
      pages,
    },
    citations: versionedCitations,
  };
}
