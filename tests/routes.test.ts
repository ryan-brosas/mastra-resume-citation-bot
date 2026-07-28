import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trustedManifest } from '../src/citations/trust.ts';
import { askRoutes } from '../src/mastra/routes.ts';

type Captured = { json?: any; status?: number; html?: string };

function route(path: string, method = 'GET') {
  const found = (askRoutes as any[]).find((entry) => entry.path === path && entry.method === method);
  assert.ok(found !== undefined, `no route registered for ${method} ${path}`);
  return found;
}

function context(options: { param?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) {
  const captured: Captured = {};
  return {
    captured,
    c: {
      html: (body: string) => {
        captured.html = body;
        captured.status = 200;
        return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
      json: (body: unknown, status = 200) => {
        captured.json = body;
        captured.status = status;
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      },
      req: {
        param: (key: string) => options.param?.[key],
        query: (key: string) => options.query?.[key],
        json: async () => {
          if (options.body === undefined) throw new SyntaxError('malformed body');
          return options.body;
        },
      },
    },
  };
}

const manifest = await trustedManifest();

test('the page shell and its assets are served with the right media types', async () => {
  const shell = context();
  await route('/ask').handler(shell.c);
  assert.equal(shell.captured.status, 200);
  assert.match(shell.captured.html ?? '', /<html/i);

  for (const [file, type] of [['app.css', 'text/css'], ['app.js', 'text/javascript']] as const) {
    const response: Response = await route(`/ask/${file}`).handler(context().c);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', new RegExp(type));
    assert.ok((await response.text()).length > 0);
  }
});

test('the document summary reports the trusted manifest', async () => {
  const summary = context();
  await route('/ask/document').handler(summary.c);

  assert.equal(summary.captured.status, 200);
  assert.equal(summary.captured.json.pageCount, manifest.source.pageCount);
  assert.equal(summary.captured.json.citationCount, manifest.citations.length);
  assert.equal(summary.captured.json.version, manifest.source.version);
});

test('a page render is served as png, and unknown pages are refused', async () => {
  const ok: Response = await route('/ask/page/:page').handler(context({ param: { page: '1' } }).c);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.ok((await ok.arrayBuffer()).byteLength > 1000);

  for (const page of ['99', '0', 'abc']) {
    const bad = context({ param: { page } });
    await route('/ask/page/:page').handler(bad.c);
    assert.equal(bad.captured.status, 404, `page "${page}" must be refused`);
    assert.equal(bad.captured.json.code, 'unknown_page');
  }
});

test('a page request bound to a different manifest version is refused', async () => {
  const stale = context({ param: { page: '1' }, query: { v: 'sha256-somethingelse' } });
  await route('/ask/page/:page').handler(stale.c);

  assert.equal(stale.captured.status, 409);
  assert.equal(stale.captured.json.code, 'stale_version');

  const current = context({ param: { page: '1' }, query: { v: manifest.source.version } });
  const response: Response = await route('/ask/page/:page').handler(current.c);
  assert.equal(response.status, 200);
});

test('malformed and non-string questions are refused before any work', async () => {
  const malformed = context();
  await route('/ask/answer', 'POST').handler(malformed.c);
  assert.equal(malformed.captured.status, 400);
  assert.equal(malformed.captured.json.code, 'invalid_question');

  const wrongType = context({ body: { question: 42 } });
  await route('/ask/answer', 'POST').handler(wrongType.c);
  assert.equal(wrongType.captured.status, 400);
  assert.equal(wrongType.captured.json.code, 'invalid_question');
});
