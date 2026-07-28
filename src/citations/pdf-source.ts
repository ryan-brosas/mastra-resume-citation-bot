import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const RENDER_DPI = 144;

export type WordBox = Readonly<{
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}>;

export type SourceLine = Readonly<{
  words: readonly WordBox[];
  top: number;
  bottom: number;
  height: number;
  text: string;
}>;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * Poppler emits a <line> per styled run, so a single visual line arrives as several fragments.
 * Regrouping by baseline gives true reading order, which keeps every excerpt a contiguous substring
 * of the page text and lets vertical gaps expose the document's real structure.
 */
function toVisualLines(words: readonly WordBox[]): SourceLine[] {
  if (words.length === 0) return [];

  const tolerance = median(words.map((word) => word.yMax - word.yMin)) * 0.5;
  const ordered = [...words].sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);

  const groups: WordBox[][] = [];
  for (const word of ordered) {
    const current = groups[groups.length - 1];
    if (current !== undefined && Math.abs((current[0] as WordBox).yMin - word.yMin) <= tolerance) {
      current.push(word);
      continue;
    }
    groups.push([word]);
  }

  return groups.map((group) => {
    const sorted = [...group].sort((a, b) => a.xMin - b.xMin);
    const top = Math.min(...sorted.map((word) => word.yMin));
    const bottom = Math.max(...sorted.map((word) => word.yMax));
    return {
      words: sorted,
      top,
      bottom,
      height: bottom - top,
      text: sorted.map((word) => word.text).join(' '),
    };
  });
}

export type SourcePage = Readonly<{
  page: number;
  widthPoints: number;
  heightPoints: number;
  lines: readonly SourceLine[];
  /** Words joined by single spaces, so every citation excerpt is a substring by construction. */
  text: string;
}>;

/** PNG IHDR carries width and height in the first 24 bytes; no decoder needed. */
export function pngSize(data: Uint8Array): { width: number; height: number } {
  if (data.length < 24) throw new PdfSourceError('invalid_png');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export type PdfSource = Readonly<{
  sha256: string;
  sourcePath: string;
  title: string;
  pages: readonly SourcePage[];
}>;

export class PdfSourceError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'PdfSourceError';
    this.code = code;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Unknown entities fail closed rather than silently corrupting an excerpt that must stay verbatim. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new PdfSourceError('invalid_entity', match);
      }
      return String.fromCodePoint(codePoint);
    }
    const decoded = NAMED_ENTITIES[body];
    if (decoded === undefined) throw new PdfSourceError('unsupported_entity', match);
    return decoded;
  });
}

const PAGE_PATTERN = /<page width="(-?[\d.]+)" height="(-?[\d.]+)">([\s\S]*?)<\/page>/g;
const LINE_PATTERN = /<line[^>]*>([\s\S]*?)<\/line>/g;
const WORD_PATTERN =
  /<word xMin="(-?[\d.]+)" yMin="(-?[\d.]+)" xMax="(-?[\d.]+)" yMax="(-?[\d.]+)">([\s\S]*?)<\/word>/g;

function parseWords(lineXml: string): WordBox[] {
  const words: WordBox[] = [];
  for (const match of lineXml.matchAll(WORD_PATTERN)) {
    const text = decodeEntities(match[5] as string).trim();
    if (text === '') continue;
    words.push({
      text,
      xMin: Number(match[1]),
      yMin: Number(match[2]),
      xMax: Number(match[3]),
      yMax: Number(match[4]),
    });
  }
  return words;
}

export function parseBboxLayout(xml: string): SourcePage[] {
  const pages: SourcePage[] = [];

  for (const pageMatch of xml.matchAll(PAGE_PATTERN)) {
    const widthPoints = Number(pageMatch[1]);
    const heightPoints = Number(pageMatch[2]);
    if (!Number.isFinite(widthPoints) || !Number.isFinite(heightPoints) || widthPoints <= 0 || heightPoints <= 0) {
      throw new PdfSourceError('invalid_page_size');
    }

    const words: WordBox[] = [];
    for (const lineMatch of (pageMatch[3] as string).matchAll(LINE_PATTERN)) {
      words.push(...parseWords(lineMatch[1] as string));
    }

    const lines = toVisualLines(words);
    pages.push({
      page: pages.length + 1,
      widthPoints,
      heightPoints,
      lines,
      text: lines.map((line) => line.text).join(' '),
    });
  }

  if (pages.length === 0) throw new PdfSourceError('no_pages');
  return pages;
}

async function readTitle(path: string): Promise<string> {
  const { stdout } = await run('pdfinfo', [path]);
  const declared = /^Title:\s*(.+)$/m.exec(stdout)?.[1]?.trim();
  return declared === undefined || declared === '' ? basename(path, '.pdf') : declared;
}

export async function extractPdfSource(path: string, sourcePath: string, sha256: string): Promise<PdfSource> {
  const scratch = await mkdtemp(join(tmpdir(), 'pdf-citation-bbox-'));
  try {
    const output = join(scratch, 'layout.xhtml');
    let xml: string;
    let title: string;
    try {
      // -cropbox must match the renderer below: otherwise coordinates and pixels use different
      // origins on any PDF whose CropBox differs from its MediaBox, and highlights land wrong.
      await run('pdftotext', ['-bbox-layout', '-cropbox', path, output]);
      xml = await readFile(output, 'utf8');
      title = await readTitle(path);
    } catch {
      throw new PdfSourceError('extract_failed', path);
    }
    return { sha256, sourcePath, title, pages: parseBboxLayout(xml) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Page images are rendered at a fixed DPI so stored geometry stays comparable across rebuilds. */
export async function renderPage(path: string, page: number, destinationPrefix: string): Promise<void> {
  await run('pdftoppm', [
    '-png',
    '-r',
    String(RENDER_DPI),
    '-f',
    String(page),
    '-l',
    String(page),
    '-cropbox',
    path,
    destinationPrefix,
  ]);
}
