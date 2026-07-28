import { createHash } from 'node:crypto';

export const MANIFEST_SCHEMA_VERSION = 'pdf-citation-manifest/v3';

export type CitationId = string & { readonly __brand: 'CitationId' };
export type DocumentId = string & { readonly __brand: 'DocumentId' };
export type SourceVersion = string & { readonly __brand: 'SourceVersion' };

export type ContractErrorCode =
  | 'invalid_manifest_json'
  | 'invalid_manifest'
  | 'invalid_schema_version'
  | 'invalid_source_hash'
  | 'invalid_source_path'
  | 'invalid_document_id'
  | 'invalid_source_version'
  | 'invalid_page_count'
  | 'invalid_page_digest'
  | 'invalid_citation_id'
  | 'duplicate_citation_id'
  | 'invalid_citation_page'
  | 'invalid_citation_content'
  | 'invalid_citation_spans'
  | 'span_text_mismatch'
  | 'invalid_rectangle'
  | 'whole_page_rectangle'
  | 'invalid_renderer'
  | 'page_image_mismatch'
  | 'citation_version_mismatch'
  | 'citation_not_found'
  | 'source_hash_mismatch'
  | 'page_text_mismatch'
  | 'excerpt_not_in_source';

export type ContractError = Readonly<{ code: ContractErrorCode; detail?: string }>;

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ContractErrorCode, detail?: string): Result<T> {
  return { ok: false, error: detail === undefined ? { code } : { code, detail } };
}

export type NormalizedRect = Readonly<{ x: number; y: number; width: number; height: number }>;

export type PageDigest = Readonly<{
  page: number;
  textSha256: string;
  widthPoints: number;
  heightPoints: number;
  imageSha256: string;
}>;

export type Renderer = Readonly<{ tool: 'poppler'; dpi: number }>;

export type CitationSpan = Readonly<{ text: string; rect: NormalizedRect }>;

export type Citation = Readonly<{
  id: CitationId;
  documentId: DocumentId;
  version: SourceVersion;
  page: number;
  label: string;
  excerpt: string;
  /**
   * The excerpt broken into placed fragments. Joining their text reproduces the excerpt exactly, so
   * a sub-range of the quote can always be resolved back to the boxes that cover it.
   */
  spans: readonly CitationSpan[];
}>;

export type SourceIdentity = Readonly<{
  sha256: string;
  sourcePath: string;
  documentId: DocumentId;
  version: SourceVersion;
  title: string;
  pageCount: number;
  renderer: Renderer;
  pages: readonly PageDigest[];
}>;

export type CitationManifest = Readonly<{
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  source: SourceIdentity;
  citations: readonly Citation[];
}>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CITATION_ID_PATTERN = /^(doc-[0-9a-f]{12})\.p([1-9][0-9]*)\.c([1-9][0-9]*)$/;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function documentIdFor(sha256: string): DocumentId {
  return `doc-${sha256.slice(0, 12)}` as DocumentId;
}

export function versionFor(sha256: string): SourceVersion {
  return `sha256-${sha256.slice(0, 16)}` as SourceVersion;
}

export function citationIdFor(documentId: DocumentId, page: number, index: number): CitationId {
  return `${documentId}.p${page}.c${index}` as CitationId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isContainedRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}

function validateRect(input: unknown): Result<NormalizedRect> {
  if (!isRecord(input)) return fail('invalid_rectangle');
  const { x, y, width, height } = input;
  if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return fail('invalid_rectangle');
  }
  const rect = { x, y, width, height } as NormalizedRect;
  if (rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0) return fail('invalid_rectangle');
  if (rect.x + rect.width > 1.0001 || rect.y + rect.height > 1.0001) return fail('invalid_rectangle');
  // A whole-page box is indistinguishable from "somewhere on this page", which is not a citation.
  if (rect.x === 0 && rect.y === 0 && rect.width >= 1 && rect.height >= 1) return fail('whole_page_rectangle');
  return ok(rect);
}

function validateSource(input: unknown): Result<SourceIdentity> {
  if (!isRecord(input)) return fail('invalid_manifest');
  const { sha256, sourcePath, documentId, version, title, pageCount, pages, renderer } = input;

  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return fail('invalid_source_hash');
  if (!isContainedRelativePath(sourcePath)) return fail('invalid_source_path');
  if (documentId !== documentIdFor(sha256)) return fail('invalid_document_id');
  if (version !== versionFor(sha256)) return fail('invalid_source_version');
  if (!isNonEmptyString(title)) return fail('invalid_manifest');
  if (!isPositiveInteger(pageCount)) return fail('invalid_page_count');
  if (!Array.isArray(pages) || pages.length !== pageCount) return fail('invalid_page_count');
  if (!isRecord(renderer) || renderer.tool !== 'poppler' || !isPositiveInteger(renderer.dpi)) {
    return fail('invalid_renderer');
  }

  const digests: PageDigest[] = [];
  for (const [index, candidate] of pages.entries()) {
    if (!isRecord(candidate)) return fail('invalid_page_digest');
    if (candidate.page !== index + 1) return fail('invalid_page_digest');
    if (typeof candidate.textSha256 !== 'string' || !SHA256_PATTERN.test(candidate.textSha256)) {
      return fail('invalid_page_digest');
    }
    if (typeof candidate.imageSha256 !== 'string' || !SHA256_PATTERN.test(candidate.imageSha256)) {
      return fail('invalid_page_digest');
    }
    const { widthPoints, heightPoints } = candidate;
    if (typeof widthPoints !== 'number' || typeof heightPoints !== 'number'
      || !Number.isFinite(widthPoints) || !Number.isFinite(heightPoints)
      || widthPoints <= 0 || heightPoints <= 0) {
      return fail('invalid_page_digest');
    }
    digests.push({
      page: candidate.page,
      textSha256: candidate.textSha256,
      widthPoints,
      heightPoints,
      imageSha256: candidate.imageSha256,
    });
  }

  return ok({
    sha256,
    sourcePath,
    documentId: documentId as DocumentId,
    version: version as SourceVersion,
    title,
    pageCount,
    renderer: { tool: 'poppler', dpi: renderer.dpi },
    pages: digests,
  });
}

function validateCitation(input: unknown, source: SourceIdentity): Result<Citation> {
  if (!isRecord(input)) return fail('invalid_manifest');
  const { id, documentId, version, page, label, excerpt, spans } = input;

  if (typeof id !== 'string') return fail('invalid_citation_id');
  const parsed = CITATION_ID_PATTERN.exec(id);
  if (parsed === null) return fail('invalid_citation_id');
  if (parsed[1] !== source.documentId) return fail('invalid_citation_id');
  if (documentId !== source.documentId) return fail('invalid_citation_id');
  if (version !== source.version) return fail('citation_version_mismatch');

  if (!isPositiveInteger(page) || page > source.pageCount) return fail('invalid_citation_page');
  if (Number(parsed[2]) !== page) return fail('invalid_citation_id');

  if (!isNonEmptyString(label) || !isNonEmptyString(excerpt)) return fail('invalid_citation_content');
  if (excerpt !== normalizeText(excerpt)) return fail('invalid_citation_content');

  if (!Array.isArray(spans) || spans.length === 0) return fail('invalid_citation_spans');
  const validated: CitationSpan[] = [];
  for (const candidate of spans) {
    if (!isRecord(candidate) || !isNonEmptyString(candidate.text)) return fail('invalid_citation_spans');
    const rect = validateRect(candidate.rect);
    if (!rect.ok) return rect;
    validated.push({ text: candidate.text, rect: rect.value });
  }
  // Geometry and text cannot drift apart: the placed fragments must rebuild the quote exactly.
  if (validated.map((span) => span.text).join(' ') !== excerpt) return fail('span_text_mismatch');

  return ok({
    id: id as CitationId,
    documentId: source.documentId,
    version: source.version,
    page,
    label,
    excerpt,
    spans: validated,
  });
}

export function validateManifest(input: unknown): Result<CitationManifest> {
  if (!isRecord(input)) return fail('invalid_manifest');
  if (input.schemaVersion !== MANIFEST_SCHEMA_VERSION) return fail('invalid_schema_version');

  const source = validateSource(input.source);
  if (!source.ok) return source;

  if (!Array.isArray(input.citations) || input.citations.length === 0) return fail('invalid_manifest');

  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const candidate of input.citations) {
    const citation = validateCitation(candidate, source.value);
    if (!citation.ok) return citation;
    if (seen.has(citation.value.id)) return fail('duplicate_citation_id', citation.value.id);
    seen.add(citation.value.id);
    citations.push(citation.value);
  }

  return ok({ schemaVersion: MANIFEST_SCHEMA_VERSION, source: source.value, citations });
}

export function parseManifest(input: string): Result<CitationManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    return fail('invalid_manifest_json');
  }
  return validateManifest(parsed);
}

export function serializeManifest(manifest: CitationManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function findCitation(manifest: CitationManifest, id: string): Result<Citation> {
  const citation = manifest.citations.find((candidate) => candidate.id === id);
  return citation === undefined ? fail('citation_not_found', id) : ok(citation);
}

export type SourceSnapshot = Readonly<{
  sha256: string;
  pages: readonly { page: number; text: string; widthPoints: number; heightPoints: number }[];
}>;

export function verifyPageImages(
  manifest: CitationManifest,
  images: readonly { page: number; sha256: string; width: number; height: number }[],
): Result<CitationManifest> {
  const { dpi } = manifest.source.renderer;

  for (const digest of manifest.source.pages) {
    const image = images.find((candidate) => candidate.page === digest.page);
    if (image === undefined || image.sha256 !== digest.imageSha256) {
      return fail('page_image_mismatch', String(digest.page));
    }
    // Catches an extractor/renderer box mismatch, which would otherwise place highlights silently wrong.
    const expectedWidth = Math.round((digest.widthPoints * dpi) / 72);
    const expectedHeight = Math.round((digest.heightPoints * dpi) / 72);
    if (image.width !== expectedWidth || image.height !== expectedHeight) {
      return fail('page_image_mismatch', `${digest.page}: ${image.width}x${image.height} != ${expectedWidth}x${expectedHeight}`);
    }
  }

  return ok(manifest);
}

export function verifyAgainstSource(
  manifest: CitationManifest,
  snapshot: SourceSnapshot,
): Result<CitationManifest> {
  if (snapshot.sha256 !== manifest.source.sha256) {
    return fail('source_hash_mismatch', snapshot.sha256);
  }
  if (snapshot.pages.length !== manifest.source.pageCount) return fail('invalid_page_count');

  const normalizedPages = new Map<number, string>();
  for (const page of snapshot.pages) {
    const normalized = normalizeText(page.text);
    const digest = manifest.source.pages[page.page - 1];
    if (digest === undefined || digest.textSha256 !== sha256Hex(normalized)) {
      return fail('page_text_mismatch', String(page.page));
    }
    if (digest.widthPoints !== page.widthPoints || digest.heightPoints !== page.heightPoints) {
      return fail('invalid_page_digest', String(page.page));
    }
    normalizedPages.set(page.page, normalized);
  }

  for (const citation of manifest.citations) {
    const pageText = normalizedPages.get(citation.page);
    if (pageText === undefined || !pageText.includes(citation.excerpt)) {
      return fail('excerpt_not_in_source', citation.id);
    }
  }

  return ok(manifest);
}
