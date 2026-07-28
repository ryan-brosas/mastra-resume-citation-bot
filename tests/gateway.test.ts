import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { completeChat, embedTexts } from '../src/mastra/lib/gateway.ts';
import { EMBEDDING_DIMENSION } from '../src/mastra/lib/models.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, () => seed);
}

type Captured = { url: string; body: any };

function stub(response: { status?: number; body?: unknown; raw?: string }): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    const status = response.status ?? 200;
    const text = response.raw ?? JSON.stringify(response.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }) as unknown as typeof fetch;
  return captured;
}

test('no request is made for an empty batch', async () => {
  const captured = stub({ body: {} });
  assert.deepEqual(await embedTexts([]), []);
  assert.equal(captured.length, 0);
});

test('an HTTP error surfaces the status and a bounded body', async () => {
  stub({ status: 503, raw: 'upstream exploded' });
  await assert.rejects(embedTexts(['a']), /gateway \/embeddings failed: 503 upstream exploded/);
});

test('a non-JSON response is rejected rather than silently coerced', async () => {
  stub({ raw: '<html>gateway down</html>' });
  await assert.rejects(embedTexts(['a']), /gateway \/embeddings returned a non-JSON body/);

  stub({ raw: '<html>gateway down</html>' });
  await assert.rejects(completeChat('s', 'p'), /gateway \/chat\/completions returned a non-JSON body/);
});

test('a JSON body that is not an object is rejected before it is indexed into', async () => {
  stub({ raw: 'null' });
  await assert.rejects(embedTexts(['a']), /gateway \/embeddings returned a non-object body/);

  stub({ raw: 'null' });
  await assert.rejects(completeChat('s', 'p'), /gateway \/chat\/completions returned a non-object body/);
});

test('a null embedding row is rejected with its position', async () => {
  stub({ body: { data: [null] } });
  await assert.rejects(embedTexts(['a']), /embedding response row 0 was not an object/);
});

test('a response with the wrong number of vectors is rejected', async () => {
  stub({ body: { data: [{ index: 0, embedding: vector(1) }] } });
  await assert.rejects(embedTexts(['a', 'b']), /returned 1 vectors for 2 inputs/);
});

test('a missing data array is rejected', async () => {
  stub({ body: { object: 'list' } });
  await assert.rejects(embedTexts(['a']), /returned 0 vectors for 1 inputs/);
});

test('a wrong-dimension embedding is rejected so a model swap cannot poison the index', async () => {
  stub({ body: { data: [{ index: 0, embedding: [1, 2, 3] }] } });
  await assert.rejects(embedTexts(['a']), new RegExp(`had 3 dimensions, expected ${EMBEDDING_DIMENSION}`));
});

test('rows returned out of order are restored to input order', async () => {
  stub({
    body: {
      data: [
        { index: 2, embedding: vector(3) },
        { index: 0, embedding: vector(1) },
        { index: 1, embedding: vector(2) },
      ],
    },
  });

  const vectors = await embedTexts(['a', 'b', 'c']);
  assert.deepEqual(
    vectors.map((entry) => entry[0]),
    [1, 2, 3],
  );
});

test('a duplicated index is rejected instead of producing a sparse result', async () => {
  stub({
    body: {
      data: [
        { index: 0, embedding: vector(1) },
        { index: 0, embedding: vector(2) },
      ],
    },
  });
  await assert.rejects(embedTexts(['a', 'b']), /repeated index 0/);
});

test('an out-of-range or non-integer index is rejected', async () => {
  stub({ body: { data: [{ index: 7, embedding: vector(1) }] } });
  await assert.rejects(embedTexts(['a']), /used index 7, outside 0\.\.0/);

  stub({ body: { data: [{ index: -1, embedding: vector(1) }] } });
  await assert.rejects(embedTexts(['a']), /used index -1, outside 0\.\.0/);

  stub({ body: { data: [{ index: 0.5, embedding: vector(1) }] } });
  await assert.rejects(embedTexts(['a']), /used index 0\.5, outside 0\.\.0/);
});

test('rows without an index fall back to their position', async () => {
  stub({ body: { data: [{ embedding: vector(1) }, { embedding: vector(2) }] } });
  const vectors = await embedTexts(['a', 'b']);
  assert.deepEqual(
    vectors.map((entry) => entry[0]),
    [1, 2],
  );
});

test('chat completions are requested non-streaming with the system prompt first', async () => {
  const captured = stub({ body: { choices: [{ message: { content: 'grounded answer' } }] } });
  const answer = await completeChat('be terse', 'the question');

  assert.equal(answer, 'grounded answer');
  const [call] = captured;
  assert.ok(call.url.endsWith('/chat/completions'));
  assert.equal(call.body.stream, false);
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'the question' },
  ]);
});

test('an empty or absent chat answer is rejected rather than returned', async () => {
  stub({ body: { choices: [{ message: { content: '   ' } }] } });
  await assert.rejects(completeChat('s', 'p'), /returned no answer content/);

  stub({ body: { choices: [] } });
  await assert.rejects(completeChat('s', 'p'), /returned no answer content/);

  stub({ body: { choices: [null] } });
  await assert.rejects(completeChat('s', 'p'), /returned no answer content/);

  stub({ body: { choices: 'nope' } });
  await assert.rejects(completeChat('s', 'p'), /returned no answer content/);

  stub({ status: 500, raw: 'boom' });
  await assert.rejects(completeChat('s', 'p'), /gateway \/chat\/completions failed: 500 boom/);
});
