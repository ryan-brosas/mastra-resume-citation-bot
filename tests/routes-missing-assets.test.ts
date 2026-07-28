import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// An empty root means src/mastra/ui does not exist, which is the missing-asset case.
const scratch = await mkdtemp(join(tmpdir(), 'pdf-citation-noui-'));
process.env.PDF_CITATION_ROOT = scratch;

const { askRoutes } = await import('../src/mastra/routes.ts');

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function route(path: string) {
  const found = (askRoutes as any[]).find((entry) => entry.path === path && entry.method === 'GET');
  assert.ok(found !== undefined);
  return found;
}

test('missing UI assets fail closed with a stable code instead of an unhandled error', async () => {
  for (const path of ['/ask/app.css', '/ask/app.js']) {
    const response: Response = await route(path).handler({});
    assert.equal(response.status, 503, `${path} must fail closed`);
    assert.deepEqual(await response.json(), { code: 'asset_unavailable' });
  }
});

test('a missing page shell fails closed rather than throwing', async () => {
  const response: Response = await route('/ask').handler({
    html: () => assert.fail('the shell must not be rendered when it cannot be read'),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'asset_unavailable' });
});
