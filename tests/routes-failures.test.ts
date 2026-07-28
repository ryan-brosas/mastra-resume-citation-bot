import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CitationManifest } from '../src/citations/contract.ts';
import { trustedManifest } from '../src/citations/trust.ts';
import { AnswerError, type GroundedAnswer } from '../src/mastra/boundary.ts';
import { MAX_BODY_BYTES, STATUS, type RouteDeps, createAskRoutes, readHistory } from '../src/mastra/routes.ts';

const manifest = await trustedManifest();

type Captured = { json?: any; status?: number };

function context(
  options: {
    param?: Record<string, string>;
    query?: Record<string, string>;
    header?: Record<string, string>;
    body?: unknown;
    rawBody?: BodyInit;
  } = {},
) {
  const captured: Captured = {};
  return {
    captured,
    c: {
      html: (body: string) => new Response(body),
      json: (body: unknown, status = 200) => {
        captured.json = body;
        captured.status = status;
        return new Response(JSON.stringify(body), { status });
      },
      req: {
        raw:
          options.rawBody !== undefined
            ? new Request('http://test/ask/answer', { method: 'POST', body: options.rawBody, duplex: 'half' } as any)
            : options.body !== undefined
              ? new Request('http://test/ask/answer', { method: 'POST', body: JSON.stringify(options.body) })
              : undefined,
        header: (key: string) => options.header?.[key],
        param: (key: string) => options.param?.[key],
        query: (key: string) => options.query?.[key],
        json: async () => {
          if (options.body === undefined) throw new SyntaxError('malformed');
          return options.body;
        },
      },
    },
  };
}

function routes(deps: Partial<RouteDeps>) {
  const full: RouteDeps = {
    manifest: async () => manifest,
    answer: async (): Promise<GroundedAnswer> => ({
      answer: 'ok',
      citations: [],
      pages: [],
      unsupported: [],
      version: manifest.source.version,
    }),
    ...deps,
  };
  const built = createAskRoutes(full) as any[];
  return (path: string, method = 'GET') => {
    const found = built.find((entry) => entry.path === path && entry.method === method);
    assert.ok(found !== undefined, `no route for ${method} ${path}`);
    return found;
  };
}

const unavailableManifest = async (): Promise<CitationManifest> => {
  throw new Error('manifest is not trustworthy');
};

test('an untrusted manifest makes the document summary fail closed', async () => {
  const call = context();
  await routes({ manifest: unavailableManifest })('/ask/document').handler(call.c);

  assert.equal(call.captured.status, 503);
  assert.deepEqual(call.captured.json, { code: 'manifest_unavailable' });
});

test('an untrusted manifest makes page delivery fail closed', async () => {
  const call = context({ param: { page: '1' } });
  await routes({ manifest: unavailableManifest })('/ask/page/:page').handler(call.c);

  assert.equal(call.captured.status, 503);
  assert.deepEqual(call.captured.json, { code: 'manifest_unavailable' });
});

test('a page whose bytes disagree with its digest fails with the security policy', async () => {
  const drifted: CitationManifest = {
    ...manifest,
    source: {
      ...manifest.source,
      pages: manifest.source.pages.map((page, index) =>
        index === 0 ? { ...page, imageSha256: '0'.repeat(64) } : page,
      ),
    },
  };

  const response: Response = await routes({ manifest: async () => drifted })('/ask/page/:page').handler(
    context({ param: { page: '1' } }).c,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'page_image_mismatch' });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('every answer failure maps to its own stable code and status', async () => {
  const expected = [
    ['invalid_question', 400],
    ['unresolved_followup', 422],
    ['manifest_unavailable', 503],
    ['retrieval_failed', 503],
    ['model_failed', 502],
  ] as const;

  const answerCodes = expected.map(([code]) => code as string);
  for (const code of Object.keys(STATUS)) {
    if (code === 'payload_too_large') continue; // provoked by the body reader, asserted separately
    assert.ok(answerCodes.includes(code), code + ' is in STATUS but never proven over the route');
  }

  for (const [code, status] of expected) {
    const call = context({ body: { question: 'anything' } });
    await routes({ answer: async () => { throw new AnswerError(code); } })('/ask/answer', 'POST').handler(call.c);

    assert.equal(call.captured.status, status, `${code} must map to ${status}`);
    assert.deepEqual(call.captured.json, { code });
  }
});

test('an unexpected boundary error is reported as model_failed, never raw', async () => {
  const call = context({ body: { question: 'anything' } });
  await routes({ answer: async () => { throw new TypeError('internal detail that must not leak'); } })(
    '/ask/answer',
    'POST',
  ).handler(call.c);

  assert.equal(call.captured.status, 502);
  assert.deepEqual(call.captured.json, { code: 'model_failed' });
});

test('a successful answer versions each cited page image', async () => {
  const call = context({ body: { question: 'anything' } });
  await routes({
    answer: async (): Promise<GroundedAnswer> => ({
      answer: 'grounded [1]',
      citations: [{ id: 'x', page: 2, label: 'l', excerpt: 'e', quote: 'e', rects: [] }],
      pages: [{ page: 2, widthPoints: 612, heightPoints: 792 }],
      unsupported: [],
      version: 'sha256-abc',
    }),
  })('/ask/answer', 'POST').handler(call.c);

  assert.equal(call.captured.status, 200);
  assert.equal(call.captured.json.pages[0].image, 'ask/page/2?v=sha256-abc');
});

test('caller-supplied history is bounded and sanitised before it reaches the boundary', async () => {
  let seen: readonly { question: string; answer: string }[] = [];

  const hostile = [
    ...Array.from({ length: 500 }, (_, index) => ({ question: 'q' + index, answer: 'a' + index })),
    { question: 'x'.repeat(5_000), answer: 'y'.repeat(5_000) },
    null,
    'not a turn',
    { question: 42, answer: [] },
    { question: 'last real question', answer: 'last real answer' },
  ];

  const call = context({ body: { question: 'anything', history: hostile } });
  await routes({
    answer: async (_question, history) => {
      seen = history;
      return { answer: 'ok', citations: [], pages: [], unsupported: [], version: 'v' };
    },
  })('/ask/answer', 'POST').handler(call.c);

  assert.equal(call.captured.status, 200);
  assert.ok(seen.length <= 6, 'at most six exchanges may survive, saw ' + seen.length);
  assert.equal(seen.at(-1)?.question, 'last real question', 'the newest turns are the ones kept');
  for (const turn of seen) {
    assert.equal(typeof turn.question, 'string');
    assert.equal(typeof turn.answer, 'string');
    assert.ok(turn.question.length <= 1000, 'questions are capped');
    assert.ok(turn.answer.length <= 2000, 'answers are capped');
  }
});

test('history that is not an array is ignored rather than rejected', async () => {
  for (const history of ['nope', 42, null, { question: 'q' }]) {
    let seen: unknown = 'unset';
    const call = context({ body: { question: 'anything', history } });
    await routes({
      answer: async (_question, value) => {
        seen = value;
        return { answer: 'ok', citations: [], pages: [], unsupported: [], version: 'v' };
      },
    })('/ask/answer', 'POST').handler(call.c);

    assert.equal(call.captured.status, 200);
    assert.deepEqual(seen, [], 'a malformed history is simply empty');
  }
});

test('history is inspected in bounded fashion, not merely reported bounded', () => {
  let reads = 0;
  // Each turn counts its own inspection, so a filter over the whole array would be visible.
  const hostile = Array.from({ length: 5000 }, (_, index) => ({
    get question() {
      reads += 1;
      return 'q' + index;
    },
    get answer() {
      return 'a' + index;
    },
  }));

  const kept = readHistory(hostile);

  assert.ok(kept.length <= 6);
  assert.equal(kept.at(-1)?.question, 'q4999', 'the newest turns are the ones kept');
  assert.ok(reads < 200, 'only a bounded window may be inspected, saw ' + reads + ' reads of 5000 turns');
});

test('an oversized body is refused from its bytes, not from a header it declares', async () => {
  for (const declared of [undefined, '10']) {
    let delivered = 0;
    let answered = 0;

    // Streamed in chunks, so no Content-Length is sent and any declared one understates the truth.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered += 1;
        if (delivered > 200) return controller.close();
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
      },
    });

    const call = context({ rawBody: stream, header: declared === undefined ? {} : { 'content-length': declared } });
    await routes({ answer: async () => { answered += 1; throw new Error('unreachable'); } })(
      '/ask/answer',
      'POST',
    ).handler(call.c);

    assert.equal(call.captured.status, 413);
    assert.deepEqual(call.captured.json, { code: 'payload_too_large' });
    assert.equal(answered, 0, 'an oversized body must never reach the boundary');
    assert.ok(delivered < 200, 'the stream must be abandoned, not drained, saw ' + delivered + ' chunks');
  }
});

test('a body within the limit is accepted whatever its Content-Length claims', async () => {
  const call = context({ body: { question: 'anything' }, header: { 'content-length': String(MAX_BODY_BYTES + 1) } });
  await routes({})('/ask/answer', 'POST').handler(call.c);

  assert.equal(call.captured.status, 200, 'a declared size cannot refuse a body that is actually small');
});
