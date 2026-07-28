import { existsSync, rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  type CitationManifest,
  type ContractErrorCode,
  parseManifest,
  serializeManifest,
  sha256Hex,
  validateManifest,
  verifyAgainstSource,
  verifyPageImages,
} from './contract.ts';
import {
  MANIFEST_PATH,
  PAGES_DIR,
  STAGING_PAGES_DIR,
  type PageImage,
  buildManifest,
  extractSource,
  pageImageName,
  readPageImages,
  resolveSourcePath,
} from './manifest.ts';
import { renderPage } from './pdf-source.ts';

export type ManifestTrustCode = ContractErrorCode | 'manifest_missing' | 'source_unreadable' | 'render_failed';

export class ManifestTrustError extends Error {
  readonly code: ManifestTrustCode;

  constructor(code: ManifestTrustCode) {
    super(code);
    this.name = 'ManifestTrustError';
    this.code = code;
  }
}

type CacheEntry = Readonly<{ manifestDigest: string; sourceDigest: string; manifest: CitationManifest }>;

const cache = new Map<string, CacheEntry>();

async function sourceDigestOf(resolvedPath: string): Promise<string> {
  try {
    return sha256Hex(await readFile(resolvedPath));
  } catch {
    throw new ManifestTrustError('source_unreadable');
  }
}

/** Renders into staging only. Live page assets are untouched until publication promotes them. */
async function renderPages(pdfPath: string, pageCount: number): Promise<PageImage[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'pdf-citation-render-'));
  try {
    await rm(STAGING_PAGES_DIR, { recursive: true, force: true });
    await mkdir(STAGING_PAGES_DIR, { recursive: true });
    // A build that is never published — a failed index, say — must not leave renders behind.
    discardStagedPagesOnExit();

    for (let page = 1; page <= pageCount; page += 1) {
      await renderPage(pdfPath, page, join(scratch, `p${page}`));
      const produced = (await readdir(scratch)).find((name) => name.startsWith(`p${page}-`));
      if (produced === undefined) throw new ManifestTrustError('render_failed');
      await copyFile(join(scratch, produced), resolve(STAGING_PAGES_DIR, pageImageName(page)));
    }

    return readPageImages(pageCount, STAGING_PAGES_DIR);
  } catch (error) {
    await rm(STAGING_PAGES_DIR, { recursive: true, force: true });
    throw error instanceof ManifestTrustError ? error : new ManifestTrustError('render_failed');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

let exitCleanupRegistered = false;

function discardStagedPagesOnExit(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', () => {
    // Promotion renames the directory away, so anything still here was never published.
    rmSync(STAGING_PAGES_DIR, { recursive: true, force: true });
  });
}

/** One directory rename, so readers never see a half-promoted page set. */
async function promoteStagedPages(): Promise<void> {
  const retired = `${PAGES_DIR}.retired.${process.pid}`;
  if (existsSync(PAGES_DIR)) await rename(PAGES_DIR, retired);
  await rename(STAGING_PAGES_DIR, PAGES_DIR);
  await rm(retired, { recursive: true, force: true });
}

/** The single canonical build. Verified in memory, but not yet visible to answering. */
export async function verifiedManifest(sourcePath: string): Promise<CitationManifest> {
  const extracted = await extractSource(sourcePath);
  const images = await renderPages(resolveSourcePath(extracted.sourcePath), extracted.pages.length);

  const validated = validateManifest(buildManifest(extracted, images));
  if (!validated.ok) throw new ManifestTrustError(validated.error.code);

  const verified = verifyAgainstSource(validated.value, extracted);
  if (!verified.ok) throw new ManifestTrustError(verified.error.code);

  const withImages = verifyPageImages(verified.value, images);
  if (!withImages.ok) throw new ManifestTrustError(withImages.error.code);

  return withImages.value;
}

/** Page renders are not covered by the manifest/PDF cache key, so they are re-checked on every call. */
async function verifyImages(manifest: CitationManifest, imagesDir = PAGES_DIR): Promise<CitationManifest> {
  let images: PageImage[];
  try {
    images = await readPageImages(manifest.source.pageCount, imagesDir);
  } catch {
    throw new ManifestTrustError('page_image_mismatch');
  }

  const verified = verifyPageImages(manifest, images);
  if (!verified.ok) throw new ManifestTrustError(verified.error.code);
  return verified.value;
}

async function verifyExtracted(
  manifest: CitationManifest,
  resolvedPath: string,
  imagesDir = PAGES_DIR,
): Promise<CitationManifest> {
  let extracted;
  try {
    extracted = await extractSource(resolvedPath);
  } catch {
    throw new ManifestTrustError('source_unreadable');
  }

  const verified = verifyAgainstSource(manifest, extracted);
  if (!verified.ok) throw new ManifestTrustError(verified.error.code);

  // Page images are hashed, not re-rendered: tampering is caught without paying to rasterise again.
  return verifyImages(verified.value, imagesDir);
}

/**
 * Publishing is what makes a manifest answerable, so callers that also build an index must publish
 * last. It re-validates and re-verifies independently rather than trusting its caller, and is
 * written via rename so a reader never observes a half-written manifest.
 */
export async function publishManifest(
  manifest: CitationManifest,
  manifestPath = MANIFEST_PATH,
): Promise<CitationManifest> {
  const validated = validateManifest(manifest);
  if (!validated.ok) throw new ManifestTrustError(validated.error.code);

  const resolvedSource = resolveSourcePath(validated.value.source.sourcePath);
  const staged = existsSync(STAGING_PAGES_DIR);
  const verified = await verifyExtracted(validated.value, resolvedSource, staged ? STAGING_PAGES_DIR : PAGES_DIR);
  const serialized = serializeManifest(verified);

  if (staged) await promoteStagedPages();

  await mkdir(dirname(manifestPath), { recursive: true });
  const staging = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(staging, serialized);
  await rename(staging, manifestPath);

  cache.set(manifestPath, {
    manifestDigest: sha256Hex(serialized),
    sourceDigest: verified.source.sha256,
    manifest: verified,
  });
  return verified;
}

/**
 * Schema validity is not trust: a hand-edited manifest can still be well-formed, and the PDF can be
 * swapped after a manifest was already trusted. Every call re-hashes both the manifest and its PDF;
 * a cache hit therefore means both are byte-identical to what was fully verified, and the expensive
 * text extraction is skipped only in that case.
 */
export async function trustedManifest(manifestPath = MANIFEST_PATH): Promise<CitationManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new ManifestTrustError('manifest_missing');
  }

  const parsed = parseManifest(raw);
  if (!parsed.ok) throw new ManifestTrustError(parsed.error.code);

  const resolved = resolveSourcePath(parsed.value.source.sourcePath);
  const sourceDigest = await sourceDigestOf(resolved);
  if (sourceDigest !== parsed.value.source.sha256) throw new ManifestTrustError('source_hash_mismatch');

  const manifestDigest = sha256Hex(raw);
  const hit = cache.get(manifestPath);
  if (hit?.manifestDigest === manifestDigest && hit.sourceDigest === sourceDigest) {
    // Only the expensive text extraction is cached; the renders are re-verified every time.
    return verifyImages(hit.manifest);
  }

  const verified = await verifyExtracted(parsed.value, resolved);
  cache.set(manifestPath, { manifestDigest, sourceDigest, manifest: verified });
  return verified;
}
