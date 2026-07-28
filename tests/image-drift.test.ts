import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// An isolated root keeps this test from tampering with page assets other test files read in parallel.
const scratch = await mkdtemp(join(tmpdir(), 'pdf-citation-drift-'));
const generated = join(scratch, 'src/citations/generated');

await mkdir(join(scratch, 'documents'), { recursive: true });
await mkdir(generated, { recursive: true });
await cp('documents/sample.pdf', join(scratch, 'documents/sample.pdf'));
await cp('src/citations/generated/manifest.v1.json', join(generated, 'manifest.v1.json'));
await cp('src/citations/generated/pages', join(generated, 'pages'), { recursive: true });

process.env.PDF_CITATION_ROOT = scratch;

// Imported after the root is set, so the modules resolve against the isolated copy.
const { ManifestTrustError, trustedManifest } = await import('../src/citations/trust.ts');
const { createAskRoutes } = await import('../src/mastra/routes.ts');

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function trustCode(): Promise<string> {
  try {
    await trustedManifest();
    return 'accepted';
  } catch (error) {
    assert.ok(error instanceof ManifestTrustError, String(error));
    return error.code;
  }
}

test('a page render altered after a successful call is not served from cache', async () => {
  // Populate the cache with a fully verified manifest.
  assert.equal(await trustCode(), 'accepted');

  // Neither the manifest nor the PDF changes, so only image verification can catch this.
  await appendFile(join(generated, 'pages/page-01.png'), 'tampered');

  assert.equal(await trustCode(), 'page_image_mismatch');
});

test('bytes that changed after verification are refused rather than served', async () => {
  await cp('src/citations/generated/pages/page-01.png', join(generated, 'pages/page-01.png'));
  const verified = await trustedManifest();

  // Exactly the race: the manifest was checked against the old render, the file then changed.
  await appendFile(join(generated, 'pages/page-01.png'), 'swapped after verification');

  const captured: { json?: any; status?: number } = {};
  const routes = createAskRoutes({
    manifest: async () => verified,
    answer: async () => { throw new Error('not used'); },
  }) as any[];
  const page = routes.find((entry) => entry.path === '/ask/page/:page' && entry.method === 'GET');

  await page.handler({
    header: () => undefined,
    json: (body: unknown, status = 200) => {
      captured.json = body;
      captured.status = status;
      return new Response(JSON.stringify(body), { status });
    },
    req: { param: () => '1', query: () => undefined },
  });

  assert.equal(captured.status, 503);
  assert.deepEqual(captured.json, { code: 'page_image_mismatch' });
});

test('a page render removed after a successful call is not served from cache', async () => {
  await cp('src/citations/generated/pages/page-01.png', join(generated, 'pages/page-01.png'));
  assert.equal(await trustCode(), 'accepted');

  await rm(join(generated, 'pages/page-02.png'));
  assert.equal(await trustCode(), 'page_image_mismatch');
});
