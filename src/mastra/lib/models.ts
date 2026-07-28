/** OmniRoute is an OpenAI-compatible gateway; nothing here assumes a specific upstream provider. */
export const GATEWAY_URL = process.env.OMNIROUTE_URL ?? 'http://127.0.0.1:20128/v1';

/** Empty by default: the local gateway accepts unauthenticated calls and 401s on a wrong key. */
export const GATEWAY_API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

/**
 * Pinned deliberately, and never an `auto/*` combo route. Every stored vector and every query
 * vector must come from the same embedding space, so a fallback to a different embedding model
 * would return plausible similarity scores over incomparable vectors instead of failing loudly.
 * Changing this requires a full reindex.
 */
export const EMBEDDING_MODEL_ID = 'voyage/voyage-4-lite';
export const EMBEDDING_DIMENSION = 1024;

/**
 * Pinned to one model rather than an `auto/*` combo route. Safe to change or fall back if desired:
 * citations are re-resolved against the manifest regardless of which model answers.
 */
export const ANSWER_MODEL_ID = process.env.OMNIROUTE_ANSWER_MODEL ?? 'codex/gpt-5.6-luna-low';
