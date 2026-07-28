import {
  ANSWER_MODEL_ID,
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_ID,
  GATEWAY_API_KEY,
  GATEWAY_URL,
} from './models.ts';

/** Voyage models cap batch size well below the chunk count a large PDF can produce. */
export const EMBED_BATCH_SIZE = 96;

/** A hung gateway would otherwise hold a request open indefinitely. */
export const GATEWAY_TIMEOUT_MS = Number(process.env.OMNIROUTE_TIMEOUT_MS ?? 60000);

function headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(GATEWAY_API_KEY === '' ? {} : { authorization: `Bearer ${GATEWAY_API_KEY}` }),
  };
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_URL}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'was unreachable';
    throw new Error(`gateway ${path} ${reason}`);
  }

  if (!response.ok) {
    throw new Error(`gateway ${path} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`gateway ${path} returned a non-JSON body`);
  }
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`gateway ${path} returned a non-object body`);
  }
  return payload as Record<string, unknown>;
}

/**
 * The gateway is spoken to over plain HTTP rather than through an AI SDK provider. Its OpenAI
 * compatibility is close but not exact — it rejects the `encoding_format: "float"` the AI SDK always
 * sends and accepts only "base64", so the field is omitted entirely; it defaults to streaming when
 * `stream` is omitted; and it needs the full `provider/model` id to survive to the wire. The provider
 * abstraction cost more than it carried.
 */
export async function embedTexts(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const payload = (await post('/embeddings', {
    model: EMBEDDING_MODEL_ID,
    input: [...texts],
  })) as { data?: unknown[] };

  const rows = payload.data;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new Error(`embedding response returned ${rows?.length ?? 0} vectors for ${texts.length} inputs`);
  }

  // Row count, unique indexes, and in-range indexes together mean every slot is filled.
  const vectors = new Array<number[]>(texts.length);
  const claimed = new Set<number>();

  rows.forEach((entry, position) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`embedding response row ${position} was not an object`);
    }
    const row = entry as { index?: number; embedding?: number[] };
    const index = row.index ?? position;
    if (!Number.isInteger(index) || index < 0 || index >= texts.length) {
      throw new Error(`embedding response used index ${index}, outside 0..${texts.length - 1}`);
    }
    if (claimed.has(index)) {
      throw new Error(`embedding response repeated index ${index}`);
    }
    // A silent embedding-model swap would otherwise poison the index with incomparable vectors.
    if (!Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `embedding ${index} had ${row.embedding?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSION}`,
      );
    }
    claimed.add(index);
    vectors[index] = row.embedding;
  });

  return vectors;
}

export async function completeChat(system: string, prompt: string): Promise<string> {
  const payload = (await post('/chat/completions', {
    model: ANSWER_MODEL_ID,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  })) as { choices?: { message?: { content?: string } }[] };

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('gateway returned no answer content');
  }
  return content;
}
