# Ryan's Resume Bot

[![CI](https://github.com/ryan-brosas/mastra-resume-citation-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/ryan-brosas/mastra-resume-citation-bot/actions/workflows/ci.yml)

A Mastra application that answers questions about a résumé and can only cite passages that actually exist in it.

The core rule: **a generated citation is never trusted.** Every citation the model emits is re-resolved
against a source-bound manifest, and anything unresolvable is stripped before the answer reaches a caller.

> [!IMPORTANT]
> This repository contains the real résumé and personal contact details in three forms:
> `documents/sample.pdf`, `src/citations/generated/manifest.v1.json`, and the rendered PNGs under
> `src/citations/generated/pages/`. Keep the repository private unless all three are replaced and
> rebuilt from a redacted source. Removing only the PDF does not remove the extracted or rendered data.

## How it works

```
document.pdf ──> extract ──> verbatim excerpts ──> manifest (bound to PDF SHA-256)
                                    │
                                    ├──> fits the context budget?  yes ──> answered whole, document order
                                    │                              no  ──> embeddings ──> LibSQL index ──> top-k
                                    │
answer ──> validate markers ────────┘  (unknown or unretrieved ids are removed)
```

- `src/citations/contract.ts` — manifest types, validation, and `verifyAgainstSource`. No Mastra imports, fully testable.
- `src/citations/pdf-source.ts` — Poppler extraction. Text **and** coordinates come from one word stream, so an excerpt and its highlight boxes correspond by construction rather than by fuzzy matching.
- `src/citations/manifest.ts` — deterministic chunking; every excerpt is verbatim page text and carries page-relative highlight rects.
- `src/citations/trust.ts` — the trust boundary, in both directions: `publishManifest()` is the only way a manifest is written, and `trustedManifest()` re-verifies it against the PDF before any query.
- `src/citations/answer.ts` — strips fabricated citation markers and renumbers survivors to `[1]`, `[2]`, …
- `src/mastra/boundary.ts` — `answerWithCitations()`, the **only** answer path.
- `src/mastra/indexing.ts` — `indexDocument()`, the index path. Both carry a dependency seam so their failure ordering is testable without a network.
- `src/mastra/lib/retrieval.ts` — similarity search exists to make a corpus fit, not because a subset is better. A document under `CONTEXT_BUDGET_CHARS` is passed whole in document order, so a comparative question ("which role lasted longest?") sees every entry; only a larger one is narrowed by top-k. A document that fits is never embedded.
- `src/mastra/routes.ts` — the HTTP surface: the UI shell, its assets, page renders, and `POST /ask/answer`.
- `src/mastra/ui/` — the browser client. Answer markers are rendered as elements only for citations that survived validation; model text itself is only ever inserted as text.

There is deliberately no caller-facing chat agent registered with Mastra. The answer model
(`src/mastra/lib/answer-model.ts`) is generation-only and private to `answerWithCitations`; reaching it
directly would return raw model citations that never pass through re-resolution.

### Fail-closed guarantees

Schema validity is not trust — a hand-edited manifest can still be well-formed. Every one of these is
enforced at query time, not only by the CLI:

| Drift | Result |
| --- | --- |
| PDF replaced or edited | `source_hash_mismatch` / `page_text_mismatch` |
| Manifest points at a different, absolute, or escaping path | `source_hash_mismatch` / `invalid_source_path` |
| Excerpt no longer in the source | `excerpt_not_in_source` |
| Manifest missing or source unreadable | `manifest_missing` / `source_unreadable` |
| A page render drifts from the manifest | `page_image_mismatch` |
| A rect is out of bounds, degenerate, or whole-page | `invalid_rectangle` / `whole_page_rectangle` |
| Model invents a citation id | marker stripped, id recorded as rejected by the validator |
| Model cites a real passage it was never shown | marker stripped |
| Model emits its own `[1]`-style marker | marker stripped |

At the public boundary these become one of `invalid_question`, `unresolved_followup`,
`payload_too_large`, `manifest_unavailable`, `retrieval_failed`, or `model_failed` — never a stack
trace or partial answer.

## Usage

```bash
pnpm install
cp .env.example .env          # optional; the local gateway needs no key

pnpm citations:build          # derive the manifest from documents/sample.pdf
pnpm citations:verify         # re-check the manifest against the PDF
pnpm test                     # citation contract + anti-fabrication tests
pnpm dev                      # web UI at http://localhost:4111/ask
```

### Ways to ask

| Surface | Command |
| --- | --- |
| Web UI | `pnpm dev` → <http://localhost:4111/ask> |
| Interactive CLI | `pnpm ask` |
| One-shot CLI | `pnpm ask "your question"` |

Each citation renders as a clipped, highlighted crop of the actual PDF page. Page images are rendered
by Poppler at 144 DPI and hash-bound to the source like every other artifact, and `GET /ask/page/:page`
serves them only after `trustedManifest()` has confirmed the render matches its recorded hash.

`POST /ask/answer` takes `{ "question": "…", "history": […] }` and returns
`{ answer, citations, pages, unsupported, version }`, or `{ code }` with 400 (`invalid_question`),
413 (`payload_too_large`), 422 (`unresolved_followup`), 502 (`model_failed`), or 503
(`manifest_unavailable`, `retrieval_failed`). Internals never cross that boundary.

Paths resolve from the project root, located by walking up from the working directory — `mastra build`
relocates modules into `.mastra/output` and the dev server chdirs into `src/mastra/public`, so neither
`import.meta.url` nor `process.cwd()` is reliable on its own. Override with `PDF_CITATION_ROOT` and
`PDF_CITATION_DB`.

Index a different PDF:

```bash
pnpm citations:build path/to/document.pdf
```

Indexing first verifies the new manifest. If it fits `CONTEXT_BUDGET_CHARS`, it is published
without embeddings because answers will receive it whole. A larger manifest is embedded, its vectors
are replaced, and only then is it published. Publishing is what makes a manifest answerable, so a
failure before publication leaves the previous document answerable rather than exposing a manifest
without the vectors its retrieval path needs. Both branches and that ordering are covered by
`tests/indexing.test.ts`.

For larger manifests, vectors are keyed by citation id, so re-indexing overwrites in place instead of
duplicating. Superseded vectors are removed with `deleteFilter` on the upsert, which `@mastra/core`
documents as delete-and-insert in a single transaction — that atomicity is an upstream guarantee this
project relies on but does not itself test.

## Models

Embedding and generation both go through a local [OmniRoute](https://github.com/diegosouzapw/OmniRoute)
gateway at `http://127.0.0.1:20128/v1`, which needs no API key. Override with `OMNIROUTE_URL`,
`OMNIROUTE_API_KEY`, and `OMNIROUTE_ANSWER_MODEL`.

| Use | Model | Why |
| --- | --- | --- |
| Embedding | `voyage/voyage-4-lite` (1024-dim), pinned | Every stored and query vector must share one embedding space |
| Generation | `codex/gpt-5.6-luna-low`, pinned | Citations are re-resolved regardless of model, so this is free to change |

**Never point embeddings at an `auto/*` combo route.** A silent fallback to a different embedding
model returns plausible similarity scores over incomparable vectors instead of failing. `gateway.ts`
asserts the returned dimension on every call as a backstop, and changing the embedding model requires
a full reindex.

The gateway is called over plain HTTP rather than through an AI SDK provider. Its OpenAI compatibility
is close but not exact — its embeddings endpoint rejects the `encoding_format: "float"` the AI SDK
always sends and accepts only `"base64"` (this client omits the field entirely), `stream` defaults to
true when omitted, and the full `provider/model` id must survive to the wire — so the provider
abstraction cost more than it carried.

`pnpm test` is fully offline: the answer and index boundaries are tested through injected seams, so
failure ordering and citation integrity are covered without a network. `pnpm ask` exercises the
live path against the gateway.
