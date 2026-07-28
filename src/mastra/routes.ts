import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerApiRoute } from '@mastra/core/server';
import { type CitationManifest, sha256Hex } from '../citations/contract.ts';
import { PROJECT_ROOT, pageImagePath } from '../citations/manifest.ts';
import { trustedManifest } from '../citations/trust.ts';
import {
  AnswerError,
  type AnswerErrorCode,
  type Exchange,
  type GroundedAnswer,
  MAX_HISTORY_TURNS,
  answerWithCitations,
} from './boundary.ts';

const UI_DIR = resolve(PROJECT_ROOT, 'src/mastra/ui');

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; " +
    "form-action 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const;

function secureResponse(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}

/** Route-level refusals a caller can provoke, in addition to the answer failures. */
export type RouteErrorCode = AnswerErrorCode | 'payload_too_large';

export const STATUS: Record<RouteErrorCode, number> = {
  invalid_question: 400,
  unresolved_followup: 422,
  payload_too_large: 413,
  manifest_unavailable: 503,
  retrieval_failed: 503,
  model_failed: 502,
};

export type RouteDeps = Readonly<{
  manifest: () => Promise<CitationManifest>;
  answer: (question: string, history: readonly Exchange[]) => Promise<GroundedAnswer>;
}>;

const liveRouteDeps: RouteDeps = {
  manifest: () => trustedManifest(),
  answer: (question, history) => answerWithCitations(question, history),
};

/** A body larger than this cannot be a legitimate question plus six short exchanges. */
export const MAX_BODY_BYTES = 64 * 1024;

type BodyResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; code: RouteErrorCode }>;

/**
 * Content-Length is a claim by the caller, not a bound on what arrives: it can be understated, or
 * absent entirely on a chunked body. The stream is counted as it is read and abandoned the moment it
 * exceeds the limit, so an oversized body is never fully buffered and never parsed.
 */
async function readBoundedBody(c: any): Promise<BodyResult> {
  const stream: ReadableStream<Uint8Array> | null | undefined = c.req.raw?.body;
  if (!stream) return { ok: false, code: 'invalid_question' };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, code: 'payload_too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: 'invalid_question' };
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, code: 'invalid_question' };
  }
}

/** History arrives from the browser, so it is bounded and re-typed rather than trusted as sent. */
export function readHistory(value: unknown): readonly Exchange[] {
  if (!Array.isArray(value)) return [];

  // Bound the work first: a hostile caller can send an enormous array, and only the tail can survive.
  return value
    .slice(-MAX_HISTORY_TURNS * 4)
    .filter(
      (turn): turn is Exchange =>
        typeof turn === 'object' && turn !== null &&
        typeof (turn as Exchange).question === 'string' && typeof (turn as Exchange).answer === 'string',
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({ question: turn.question.slice(0, 1000), answer: turn.answer.slice(0, 2000) }));
}

function unavailable(code: string, status: number): Response {
  return secureResponse(new Response(JSON.stringify({ code }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

/** Named rather than derived from the request, so no request can reach a path of its own choosing. */
function uiAsset(file: string, contentType: string) {
  return registerApiRoute(`/ask/${file}`, {
    method: 'GET',
    handler: async () => {
      let body: string;
      try {
        body = await readFile(resolve(UI_DIR, file), 'utf8');
      } catch {
        return unavailable('asset_unavailable', 503);
      }
      return secureResponse(new Response(body, {
        headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
      }));
    },
  });
}

export function createAskRoutes(deps: RouteDeps = liveRouteDeps) {
  return [
    registerApiRoute('/ask', {
      method: 'GET',
      handler: async (c: any) => {
        let body: string;
        try {
          body = await readFile(resolve(UI_DIR, 'index.html'), 'utf8');
        } catch {
          return unavailable('asset_unavailable', 503);
        }
        return secureResponse(c.html(body));
      },
    }),

    uiAsset('app.css', 'text/css; charset=utf-8'),
    uiAsset('app.js', 'text/javascript; charset=utf-8'),

    registerApiRoute('/ask/document', {
      method: 'GET',
      handler: async (c: any) => {
        try {
          const { source, citations } = await deps.manifest();
          return secureResponse(c.json({
            title: source.title,
            sourcePath: source.sourcePath,
            pageCount: source.pageCount,
            citationCount: citations.length,
            version: source.version,
          }));
        } catch {
          // Stable code only: trust-boundary detail never crosses to the browser.
          return secureResponse(c.json({ code: 'manifest_unavailable' }, 503));
        }
      },
    }),

    registerApiRoute('/ask/page/:page', {
      method: 'GET',
      handler: async (c: any) => {
        const page = Number(c.req.param('page'));
        const manifest = await deps.manifest().catch(() => undefined);
        if (manifest === undefined) return secureResponse(c.json({ code: 'manifest_unavailable' }, 503));

        const digest = manifest.source.pages.find((entry) => entry.page === page);
        if (!Number.isInteger(page) || digest === undefined) {
          return secureResponse(c.json({ code: 'unknown_page' }, 404));
        }

        // The answer carried a version; refuse to pair its geometry with a republished render.
        const requested = c.req.query('v');
        if (typeof requested === 'string' && requested !== manifest.source.version) {
          return secureResponse(c.json({ code: 'stale_version' }, 409));
        }

        let bytes: Buffer;
        try {
          bytes = await readFile(pageImagePath(page));
        } catch {
          return secureResponse(c.json({ code: 'page_image_mismatch' }, 503));
        }

        // Hash the bytes actually being sent: verifying the path, then reopening it, would leave a
        // window in which a republished render could be served against an already-checked manifest.
        if (sha256Hex(bytes) !== digest.imageSha256) {
          return secureResponse(c.json({ code: 'page_image_mismatch' }, 503));
        }

        return secureResponse(new Response(new Uint8Array(bytes), {
          headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
        }));
      },
    }),

    registerApiRoute('/ask/answer', {
      method: 'POST',
      handler: async (c: any) => {
        const body = await readBoundedBody(c);
        if (!body.ok) return secureResponse(c.json({ code: body.code }, STATUS[body.code]));

        const payload = (body.value ?? {}) as { question?: unknown; history?: unknown };
        const { question } = payload;
        if (typeof question !== 'string') {
          return secureResponse(c.json({ code: 'invalid_question' }, 400));
        }

        try {
          const result = await deps.answer(question, readHistory(payload.history));
          return secureResponse(c.json({
            ...result,
            pages: result.pages.map((page) => ({
              page: page.page,
              widthPoints: page.widthPoints,
              heightPoints: page.heightPoints,
              image: `ask/page/${page.page}?v=${result.version}`,
            })),
          }));
        } catch (error) {
          // Callers get a stable code; internals never cross the boundary.
          const code: RouteErrorCode = error instanceof AnswerError ? error.code : 'model_failed';
          return secureResponse(c.json({ code }, STATUS[code]));
        }
      },
    }),
  ];
}

export const askRoutes = createAskRoutes();
