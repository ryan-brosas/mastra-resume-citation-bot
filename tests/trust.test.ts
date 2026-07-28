import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { serializeManifest, sha256Hex, type CitationManifest } from '../src/citations/contract.ts';
import {
  DEFAULT_SOURCE_PATH,
  PROJECT_ROOT,
  STAGING_PAGES_DIR,
  buildManifest,
  extractSource,
  readPageImages,
} from '../src/citations/manifest.ts';
import { ManifestTrustError, publishManifest, trustedManifest, verifiedManifest } from '../src/citations/trust.ts';
import { existsSync } from 'node:fs';

const source = await extractSource(DEFAULT_SOURCE_PATH);
const images = await readPageImages(source.pages.length);
const manifest = buildManifest(source, images);
const scratch = await mkdtemp(join(tmpdir(), 'pdf-citation-trust-'));

let counter = 0;
async function manifestFile(value: CitationManifest): Promise<string> {
  counter += 1;
  const path = join(scratch, `manifest-${counter}.json`);
  await writeFile(path, serializeManifest(value));
  return path;
}

function mutate(edit: (draft: any) => void): CitationManifest {
  const draft = JSON.parse(JSON.stringify(manifest));
  edit(draft);
  return draft as CitationManifest;
}

async function trustCode(path: string): Promise<string> {
  try {
    await trustedManifest(path);
    return 'accepted';
  } catch (error) {
    assert.ok(error instanceof ManifestTrustError);
    return error.code;
  }
}

test('an untampered manifest is trusted and reports the real source', async () => {
  const trusted = await trustedManifest(await manifestFile(manifest));
  assert.equal(trusted.source.sha256, source.sha256);
  assert.equal(trusted.source.sourcePath, 'documents/sample.pdf');
  assert.equal(trusted.citations.length, manifest.citations.length);
});

test('a schema-valid manifest with a tampered excerpt is rejected at runtime', async () => {
  const tampered = mutate((draft) => {
    // Keep spans consistent with the excerpt so this reaches source verification rather than
    // failing the cheaper span/excerpt agreement check.
    draft.citations[0].excerpt = 'Ryan personally invented the transistor';
    draft.citations[0].spans = [
      { text: 'Ryan personally invented the transistor', rect: draft.citations[0].spans[0].rect },
    ];
  });
  assert.equal(await trustCode(await manifestFile(tampered)), 'excerpt_not_in_source');
});

test('a manifest pointing at a different PDF is rejected at runtime', async () => {
  const drifted = mutate((draft) => {
    draft.source.sourcePath = 'tests/fixtures/other-document.pdf';
  });
  assert.equal(await trustCode(await manifestFile(drifted)), 'source_hash_mismatch');
});

test('a manifest whose source is unreadable is rejected at runtime', async () => {
  const missing = mutate((draft) => {
    draft.source.sourcePath = 'documents/not-a-real-file.pdf';
  });
  assert.equal(await trustCode(await manifestFile(missing)), 'source_unreadable');
});

test('an absolute or escaping source path is rejected', async () => {
  const absolute = mutate((draft) => {
    draft.source.sourcePath = '/etc/passwd';
  });
  assert.equal(await trustCode(await manifestFile(absolute)), 'invalid_source_path');

  const escaping = mutate((draft) => {
    draft.source.sourcePath = '../outside/sample.pdf';
  });
  assert.equal(await trustCode(await manifestFile(escaping)), 'invalid_source_path');
});

test('a missing manifest is rejected at runtime', async () => {
  assert.equal(await trustCode(join(scratch, 'absent.json')), 'manifest_missing');
});

test('a verified manifest becomes answerable only once it is published', async () => {
  const path = join(scratch, 'published.json');
  assert.equal(await trustCode(path), 'manifest_missing');

  const built = await verifiedManifest(DEFAULT_SOURCE_PATH);
  await publishManifest(built, path);

  const trusted = await trustedManifest(path);
  assert.equal(trusted.source.sha256, source.sha256);
  assert.equal(trusted.citations.length, built.citations.length);
});

test('publishing a tampered manifest is rejected and cannot prime the cache', async () => {
  const path = join(scratch, 'tampered-publish.json');
  const tampered = mutate((draft) => {
    // Keep spans consistent with the excerpt so this reaches source verification rather than
    // failing the cheaper span/excerpt agreement check.
    draft.citations[0].excerpt = 'Ryan personally invented the transistor';
    draft.citations[0].spans = [
      { text: 'Ryan personally invented the transistor', rect: draft.citations[0].spans[0].rect },
    ];
  });

  await assert.rejects(
    publishManifest(tampered, path),
    (error: unknown) => error instanceof ManifestTrustError && error.code === 'excerpt_not_in_source',
  );
  assert.equal(await trustCode(path), 'manifest_missing');
});

test('publishing a manifest whose page render does not match is rejected', async () => {
  const drifted = mutate((draft) => {
    draft.source.pages[0].imageSha256 = sha256Hex('a different render');
  });

  await assert.rejects(
    publishManifest(drifted, join(scratch, 'image-drift.json')),
    (error: unknown) => error instanceof ManifestTrustError && error.code === 'page_image_mismatch',
  );
});

test('publishing a manifest whose PDF has drifted is rejected', async () => {
  const drifted = mutate((draft) => {
    draft.source.sourcePath = 'tests/fixtures/other-document.pdf';
  });

  await assert.rejects(
    publishManifest(drifted, join(scratch, 'drifted-publish.json')),
    (error: unknown) => error instanceof ManifestTrustError && error.code === 'source_hash_mismatch',
  );
});

test('a build that is never published leaves the live pages and document untouched', async () => {
  const before = await readPageImages(source.pages.length);
  try {
    // verifiedManifest renders; only publishManifest may promote those renders.
    await verifiedManifest(DEFAULT_SOURCE_PATH);
    assert.ok(existsSync(STAGING_PAGES_DIR), 'renders must wait in staging');

    const after = await readPageImages(source.pages.length);
    assert.deepEqual(
      after.map((image) => image.sha256),
      before.map((image) => image.sha256),
      'live page assets must not change before publication',
    );

    const trusted = await trustedManifest();
    assert.equal(trusted.source.sha256, source.sha256, 'the published document stays answerable');
  } finally {
    await rm(STAGING_PAGES_DIR, { recursive: true, force: true });
  }
});

test('a rebuilt manifest is observed instead of a stale cached one', async () => {
  const path = await manifestFile(manifest);
  const before = await trustedManifest(path);

  const rebuilt = buildManifest(source, images, 200);
  assert.notEqual(rebuilt.citations.length, before.citations.length);
  await writeFile(path, serializeManifest(rebuilt));

  const after = await trustedManifest(path);
  assert.equal(after.citations.length, rebuilt.citations.length);
  assert.notDeepEqual(
    after.citations.map((citation) => citation.id),
    before.citations.map((citation) => citation.id),
  );
});

test('a source PDF edited after a cache hit is rejected instead of trusted', async () => {
  const fixture = join(PROJECT_ROOT, 'tests/fixtures', `drift-${process.pid}.pdf`);
  await copyFile(DEFAULT_SOURCE_PATH, fixture);
  try {
    const path = await manifestFile(buildManifest(await extractSource(fixture), images));
    const trusted = await trustedManifest(path);
    assert.equal(trusted.source.sourcePath, relative(PROJECT_ROOT, fixture));

    await copyFile(join(PROJECT_ROOT, 'tests/fixtures/other-document.pdf'), fixture);
    assert.equal(await trustCode(path), 'source_hash_mismatch');
  } finally {
    await rm(fixture, { force: true });
  }
});
