import { randomUUID } from 'node:crypto';
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

const stagedPagesByManifest = new WeakMap<CitationManifest, string>();
const stagedDirectories = new Set<string>();
let exitCleanupRegistered = false;
let publicationTail = Promise.resolve();

/** Renders into build-owned staging only. Live page assets stay untouched until publication. */
async function renderPages(pdfPath: string, pageCount: number): Promise<{ images: PageImage[]; directory: string }> {
  const scratch = await mkdtemp(join(tmpdir(), 'pdf-citation-render-'));
  const directory = `${PAGES_DIR}.staging.${process.pid}.${randomUUID()}`;
  stagedDirectories.add(directory);
  discardStagedPagesOnExit();
  try {
    await mkdir(directory, { recursive: true });
    for (let page = 1; page <= pageCount; page += 1) {
      await renderPage(pdfPath, page, join(scratch, `p${page}`));
      const produced = (await readdir(scratch)).find((name) => name.startsWith(`p${page}-`));
      if (produced === undefined) throw new ManifestTrustError('render_failed');
      await copyFile(join(scratch, produced), resolve(directory, pageImageName(page)));
    }
    return { images: await readPageImages(pageCount, directory), directory };
  } catch (error) {
    stagedDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
    throw error instanceof ManifestTrustError ? error : new ManifestTrustError('render_failed');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function discardStagedPagesOnExit(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', () => {
    for (const directory of stagedDirectories) rmSync(directory, { recursive: true, force: true });
  });
}

async function commitPublication(serialized: string, manifestPath: string, stagedDirectory?: string): Promise<void> {
  const previous = publicationTail;
  let releaseNext: (() => void) | undefined;
  publicationTail = new Promise<void>((resolve) => { releaseNext = resolve; });
  await previous;
  try {
    await commitPublicationUnlocked(serialized, manifestPath, stagedDirectory);
  } finally {
    releaseNext?.();
  }
}

async function commitPublicationUnlocked(
  serialized: string,
  manifestPath: string,
  stagedDirectory?: string,
): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  const stagingManifest = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(stagingManifest, serialized);

  if (stagedDirectory === undefined) {
    try {
      await rename(stagingManifest, manifestPath);
    } catch (error) {
      await rm(stagingManifest, { force: true });
      throw error;
    }
    return;
  }

  const retiredPages = `${PAGES_DIR}.retired.${process.pid}.${randomUUID()}`;
  let retired = false;
  let promoted = false;
  try {
    if (existsSync(PAGES_DIR)) {
      await rename(PAGES_DIR, retiredPages);
      retired = true;
    }
    await rename(stagedDirectory, PAGES_DIR);
    promoted = true;
    await rename(stagingManifest, manifestPath);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (promoted) {
      try {
        await rename(PAGES_DIR, stagedDirectory);
      } catch (restoreStagingError) {
        try {
          await rm(PAGES_DIR, { recursive: true, force: true });
        } catch (removePromotedError) {
          rollbackErrors.push(restoreStagingError, removePromotedError);
        }
      }
    }
    if (retired) {
      try {
        await rename(retiredPages, PAGES_DIR);
      } catch (restorePagesError) {
        rollbackErrors.push(restorePagesError);
      }
    }
    try {
      await rm(stagingManifest, { force: true });
    } catch (removeManifestError) {
      rollbackErrors.push(removeManifestError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'publication failed and rollback was incomplete');
    }
    throw error;
  }

  await rm(retiredPages, { recursive: true, force: true }).catch(() => undefined);
}

/** The single canonical build. Verified in memory, but not yet visible to answering. */
export async function verifiedManifest(sourcePath: string): Promise<CitationManifest> {
  const extracted = await extractSource(sourcePath);
  const { images, directory } = await renderPages(resolveSourcePath(extracted.sourcePath), extracted.pages.length);

  try {
    const validated = validateManifest(buildManifest(extracted, images));
    if (!validated.ok) throw new ManifestTrustError(validated.error.code);

    const verified = verifyAgainstSource(validated.value, extracted);
    if (!verified.ok) throw new ManifestTrustError(verified.error.code);

    const withImages = verifyPageImages(verified.value, images);
    if (!withImages.ok) throw new ManifestTrustError(withImages.error.code);

    stagedPagesByManifest.set(withImages.value, directory);
    return withImages.value;
  } catch (error) {
    stagedDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
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
  const stagedDirectory = stagedPagesByManifest.get(manifest);
  const validated = validateManifest(manifest);
  if (!validated.ok) throw new ManifestTrustError(validated.error.code);

  const resolvedSource = resolveSourcePath(validated.value.source.sourcePath);
  const verified = await verifyExtracted(validated.value, resolvedSource, stagedDirectory ?? PAGES_DIR);
  const serialized = serializeManifest(verified);

  await commitPublication(serialized, manifestPath, stagedDirectory);
  if (stagedDirectory !== undefined) {
    stagedDirectories.delete(stagedDirectory);
    stagedPagesByManifest.delete(manifest);
  }

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
